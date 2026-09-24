import { supabaseAdmin } from '../lib/supabase.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { oauthClient } from '../lib/google.js';
import { isGoogleAuthFailure } from '../lib/tokens.js';

/**
 * Keep every connected Google account connected.
 *
 * A connection only ever ends by someone pressing Disconnect: nothing here,
 * or anywhere else in the API, sets an integration to `disconnected`. What
 * this does is make sure the grant behind each connection is still alive:
 *
 *  - It refreshes every account's access token on a schedule, so a grant is
 *    never left idle long enough for Google to expire it, and a person who
 *    has not been read for a while is still ready the moment they are.
 *  - A failure that is only the network or Google having a bad minute is
 *    retried, and never reported as needing a reconnect.
 *  - A failure Google says is final (`invalid_grant`: access revoked, the
 *    Google password changed, the grant reset) cannot be repaired by any
 *    token: Google requires the account's owner to approve access again.
 *    It is recorded, so the Team screen can say who needs to reconnect,
 *    and the connection itself is left as it was.
 */

export const GOOGLE_HEALTH_ACTION = 'google.health';

export interface GoogleHealth {
  ok: boolean;
  /** Why it failed, in Google's words. */
  reason?: string;
}

interface IntegrationRow {
  org_id: string;
  user_id: string;
  encrypted_tokens: string | null;
}

const RETRY_DELAYS_MS = [1_000, 4_000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One account: refresh, retrying anything that is not Google saying no. */
async function refreshOne(row: IntegrationRow): Promise<GoogleHealth> {
  let tokens: Record<string, unknown>;
  try {
    tokens = JSON.parse(decrypt(row.encrypted_tokens ?? ''));
  } catch {
    return { ok: false, reason: 'stored token unreadable (encryption key changed?)' };
  }
  const refreshToken = typeof tokens.refresh_token === 'string' ? tokens.refresh_token : '';
  if (!refreshToken) return { ok: false, reason: 'no refresh token stored' };

  for (let attempt = 0; ; attempt++) {
    try {
      const client = oauthClient();
      // Only the refresh token, so the client has to ask Google for a new
      // access token rather than trusting a cached one.
      client.setCredentials({ refresh_token: refreshToken });
      await client.getAccessToken();

      // Google may, rarely, rotate the refresh token; whatever it sent is
      // kept, and the old refresh token is kept when it sent none.
      const merged = { ...tokens, ...client.credentials, refresh_token: client.credentials.refresh_token || refreshToken };
      await supabaseAdmin!
        .from('integrations')
        .update({ encrypted_tokens: encrypt(JSON.stringify(merged)) })
        .eq('user_id', row.user_id)
        .eq('provider', 'google');
      return { ok: true };
    } catch (err) {
      if (isGoogleAuthFailure(err)) {
        const e = err as { message?: string; response?: { data?: { error?: string; error_description?: string } } };
        const d = e.response?.data;
        return { ok: false, reason: [d?.error, d?.error_description].filter(Boolean).join(': ') || e.message || 'invalid_grant' };
      }
      if (attempt >= RETRY_DELAYS_MS.length) {
        // Still only transient as far as anyone knows: not a reconnect.
        throw err;
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

/** The last recorded health per user, newest first. */
export async function latestGoogleHealth(userIds: string[]): Promise<Map<string, GoogleHealth & { at: string }>> {
  const out = new Map<string, GoogleHealth & { at: string }>();
  if (!supabaseAdmin || !userIds.length) return out;
  const { data } = await supabaseAdmin
    .from('activity_log')
    .select('entity_id, meta, created_at')
    .eq('action', GOOGLE_HEALTH_ACTION)
    .in('entity_id', userIds)
    .order('created_at', { ascending: false })
    .limit(500);
  for (const row of (data ?? []) as { entity_id: string; meta: GoogleHealth | null; created_at: string }[]) {
    if (!out.has(row.entity_id) && row.meta) out.set(row.entity_id, { ...row.meta, at: row.created_at });
  }
  return out;
}

/**
 * Written only when an account's health CHANGES, so a year of healthy
 * refreshes is not a year of audit rows — and the latest row is always the
 * current state.
 */
async function recordIfChanged(row: IntegrationRow, health: GoogleHealth, previous?: GoogleHealth): Promise<void> {
  if (previous && previous.ok === health.ok && previous.reason === health.reason) return;
  if (!previous && health.ok) return; // healthy from the start: nothing to say
  await supabaseAdmin!.from('activity_log').insert({
    org_id: row.org_id,
    actor: null,
    action: GOOGLE_HEALTH_ACTION,
    entity: 'integrations',
    entity_id: row.user_id,
    meta: health,
  });
}

export async function keepGoogleAlive(): Promise<{ checked: number; healthy: number; needReconnect: number; transient: number }> {
  const result = { checked: 0, healthy: 0, needReconnect: 0, transient: 0 };
  if (!supabaseAdmin) return result;

  const { data } = await supabaseAdmin
    .from('integrations')
    .select('org_id, user_id, encrypted_tokens')
    .eq('provider', 'google')
    .eq('status', 'connected');
  const rows = (data ?? []) as IntegrationRow[];
  const previous = await latestGoogleHealth(rows.map((r) => r.user_id));

  for (const row of rows) {
    result.checked++;
    try {
      const health = await refreshOne(row);
      if (health.ok) result.healthy++;
      else result.needReconnect++;
      await recordIfChanged(row, health, previous.get(row.user_id));
      if (!health.ok) console.warn(`[google] ${row.user_id} needs to reconnect: ${health.reason}`);
    } catch (err) {
      result.transient++;
      console.warn(`[google] ${row.user_id} refresh failed for now, will retry next run:`, (err as Error).message);
    }
  }
  return result;
}
