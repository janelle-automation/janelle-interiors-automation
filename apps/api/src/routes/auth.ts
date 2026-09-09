import crypto from 'node:crypto';
import { Router } from 'express';
import { env, isGoogleConfigured } from '../env.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { consentUrl, oauthClient, servicesGranted, scopesFor, type GoogleService } from '../lib/google.js';
import { decrypt } from '../lib/crypto.js';
import { encrypt } from '../lib/crypto.js';
import { supabaseAdmin } from '../lib/supabase.js';

export const authRouter = Router();

/**
 * Simple signed state: "<userId>.<hmac>" so the OAuth callback can
 * trust which user began the flow without a session store.
 */
function sign(payload: string): string {
  return crypto
    .createHmac('sha256', env.tokenEncryptionKey || 'dev')
    .update(payload)
    .digest('hex')
    .slice(0, 32);
}

function signState(userId: string, service: string): string {
  return `${userId}.${service}.${sign(`${userId}.${service}`)}`;
}

function verifyState(state: string): { userId: string; service: string } | null {
  const [userId, service, mac] = state.split('.');
  if (!userId || !service || !mac) return null;
  return sign(`${userId}.${service}`) === mac ? { userId, service } : null;
}

function parseService(raw: unknown): GoogleService | 'all' {
  return raw === 'gmail' || raw === 'drive' ? raw : 'all';
}

// Step 1 — the web app asks for the consent URL (must be signed in).
// `?service=gmail|drive` limits the request to that service; omit for both.
authRouter.get(
  '/google/url',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!isGoogleConfigured()) {
      return res.status(503).json({ error: 'Google integration is not configured on the server' });
    }
    const service = parseService(req.query.service);
    const url = consentUrl(signState(req.auth!.userId, service), service);
    res.json({ data: { url } });
  }),
);

// Step 2 — Google redirects here with an authorization code.
authRouter.get(
  '/google/callback',
  asyncHandler(async (req, res) => {
    const code = String(req.query.code ?? '');
    const state = verifyState(String(req.query.state ?? ''));
    const webApp = env.corsOrigins[0] ?? 'http://localhost:5173';
    const service = state?.service ?? 'all';

    if (!code || !state || !supabaseAdmin) {
      return res.redirect(`${webApp}/settings?google=error&service=${service}`);
    }
    const { userId } = state;

    const client = oauthClient();
    const { tokens } = await client.getToken(code);

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('org_id')
      .eq('id', userId)
      .maybeSingle();

    if (!profile?.org_id) {
      return res.redirect(`${webApp}/settings?google=error&service=${service}`);
    }

    // Incremental auth: the new token covers previously granted scopes too,
    // so merge Google's reported scope set with what we already stored.
    const { data: existing } = await supabaseAdmin
      .from('integrations')
      .select('scopes, encrypted_tokens')
      .eq('user_id', userId)
      .eq('provider', 'google')
      .maybeSingle();
    const granted = new Set<string>([
      ...(existing?.scopes ?? '').split(/\s+/).filter(Boolean),
      ...String(tokens.scope ?? scopesFor(parseService(service)).join(' ')).split(/\s+/).filter(Boolean),
    ]);

    // Keep an earlier refresh token if Google did not issue a new one.
    let merged: Record<string, unknown> = { ...tokens };
    if (!tokens.refresh_token && existing?.encrypted_tokens) {
      try {
        const prev = JSON.parse(decrypt(existing.encrypted_tokens)) as Record<string, unknown>;
        if (prev.refresh_token) merged = { ...prev, ...tokens };
      } catch {
        /* fall through with fresh tokens only */
      }
    }

    await supabaseAdmin.from('integrations').upsert(
      {
        org_id: profile.org_id,
        user_id: userId,
        provider: 'google',
        encrypted_tokens: encrypt(JSON.stringify(merged)),
        scopes: [...granted].join(' '),
        status: 'connected',
        connected_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,provider' },
    );

    await supabaseAdmin.from('activity_log').insert({
      org_id: profile.org_id,
      actor: userId,
      action: 'google.connect',
      entity: 'integrations',
      entity_id: userId,
      meta: { service, ...servicesGranted([...granted].join(' ')) },
    });

    res.redirect(`${webApp}/settings?google=connected&service=${service}`);
  }),
);

// Disconnect Google entirely: revoke the token best-effort and mark the
// integration disconnected. Both Gmail and Drive stop working until reconnected.
authRouter.delete(
  '/google',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Backend not configured' });
    const { userId } = req.auth!;

    const { data: integration } = await supabaseAdmin
      .from('integrations')
      .select('org_id, encrypted_tokens')
      .eq('user_id', userId)
      .eq('provider', 'google')
      .maybeSingle();

    if (integration?.encrypted_tokens) {
      try {
        const tokens = JSON.parse(decrypt(integration.encrypted_tokens)) as { refresh_token?: string; access_token?: string };
        const token = tokens.refresh_token ?? tokens.access_token;
        if (token) await oauthClient().revokeToken(token);
      } catch {
        /* token may already be invalid — still disconnect locally */
      }
    }

    await supabaseAdmin
      .from('integrations')
      .update({ status: 'disconnected', encrypted_tokens: null, scopes: '' })
      .eq('user_id', userId)
      .eq('provider', 'google');

    if (integration?.org_id) {
      await supabaseAdmin.from('activity_log').insert({
        org_id: integration.org_id,
        actor: userId,
        action: 'google.disconnect',
        entity: 'integrations',
        entity_id: userId,
        meta: {},
      });
    }

    res.json({ data: { ok: true } });
  }),
);

