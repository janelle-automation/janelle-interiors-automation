import { DEFAULT_MODEL, SELECTABLE_MODELS, type AiSettingsView } from '@janelle/shared';
import { env } from '../env.js';
import { decrypt, encrypt } from './crypto.js';
import { resolveOrgId } from './org.js';
import { supabaseAdmin } from './supabase.js';

/**
 * The studio's Claude credentials, set from Settings rather than from a
 * deploy.
 *
 * The key is ENCRYPTED at rest with the same AES-256-GCM helper that
 * protects Google tokens, because `organizations.settings` is readable by
 * any signed-in member of the org — storing it in the clear would hand the
 * studio's API key to everyone with a login. It is never sent to the
 * browser either: the settings screen gets the last four characters and
 * nothing more.
 *
 * An environment key (ANTHROPIC_API_KEY) still works and takes over when
 * the studio has not set one, so existing deployments keep running.
 */

const KEY_FIELD = 'anthropic_api_key_encrypted';
const MODEL_FIELD = 'anthropic_model';

export interface ResolvedAi {
  apiKey: string | null;
  model: string;
  source: 'studio' | 'environment' | 'none';
}

/**
 * Read on every Claude call, so it is cached briefly. Cleared the moment
 * the key or model changes, so a new key takes effect immediately rather
 * than after a timeout.
 */
const TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: ResolvedAi }>();

export function invalidateAiSettings(orgId?: string | null): void {
  if (orgId) cache.delete(orgId);
  else cache.clear();
}

async function readSettings(orgId: string): Promise<Record<string, unknown>> {
  if (!supabaseAdmin) return {};
  const { data, error } = await supabaseAdmin
    .from('organizations')
    .select('settings')
    .eq('id', orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return ((data as { settings: Record<string, unknown> } | null)?.settings ?? {}) as Record<
    string,
    unknown
  >;
}

function fromEnvironment(): ResolvedAi {
  return {
    apiKey: env.anthropic.apiKey || null,
    model: env.anthropic.model || DEFAULT_MODEL,
    source: env.anthropic.apiKey ? 'environment' : 'none',
  };
}

/** The key and model this org should actually use. */
export async function resolveAi(given?: string | null): Promise<ResolvedAi> {
  if (!supabaseAdmin) return fromEnvironment();

  // A scheduled job has no session, but it is still this studio's key.
  const orgId = await resolveOrgId(given);
  if (!orgId) return fromEnvironment();

  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let value = fromEnvironment();
  try {
    const settings = await readSettings(orgId);

    const stored = settings[KEY_FIELD];
    if (typeof stored === 'string' && stored) {
      try {
        const apiKey = decrypt(stored);
        if (apiKey) value = { ...value, apiKey, source: 'studio' };
      } catch {
        // A key encrypted under a different TOKEN_ENCRYPTION_KEY cannot be
        // read back. Fall through to the environment rather than failing
        // every Claude call in the studio.
        console.error('[ai] stored API key could not be decrypted — using the environment key');
      }
    }

    const model = settings[MODEL_FIELD];
    if (typeof model === 'string' && SELECTABLE_MODELS.some((m) => m.id === model)) {
      value = { ...value, model };
    }
  } catch (err) {
    console.error('[ai] settings unreadable, using the environment:', (err as Error).message);
    return fromEnvironment();
  }

  cache.set(orgId, { at: Date.now(), value });
  return value;
}

/** What the settings screen may see. Never includes the key. */
export async function aiSettingsView(orgId: string): Promise<AiSettingsView> {
  const settings = await readSettings(orgId).catch(() => ({}) as Record<string, unknown>);
  const resolved = await resolveAi(orgId);

  return {
    configured: Boolean(resolved.apiKey),
    source: resolved.source,
    keyHint: resolved.apiKey ? resolved.apiKey.slice(-4) : null,
    model: resolved.model,
    modelIsDefault: typeof settings[MODEL_FIELD] !== 'string',
  };
}

/** Basic shape check — a typo should fail here, not on the first email. */
export function looksLikeAnthropicKey(key: string): boolean {
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key.trim());
}

export async function saveApiKey(orgId: string, apiKey: string): Promise<void> {
  if (!supabaseAdmin) throw new Error('Backend not configured');
  const settings = await readSettings(orgId);
  const { error } = await supabaseAdmin
    .from('organizations')
    .update({ settings: { ...settings, [KEY_FIELD]: encrypt(apiKey.trim()) } })
    .eq('id', orgId);
  if (error) throw new Error(error.message);
  invalidateAiSettings(orgId);
}

export async function clearApiKey(orgId: string): Promise<void> {
  if (!supabaseAdmin) throw new Error('Backend not configured');
  const settings = await readSettings(orgId);
  delete settings[KEY_FIELD];
  const { error } = await supabaseAdmin
    .from('organizations')
    .update({ settings })
    .eq('id', orgId);
  if (error) throw new Error(error.message);
  invalidateAiSettings(orgId);
}

export async function saveModel(orgId: string, model: string): Promise<void> {
  if (!supabaseAdmin) throw new Error('Backend not configured');
  if (!SELECTABLE_MODELS.some((m) => m.id === model)) throw new Error('Unknown model');
  const settings = await readSettings(orgId);
  const { error } = await supabaseAdmin
    .from('organizations')
    .update({ settings: { ...settings, [MODEL_FIELD]: model } })
    .eq('id', orgId);
  if (error) throw new Error(error.message);
  invalidateAiSettings(orgId);
}
