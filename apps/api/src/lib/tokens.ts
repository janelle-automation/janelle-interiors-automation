import type { OAuth2Client } from 'google-auth-library';
import { supabaseAdmin } from './supabase.js';
import { decrypt, encrypt } from './crypto.js';
import { oauthClient, servicesGranted, type GoogleService } from './google.js';

/**
 * Build a Google OAuth2 client authenticated as a given user, using
 * their stored (encrypted) tokens. Returns null when the user has no
 * connected Google integration. Refreshed tokens are persisted back.
 */
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
  const { data } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('org_id', orgId)
    .eq('role', 'principal')
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}