// Bootstrap — ensure the signed-in user has an org + profile.
// First user of a fresh install becomes the principal and creates the
// organization; later users join it (as assistant) pending role change.
authRouter.post(
  '/bootstrap',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Backend not configured' });
    const { userId, email } = req.auth!;

    const { data: existing } = await supabaseAdmin
      .from('profiles')
      .select('id, org_id, role, full_name, email')
      .eq('id', userId)
      .maybeSingle();
    if (existing?.org_id) return res.json({ data: existing });

    const { data: orgs } = await supabaseAdmin.from('organizations').select('id').limit(1);
    let orgId = orgs?.[0]?.id as string | undefined;
    let role: 'principal' | 'assistant' = 'assistant';
    if (!orgId) {
      const { data: newOrg } = await supabaseAdmin
        .from('organizations')
        .insert({
          name: 'Janelle Interiors',
          settings: { vendor_silence_days: 3, client_approval_days: 5, report_day: 'monday' },
        })
        .select('id')
        .maybeSingle();
      orgId = newOrg?.id;
      role = 'principal';
    }

    const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(userId);
    const fullName =
      (authUser?.user?.user_metadata?.full_name as string) ??
      (authUser?.user?.user_metadata?.name as string) ??
      (email ? email.split('@')[0] : null);

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .upsert({ id: userId, org_id: orgId, email, full_name: fullName, role })
      .select('id, org_id, role, full_name, email')
      .maybeSingle();

    await supabaseAdmin.from('activity_log').insert({
      org_id: orgId,
      actor: userId,
      action: 'auth.bootstrap',
      entity: 'profiles',
      entity_id: userId,
      meta: { role },
    });

    res.json({ data: profile });
  }),
);

// Disconnect — remove stored tokens for the current user.
authRouter.post(
  '/google/disconnect',
  requireAuth,
  asyncHandler(async (req, res) => {
    await req.auth!.db
      .from('integrations')
      .update({ status: 'disconnected', encrypted_tokens: null, connected_at: null })
      .eq('user_id', req.auth!.userId)
      .eq('provider', 'google');
    res.json({ data: { ok: true } });
  }),
);
