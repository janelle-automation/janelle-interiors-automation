import {
  CLOUDFLARE_IMAGE_MODELS,
  DEFAULT_CLOUDFLARE_MODEL,
  DEFAULT_CLOUDFLARE_STEPS,
  DEFAULT_PICTURE_ENGINE,
  PICTURE_ENGINES,
  DEFAULT_GROK_IMAGE_MODEL,
  DEFAULT_OPENAI_IMAGE_MODEL,
  DEFAULT_OPENAI_QUALITY,
  OPENAI_IMAGE_MODELS,
  OPENAI_QUALITIES,
  type OpenAiQuality,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MODEL,
  DEFAULT_VIDEO_MODEL,
  GROK_IMAGE_MODELS,
  IMAGE_MODELS,
  SELECTABLE_MODELS,
  VIDEO_MODELS,
  type AiSettingsView,
} from '@janelle/shared';
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

// OpenAI: a fourth key, one image model and a quality dial (quality is what
// moves the price most, so it is the studio's to choose).
const OPENAI_KEY_FIELD = 'openai_api_key_encrypted';
const OPENAI_MODEL_FIELD = 'openai_image_model';
const OPENAI_QUALITY_FIELD = 'openai_image_quality';

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

const PICTURE_ENGINE_FIELD = 'picture_engine';

/** Who makes the picture on a board: `openai`, or a Claude model id. */
export async function resolvePictureEngine(given?: string | null): Promise<string> {
  const orgId = await resolveOrgId(given);
  if (!orgId) return DEFAULT_PICTURE_ENGINE;
  try {
    const engine = (await readSettings(orgId))[PICTURE_ENGINE_FIELD];
    return typeof engine === 'string' && PICTURE_ENGINES.some((e) => e.id === engine) ? engine : DEFAULT_PICTURE_ENGINE;
  } catch {
    return DEFAULT_PICTURE_ENGINE;
  }
}

export async function savePictureEngine(orgId: string, engine: string): Promise<void> {
  if (!supabaseAdmin) throw new Error('Backend not configured');
  if (!PICTURE_ENGINES.some((e) => e.id === engine)) throw new Error('Unknown engine');
  const settings = await readSettings(orgId);
  const { error } = await supabaseAdmin
    .from('organizations')
    .update({ settings: { ...settings, [PICTURE_ENGINE_FIELD]: engine } })
    .eq('id', orgId);
  if (error) throw new Error(error.message);
}

// ── Providers the studio no longer uses ────────────────────
//
// Gemini (boards and renderings), Grok (renderings and video) and Cloudflare
// (free photos) were removed from Settings: their keys can no longer be saved
// or read from the server's environment, and nothing here looks at what an
// older install still has stored. The code that calls these resolvers is
// still in the tree and treats "no key" as "this provider is not set up", so
// it goes quiet instead of failing. Migration 0030 deletes the stored keys.

export async function resolveImageAi(_given?: string | null): Promise<ResolvedAi> {
  return { apiKey: null, model: DEFAULT_IMAGE_MODEL, source: 'none' };
}

export interface ResolvedXai {
  apiKey: string | null;
  imageModel: string;
  videoModel: string;
  source: 'studio' | 'environment' | 'none';
}

export async function resolveXai(_given?: string | null): Promise<ResolvedXai> {
  return { apiKey: null, imageModel: DEFAULT_GROK_IMAGE_MODEL, videoModel: DEFAULT_VIDEO_MODEL, source: 'none' };
}

export interface ResolvedCloudflare {
  accountId: string | null;
  apiToken: string | null;
  model: string;
  steps: number;
  source: 'studio' | 'environment' | 'none';
}

