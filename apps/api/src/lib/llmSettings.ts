import { LLM_MODEL_PRESETS, SWITCHABLE_FEATURES, type AiFeature, type AiRoutingView, type LlmProvider, type LlmRoute } from '@janelle/shared';
import { decrypt, encrypt } from './crypto.js';
import { resolveOrgId } from './org.js';
import { supabaseAdmin } from './supabase.js';
import { resolveOpenAi } from './aiSettings.js';

/**
 * Which AI does each action — and the Gemini key that lets one of them be Gemini.
 *
 * Two keys in `organizations.settings`:
 *
 *   llm_routing                       { [feature]: { provider, model, prices } }
 *   gemini_text_api_key_encrypted     Gemini's key, AES-256-GCM like every other
 *
 * An action with no entry runs on Claude exactly as it always has, so
 * switching nothing changes nothing. OpenAI needs no new key: the one already
 * saved for pictures is the same account. Claude's key and model stay where
 * they are (Settings → Jenny's brain).
 */

const ROUTING_FIELD = 'llm_routing';
const GEMINI_KEY_FIELD = 'gemini_text_api_key_encrypted';
const TTL_MS = 30_000;

type RoutingMap = Partial<Record<AiFeature, LlmRoute>>;

const cache = new Map<string, { at: number; value: RoutingMap }>();

export function invalidateRouting(orgId?: string | null): void {
  if (orgId) cache.delete(orgId);
  else cache.clear();
}

async function readSettings(orgId: string): Promise<Record<string, unknown>> {
  if (!supabaseAdmin) return {};
  const { data, error } = await supabaseAdmin.from('organizations').select('settings').eq('id', orgId).maybeSingle();
  if (error) throw new Error(error.message);
  return ((data as { settings: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>;
}

async function mergeSettings(orgId: string, patch: Record<string, unknown>): Promise<void> {
  if (!supabaseAdmin) throw new Error('Backend not configured');
  const { error } = await supabaseAdmin.rpc('merge_org_settings', { p_org_id: orgId, p_patch: patch });
  if (error) throw new Error(error.message);
}

const isProvider = (p: unknown): p is Exclude<LlmProvider, 'anthropic'> => p === 'openai' || p === 'gemini';

/** Only well-formed, non-Claude entries survive: anything else means "the default". */
function cleanMap(raw: unknown): RoutingMap {
  const out: RoutingMap = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const f of SWITCHABLE_FEATURES) {
    const r = (raw as Record<string, Partial<LlmRoute>>)[f.id];
    if (!r || !isProvider(r.provider) || typeof r.model !== 'string' || !r.model.trim()) continue;
    const route: LlmRoute = { provider: r.provider, model: r.model.trim() };
    if (Number.isFinite(r.inputPer1M)) route.inputPer1M = Number(r.inputPer1M);
    if (Number.isFinite(r.outputPer1M)) route.outputPer1M = Number(r.outputPer1M);
    out[f.id] = route;
  }
  return out;
}

async function routingFor(orgId: string): Promise<RoutingMap> {
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value: RoutingMap = {};
  try {
    value = cleanMap((await readSettings(orgId))[ROUTING_FIELD]);
  } catch (err) {
    // Unreadable settings must not stop the studio reading its mail: fall back to Claude.
    console.error('[llm] routing unreadable, using Claude:', (err as Error).message);
    return {};
  }
  cache.set(orgId, { at: Date.now(), value });
  return value;
}

/** The route for an action, or null for "Claude, as before". */
export async function resolveRoute(feature: AiFeature, given?: string | null): Promise<LlmRoute | null> {
  const orgId = await resolveOrgId(given);
  if (!orgId) return null;
  return (await routingFor(orgId))[feature] ?? null;
}

/** The studio's key for a provider, or null when it has not been set. */
export async function keyFor(provider: Exclude<LlmProvider, 'anthropic'>, given?: string | null): Promise<string | null> {
  const orgId = await resolveOrgId(given);
  if (!orgId) return null;
  if (provider === 'openai') return (await resolveOpenAi(orgId)).apiKey;
  try {
    const stored = (await readSettings(orgId))[GEMINI_KEY_FIELD];
    return typeof stored === 'string' && stored ? decrypt(stored) : null;
  } catch {
    console.error('[llm] stored Gemini key could not be read');
    return null;
  }
}

export async function saveGeminiKey(orgId: string, key: string): Promise<void> {
  await mergeSettings(orgId, { [GEMINI_KEY_FIELD]: encrypt(key.trim()) });
}

export async function clearGeminiKey(orgId: string): Promise<void> {
  if (!supabaseAdmin) throw new Error('Backend not configured');
  const settings = await readSettings(orgId);
  delete settings[GEMINI_KEY_FIELD];
  // Actions that were set to Gemini would fail on every call; send them back to Claude.
  const map = cleanMap(settings[ROUTING_FIELD]);
  for (const [f, r] of Object.entries(map)) if (r?.provider === 'gemini') delete map[f as AiFeature];
  settings[ROUTING_FIELD] = map;
  const { error } = await supabaseAdmin.from('organizations').update({ settings }).eq('id', orgId);
  if (error) throw new Error(error.message);
  invalidateRouting(orgId);
}

/** Basic shape check — Google API keys begin AIza. */
export function looksLikeGeminiKey(key: string): boolean {
  return /^AIza[A-Za-z0-9_-]{30,}$/.test(key.trim());
}

/** Set one action's AI, or null to return it to Claude. */
export async function saveRoute(orgId: string, feature: AiFeature, route: LlmRoute | null): Promise<void> {
  if (!SWITCHABLE_FEATURES.some((f) => f.id === feature)) throw new Error('That action cannot be switched');
  const map = cleanMap((await readSettings(orgId))[ROUTING_FIELD]);
  if (!route || route.provider === ('anthropic' as LlmProvider)) delete map[feature];
  else {
    if (!isProvider(route.provider)) throw new Error('Unknown provider');
    if (!route.model?.trim()) throw new Error('Choose a model');
    if (!(await keyFor(route.provider, orgId))) {
      throw new Error(`Add the ${route.provider === 'openai' ? 'OpenAI' : 'Gemini'} key first.`);
    }
    const known = LLM_MODEL_PRESETS.some((p) => p.provider === route.provider && p.id === route.model);
    const priced = Number.isFinite(route.inputPer1M) && Number.isFinite(route.outputPer1M);
    if (!known && !priced) throw new Error('For a model that is not in the list, enter its price per million tokens so the usage report can cost it.');
    map[feature] = {
      provider: route.provider,
      model: route.model.trim(),
      ...(priced ? { inputPer1M: Number(route.inputPer1M), outputPer1M: Number(route.outputPer1M) } : {}),
    };
  }
  await mergeSettings(orgId, { [ROUTING_FIELD]: map });
  invalidateRouting(orgId);
}

export async function routingView(orgId: string): Promise<AiRoutingView> {
  const map = await routingFor(orgId);
  const [openai, gemini] = await Promise.all([keyFor('openai', orgId), keyFor('gemini', orgId)]);
  return {
    features: SWITCHABLE_FEATURES.map((f) => ({ ...f, route: map[f.id] ?? null })),
    providers: [
      { id: 'anthropic', label: 'Claude', configured: true, keyHint: null },
      { id: 'openai', label: 'OpenAI', configured: Boolean(openai), keyHint: openai ? openai.slice(-4) : null },
      { id: 'gemini', label: 'Gemini', configured: Boolean(gemini), keyHint: gemini ? gemini.slice(-4) : null },
    ],
    presets: LLM_MODEL_PRESETS,
  };
}
