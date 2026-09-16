import type { OAuth2Client } from 'google-auth-library';
import { supabaseAdmin } from './supabase.js';
import { decrypt, encrypt } from './crypto.js';
import { oauthClient, servicesGranted, type GoogleService } from './google.js';

/**
 * Build a Google OAuth2 client authenticated as a given user, using
 * their stored (encrypted) tokens. Returns null when the user has no
 * connected Google integration. Refreshed tokens are persisted back.
 */
/**
 * Whether this error means the stored Google grant is no longer usable.
 *
 * Google answers a refresh with `invalid_client` when the credentials in
 * the environment are not the ones that issued the refresh token — the
 * usual cause is the OAuth client being rotated or replaced while a token
 * from the old one is still in the database. `invalid_grant` is the same
 * problem from the other end: the user revoked access, or the token
 * expired from disuse.
 *
 * Neither is retryable and neither is a bug. They need a person to
 * reconnect Google, so callers report that rather than failing as though
 * the server broke.
 */
export function isGoogleAuthFailure(err: unknown): boolean {
  const e = err as { message?: string; response?: { data?: { error?: string } } } | null;
  const code = e?.response?.data?.error ?? '';
  const message = e?.message ?? '';
  return /invalid_client|invalid_grant|unauthorized_client/i.test(`${code} ${message}`);
}

export async function googleClientForUser(userId: string, service?: GoogleService): Promise<OAuth2Client | null> {
  if (!supabaseAdmin) return null;

  const { data: integration } = await supabaseAdmin
    .from('integrations')
    .select('encrypted_tokens, status, scopes')
    .eq('user_id', userId)
    .eq('provider', 'google')
    .maybeSingle();

  if (!integration?.encrypted_tokens || integration.status !== 'connected') return null;
  if (service && !servicesGranted(integration.scopes)[service]) return null;

  let tokens: Record<string, unknown>;
  try {
    tokens = JSON.parse(decrypt(integration.encrypted_tokens));
  } catch {
    return null;
  }

  const client = oauthClient();
  client.setCredentials(tokens);

  // Persist refreshed tokens so the refresh token is not lost.
  client.on('tokens', async (fresh) => {
    const merged = { ...tokens, ...fresh };
    if (!supabaseAdmin) return;
    await supabaseAdmin
      .from('integrations')
      .update({ encrypted_tokens: encrypt(JSON.stringify(merged)) })
      .eq('user_id', userId)
      .eq('provider', 'google');
  });

  return client;
}

/**
 * The user whose Google account acts as the org's ingestion source.
 * For now this is the principal; later this can be configurable.
 */
export async function orgSourceUserId(orgId: string): Promise<string | null> {
  if (!supabaseAdmin) return null;
  // The principal who actually connected Google. "Any principal" was fine
  // with one; with a second added on Team & roles, whichever the database
  // returned first became the source — often the one with no Google
  // connection, and reading stopped.
  const { data: connected } = await supabaseAdmin
    .from('integrations')
    .select('user_id, profiles!inner(role, org_id)')
    .eq('org_id', orgId)
    .eq('provider', 'google')
    .eq('status', 'connected')
    .eq('profiles.role', 'principal')
    .order('connected_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  const source = (connected as { user_id?: string } | null)?.user_id;
  if (source) return source;

  const { data } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('org_id', orgId)
    .eq('role', 'principal')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}
