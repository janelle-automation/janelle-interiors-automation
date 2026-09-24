import {
  CLOUDFLARE_IMAGE_MODELS,
  DEFAULT_CLOUDFLARE_MODEL,
  DEFAULT_CLOUDFLARE_STEPS,
  DEFAULT_PICTURE_ENGINE,
  PICTURE_ENGINES,
  DEFAULT_GROK_IMAGE_MODEL,
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

// Rendering boards is a second provider with a second key. Same JSON blob,
// same encryption, its own cache — so a studio can have Claude without
// renders, which is the normal state until someone pays for image credit.
const IMAGE_KEY_FIELD = 'image_api_key_encrypted';
const IMAGE_MODEL_FIELD = 'image_model';

// Grok: a third key, and two models rather than one, because a still and a
// clip are priced and chosen separately.
const XAI_KEY_FIELD = 'xai_api_key_encrypted';
const XAI_IMAGE_MODEL_FIELD = 'xai_image_model';
const XAI_VIDEO_MODEL_FIELD = 'xai_video_model';

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

const imageCache = new Map<string, { at: number; value: ResolvedAi }>();

export function invalidateImageSettings(orgId?: string | null): void {
  if (orgId) imageCache.delete(orgId);
  else imageCache.clear();
}

function imageFromEnvironment(): ResolvedAi {
  return {
    apiKey: env.images.apiKey || null,
    model: env.images.model || DEFAULT_IMAGE_MODEL,
    source: env.images.apiKey ? 'environment' : 'none',
  };
}

/** The image key and model this org should use, resolved like the Claude one. */
export async function resolveImageAi(given?: string | null): Promise<ResolvedAi> {
  if (!supabaseAdmin) return imageFromEnvironment();

  const orgId = await resolveOrgId(given);
  if (!orgId) return imageFromEnvironment();

  const hit = imageCache.get(orgId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let value = imageFromEnvironment();
  try {
    const settings = await readSettings(orgId);

    const stored = settings[IMAGE_KEY_FIELD];
    if (typeof stored === 'string' && stored) {
      try {
        const apiKey = decrypt(stored);
        if (apiKey) value = { ...value, apiKey, source: 'studio' };
      } catch {
        console.error('[images] stored API key could not be decrypted — using the environment key');
      }
    }

    const model = settings[IMAGE_MODEL_FIELD];
    if (typeof model === 'string' && IMAGE_MODELS.some((m) => m.id === model)) {
      value = { ...value, model };
    }
  } catch (err) {
    console.error('[images] settings unreadable, using the environment:', (err as Error).message);
    return imageFromEnvironment();
  }

  imageCache.set(orgId, { at: Date.now(), value });
  return value;
}

// ── Grok (xAI): renderings and video ────────────────────────

export interface ResolvedXai {
  apiKey: string | null;
  /** Two models rather than one: a still and a clip are chosen separately. */
  imageModel: string;
  videoModel: string;
  source: 'studio' | 'environment' | 'none';
}

export interface XaiSettingsView {
  configured: boolean;
  source: ResolvedXai['source'];
  keyHint: string | null;
  imageModel: string;
  videoModel: string;
}

const xaiCache = new Map<string, { at: number; value: ResolvedXai }>();

export function invalidateXaiSettings(orgId?: string | null): void {
  if (orgId) xaiCache.delete(orgId);
  else xaiCache.clear();
}

function xaiFromEnvironment(): ResolvedXai {
  return {
    apiKey: env.xai.apiKey || null,
    imageModel: env.xai.imageModel || DEFAULT_GROK_IMAGE_MODEL,
    videoModel: env.xai.videoModel || DEFAULT_VIDEO_MODEL,
    source: env.xai.apiKey ? 'environment' : 'none',
  };
}

/** The Grok key and models this org should use, resolved like the others. */
export async function resolveXai(given?: string | null): Promise<ResolvedXai> {
  if (!supabaseAdmin) return xaiFromEnvironment();

  const orgId = await resolveOrgId(given);
  if (!orgId) return xaiFromEnvironment();

  const hit = xaiCache.get(orgId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let value = xaiFromEnvironment();
  try {
    const settings = await readSettings(orgId);

    const stored = settings[XAI_KEY_FIELD];
    if (typeof stored === 'string' && stored) {
      try {
        const apiKey = decrypt(stored);
        if (apiKey) value = { ...value, apiKey, source: 'studio' };
      } catch {
        console.error('[grok] stored API key could not be decrypted — using the environment key');
      }
    }

    // An unknown id is ignored rather than passed on: a typo in the
    // settings row should not become a 404 on every render.
    const imageModel = settings[XAI_IMAGE_MODEL_FIELD];
    if (typeof imageModel === 'string' && GROK_IMAGE_MODELS.some((m) => m.id === imageModel)) {
      value = { ...value, imageModel };
    }
    const videoModel = settings[XAI_VIDEO_MODEL_FIELD];
    if (typeof videoModel === 'string' && VIDEO_MODELS.some((m) => m.id === videoModel)) {
      value = { ...value, videoModel };
    }
  } catch (err) {
    console.error('[grok] settings unreadable, using the environment:', (err as Error).message);
    return xaiFromEnvironment();
  }

  xaiCache.set(orgId, { at: Date.now(), value });
  return value;
}

export async function saveXaiApiKey(orgId: string, apiKey: string): Promise<void> {
  if (!supabaseAdmin) throw new Error('Backend not configured');
  const settings = await readSettings(orgId);
  const { error } = await supabaseAdmin
    .from('organizations')
    .update({ settings: { ...settings, [XAI_KEY_FIELD]: encrypt(apiKey.trim()) } })
    .eq('id', orgId);
  if (error) throw new Error(error.message);
  invalidateXaiSettings(orgId);
}

export async function clearXaiApiKey(orgId: string): Promise<void> {
  if (!supabaseAdmin) throw new Error('Backend not configured');
  const settings = await readSettings(orgId);
  delete settings[XAI_KEY_FIELD];
  const { error } = await supabaseAdmin.from('organizations').update({ settings }).eq('id', orgId);
  if (error) throw new Error(error.message);
  invalidateXaiSettings(orgId);
}

export async function saveXaiModel(orgId: string, kind: 'image' | 'video', model: string): Promise<void> {
  if (!supabaseAdmin) throw new Error('Backend not configured');
  const known =
    kind === 'image'
      ? GROK_IMAGE_MODELS.some((m) => m.id === model)
      : VIDEO_MODELS.some((m) => m.id === model);
  if (!known) throw new Error('Unknown model');
  const field = kind === 'image' ? XAI_IMAGE_MODEL_FIELD : XAI_VIDEO_MODEL_FIELD;
  const settings = await readSettings(orgId);
  const { error } = await supabaseAdmin
    .from('organizations')
    .update({ settings: { ...settings, [field]: model } })
    .eq('id', orgId);
  if (error) throw new Error(error.message);
  invalidateXaiSettings(orgId);
}

/** What the settings screen may see. Never the key itself. */
export async function xaiSettingsView(orgId: string): Promise<XaiSettingsView> {
  const resolved = await resolveXai(orgId);
  return {
    configured: Boolean(resolved.apiKey),
    source: resolved.source,
    keyHint: resolved.apiKey ? resolved.apiKey.slice(-4) : null,
    imageModel: resolved.imageModel,
    videoModel: resolved.videoModel,
  };
}

/** Basic shape check — a typo should fail here, not on the first render. */
export function looksLikeXaiKey(key: string): boolean {
  return /^xai-[A-Za-z0-9_-]{20,}$/.test(key.trim());
}

export async function saveImageApiKey(orgId: string, apiKey: string): Promise<void> {
  if (!supabaseAdmin) throw new Error('Backend not configured');
  const settings = await readSettings(orgId);
  const { error } = await supabaseAdmin
    .from('organizations')
    .update({ settings: { ...settings, [IMAGE_KEY_FIELD]: encrypt(apiKey.trim()) } })
    .eq('id', orgId);
  if (error) throw new Error(error.message);
  invalidateImageSettings(orgId);
}

// ── Cloudflare Workers AI: free photoreal renderings ────────
//
// Two credentials rather than one — the account the models run in, and a
// token allowed to run them — plus which model and how many steps. The
// token is encrypted like every other key; the account id is not secret
// on its own (it appears in every dashboard URL) and is kept readable so
// the settings screen can show which account is in use.

const CF_ACCOUNT_FIELD = 'cloudflare_account_id';
const CF_TOKEN_FIELD = 'cloudflare_api_token_encrypted';
const CF_MODEL_FIELD = 'cloudflare_model';
const CF_STEPS_FIELD = 'cloudflare_steps';

export interface ResolvedCloudflare {
  accountId: string | null;
  apiToken: string | null;
  model: string;
  steps: number;
  source: 'studio' | 'environment' | 'none';
}

export interface CloudflareSettingsView {
  configured: boolean;
  source: ResolvedCloudflare['source'];
  keyHint: string | null;
  accountId: string | null;
  model: string;
  steps: number;
}

function clampSteps(model: string, steps: unknown): number {
  const max = CLOUDFLARE_IMAGE_MODELS.find((m) => m.id === model)?.maxSteps ?? 8;
  const n = Math.round(Number(steps));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : Math.min(DEFAULT_CLOUDFLARE_STEPS, max);
}

export async function resolveCloudflare(given?: string | null): Promise<ResolvedCloudflare> {
  const fromEnv: ResolvedCloudflare = {
    accountId: env.cloudflare.accountId || null,
    apiToken: env.cloudflare.apiToken || null,
    model: DEFAULT_CLOUDFLARE_MODEL,
    steps: DEFAULT_CLOUDFLARE_STEPS,
    source: env.cloudflare.accountId && env.cloudflare.apiToken ? 'environment' : 'none',
  };
  const orgId = await resolveOrgId(given);
  if (!orgId || !supabaseAdmin) return fromEnv;
  try {
    const settings = await readSettings(orgId);
    let value = { ...fromEnv };
    const account = settings[CF_ACCOUNT_FIELD];
    const stored = settings[CF_TOKEN_FIELD];
    if (typeof account === 'string' && account && typeof stored === 'string' && stored) {
      try {
        value = { ...value, accountId: account, apiToken: decrypt(stored), source: 'studio' };
      } catch {
        console.error('[cloudflare] stored token could not be decrypted — using the environment');
      }
    }
    const model = settings[CF_MODEL_FIELD];
    if (typeof model === 'string' && CLOUDFLARE_IMAGE_MODELS.some((m) => m.id === model)) value.model = model;
    value.steps = clampSteps(value.model, settings[CF_STEPS_FIELD] ?? value.steps);
    return value;
  } catch (err) {
    console.error('[cloudflare] settings unreadable, using the environment:', (err as Error).message);
    return fromEnv;
  }
}

export async function cloudflareSettingsView(orgId: string): Promise<CloudflareSettingsView> {
  const r = await resolveCloudflare(orgId);
  return {
    configured: Boolean(r.accountId && r.apiToken),
    source: r.source,
    keyHint: r.apiToken ? r.apiToken.slice(-4) : null,
    accountId: r.accountId,
    model: r.model,
    steps: r.steps,
  };
}

export function looksLikeCloudflareAccount(id: string): boolean {
  return /^[0-9a-f]{32}$/i.test(id.trim());
}

export async function saveCloudflareCredentials(orgId: string, accountId: string, apiToken: string): Promise<void> {
  if (!supabaseAdmin) throw new Error('Backend not configured');
  const settings = await readSettings(orgId);
  const { error } = await supabaseAdmin
    .from('organizations')
    .update({
      settings: { ...settings, [CF_ACCOUNT_FIELD]: accountId.trim(), [CF_TOKEN_FIELD]: encrypt(apiToken.trim()) },
    })
    .eq('id', orgId);
  if (error) throw new Error(error.message);
}

export async function clearCloudflareCredentials(orgId: string): Promise<void> {
  if (!supabaseAdmin) throw new Error('Backend not configured');
  const settings = await readSettings(orgId);
  delete settings[CF_ACCOUNT_FIELD];
  delete settings[CF_TOKEN_FIELD];
  const { error } = await supabaseAdmin.from('organizations').update({ settings }).eq('id', orgId);
  if (error) throw new Error(error.message);
}

export async function saveCloudflareModel(orgId: string, model: string, steps?: number): Promise<void> {
  if (!supabaseAdmin) throw new Error('Backend not configured');
  if (!CLOUDFLARE_IMAGE_MODELS.some((m) => m.id === model)) throw new Error('Unknown model');
  const settings = await readSettings(orgId);
  const next: Record<string, unknown> = { ...settings, [CF_MODEL_FIELD]: model };
  if (steps !== undefined) next[CF_STEPS_FIELD] = clampSteps(model, steps);
  const { error } = await supabaseAdmin.from('organizations').update({ settings: next }).eq('id', orgId);
  if (error) throw new Error(error.message);
}

const PICTURE_ENGINE_FIELD = 'picture_engine';

/** Who makes the picture on a board: `gemini`, or a Claude model id. */
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

/** Basic shape check — Google API keys begin AIza. */
export function looksLikeGeminiKey(key: string): boolean {
  return /^AIza[A-Za-z0-9_-]{30,}$/.test(key.trim());
}

export async function saveImageModel(orgId: string, model: string): Promise<void> {
  if (!supabaseAdmin) throw new Error('Backend not configured');
  if (!IMAGE_MODELS.some((m) => m.id === model)) throw new Error('Unknown model');
  const settings = await readSettings(orgId);
  const { error } = await supabaseAdmin
    .from('organizations')
    .update({ settings: { ...settings, [IMAGE_MODEL_FIELD]: model } })
    .eq('id', orgId);
  if (error) throw new Error(error.message);
  invalidateImageSettings(orgId);
}

export async function clearImageApiKey(orgId: string): Promise<void> {
  if (!supabaseAdmin) throw new Error('Backend not configured');
  const settings = await readSettings(orgId);
  delete settings[IMAGE_KEY_FIELD];
  const { error } = await supabaseAdmin
    .from('organizations')
    .update({ settings })
    .eq('id', orgId);
  if (error) throw new Error(error.message);
  invalidateImageSettings(orgId);
}

/** The board renderer's state, for the settings screen. Never the key itself. */
export async function imageSettingsView(orgId: string): Promise<AiSettingsView> {
  const settings = await readSettings(orgId).catch(() => ({}) as Record<string, unknown>);
  const resolved = await resolveImageAi(orgId);

  return {
    configured: Boolean(resolved.apiKey),
    source: resolved.source,
    keyHint: resolved.apiKey ? resolved.apiKey.slice(-4) : null,
    model: resolved.model,
    modelIsDefault: typeof settings[IMAGE_MODEL_FIELD] !== 'string',
  };
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