export async function resolveCloudflare(_given?: string | null): Promise<ResolvedCloudflare> {
  return { accountId: null, apiToken: null, model: DEFAULT_CLOUDFLARE_MODEL, steps: DEFAULT_CLOUDFLARE_STEPS, source: 'none' };
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


// ── OpenAI (GPT Image) ─────────────────────────────────────────

export interface ResolvedOpenAi {
  apiKey: string | null;
  imageModel: string;
  quality: OpenAiQuality;
  source: 'studio' | 'environment' | 'none';
}

export interface OpenAiSettingsView {
  configured: boolean;
  source: ResolvedOpenAi['source'];
  keyHint: string | null;
  imageModel: string;
  quality: OpenAiQuality;
}

const openAiCache = new Map<string, { at: number; value: ResolvedOpenAi }>();

export function invalidateOpenAiSettings(orgId?: string | null): void {
  if (orgId) openAiCache.delete(orgId);
  else openAiCache.clear();
}

function openAiFromEnvironment(): ResolvedOpenAi {
  const model = env.openai.imageModel;
  return {
    apiKey: env.openai.apiKey || null,
    imageModel: OPENAI_IMAGE_MODELS.some((m) => m.id === model) ? model : DEFAULT_OPENAI_IMAGE_MODEL,
    quality: DEFAULT_OPENAI_QUALITY,
    source: env.openai.apiKey ? 'environment' : 'none',
  };
}

/** The OpenAI key and model this org should use: its own if set in Settings, else the server's. */
export async function resolveOpenAi(given?: string | null): Promise<ResolvedOpenAi> {
  if (!supabaseAdmin) return openAiFromEnvironment();

  const orgId = await resolveOrgId(given);
  if (!orgId) return openAiFromEnvironment();

  const hit = openAiCache.get(orgId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let value = openAiFromEnvironment();
  try {
    const settings = await readSettings(orgId);

    const stored = settings[OPENAI_KEY_FIELD];
    if (typeof stored === 'string' && stored) {
      try {
        const apiKey = decrypt(stored);
        if (apiKey) value = { ...value, apiKey, source: 'studio' };
      } catch {
        console.error('[openai] stored API key could not be decrypted — using the environment key');
      }
    }
    const model = settings[OPENAI_MODEL_FIELD];
    if (typeof model === 'string' && OPENAI_IMAGE_MODELS.some((m) => m.id === model)) {
      value = { ...value, imageModel: model };
    }
    const quality = settings[OPENAI_QUALITY_FIELD];
    if (typeof quality === 'string' && OPENAI_QUALITIES.some((q) => q.id === quality)) {
      value = { ...value, quality: quality as OpenAiQuality };
    }
  } catch (err) {
    console.error('[openai] settings unreadable, using the environment:', (err as Error).message);
    return openAiFromEnvironment();
  }

  openAiCache.set(orgId, { at: Date.now(), value });
  return value;
}

export async function saveOpenAiApiKey(orgId: string, apiKey: string): Promise<void> {
  if (!supabaseAdmin) throw new Error('Backend not configured');
  const settings = await readSettings(orgId);
  const { error } = await supabaseAdmin
    .from('organizations')
    .update({ settings: { ...settings, [OPENAI_KEY_FIELD]: encrypt(apiKey.trim()) } })
    .eq('id', orgId);
  if (error) throw new Error(error.message);
  invalidateOpenAiSettings(orgId);
}

export async function clearOpenAiApiKey(orgId: string): Promise<void> {
  if (!supabaseAdmin) throw new Error('Backend not configured');
  const settings = await readSettings(orgId);
  delete settings[OPENAI_KEY_FIELD];
  const { error } = await supabaseAdmin.from('organizations').update({ settings }).eq('id', orgId);
  if (error) throw new Error(error.message);
  invalidateOpenAiSettings(orgId);
}

export async function saveOpenAiModel(orgId: string, model?: string, quality?: string): Promise<void> {
  if (!supabaseAdmin) throw new Error('Backend not configured');
  const next: Record<string, unknown> = { ...(await readSettings(orgId)) };
  if (model !== undefined) {
    if (!OPENAI_IMAGE_MODELS.some((m) => m.id === model)) throw new Error('Unknown model');
    next[OPENAI_MODEL_FIELD] = model;
  }
  if (quality !== undefined) {
    if (!OPENAI_QUALITIES.some((q) => q.id === quality)) throw new Error('Unknown quality');
    next[OPENAI_QUALITY_FIELD] = quality;
  }
  const { error } = await supabaseAdmin.from('organizations').update({ settings: next }).eq('id', orgId);
  if (error) throw new Error(error.message);
  invalidateOpenAiSettings(orgId);
}

/** What the settings screen may see. Never the key itself. */
export async function openAiSettingsView(orgId: string): Promise<OpenAiSettingsView> {
  const r = await resolveOpenAi(orgId);
  return {
    configured: Boolean(r.apiKey),
    source: r.source,
    keyHint: r.apiKey ? r.apiKey.slice(-4) : null,
    imageModel: r.imageModel,
    quality: r.quality,
  };
}

/** Basic shape check — OpenAI keys begin sk- (sk-proj- for project keys). */
export function looksLikeOpenAiKey(key: string): boolean {
  return /^sk-[A-Za-z0-9_-]{20,}$/.test(key.trim());
}
