import { LLM_MODEL_PRESETS, type LlmProvider, type LlmRoute } from '@janelle/shared';
import { keyFor, resolveRoute } from '../lib/llmSettings.js';
import { resolveOrgId } from '../lib/org.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { AI_USAGE_ACTION, type CallContext } from './anthropic.js';

/**
 * OpenAI and Gemini, doing the text actions Claude does by default.
 *
 * Plain fetch, no SDKs: each provider is one request and one response, and a
 * serverless function is better without two more dependencies. What these
 * adapters must do is the same small job — a system prompt and a user message
 * in, text and a token count out — so every action gets the same answer shape
 * whichever company produced it.
 *
 * Every call is recorded on the usage report like a Claude call, with the
 * provider named, so a switch shows up in the spend rather than hiding in it.
 */

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens: number;
  /** Reading wants the same answer every time; writing does not care. */
  temperature?: number;
  /** Ask the provider for a JSON object, where it has a mode for it. */
  json: boolean;
  timeoutMs: number;
}

export interface LlmResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/** A provider refused, or could not be reached; the message is fit to show an admin. */
export class LlmError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = 'LlmError';
  }
}

function explain(provider: string, status: number, said: string): LlmError {
  if (status === 401 || status === 403) return new LlmError(`${provider} rejected the key — check it in Settings.`, status);
  if (status === 429) return new LlmError(`${provider} is rate-limiting the studio right now, or its credit has run out.`, status);
  if (status === 404) return new LlmError(`${provider} does not know that model — check its name in Settings.`, status);
  return new LlmError(`${provider} said: ${said.slice(0, 300) || `HTTP ${status}`}`, status);
}

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<{ status: number; json: any }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  } catch (err) {
    const name = (err as Error).name;
    throw new LlmError(name === 'TimeoutError' || name === 'AbortError' ? 'The AI took longer than the time limit.' : 'Could not reach the AI provider.');
  }
}

/**
 * Parameters a model has refused, remembered per model. Newer OpenAI models
 * reject settings older ones accept (a fixed temperature, say); asking once and
 * remembering is cheaper than a failed request on every email.
 */
const refused = new Map<string, Set<string>>();

export async function completeOpenAi(key: string, model: string, req: LlmRequest): Promise<LlmResult> {
  const skip = refused.get(model) ?? new Set<string>();
  const reasoning = /^(gpt-5|o\d)/.test(model);

  for (let attempt = 0; attempt < 4; attempt++) {
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      max_completion_tokens: req.maxTokens,
    };
    if (req.json) body.response_format = { type: 'json_object' };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    // A reasoning model spends the allowance thinking before it writes; reading
    // an email needs none of that, and without this it can use all of it.
    if (reasoning) body.reasoning_effort = 'minimal';
    for (const p of skip) delete body[p];

    const { status, json } = await post(OPENAI_URL, { Authorization: `Bearer ${key}` }, body, req.timeoutMs);
    if (status >= 200 && status < 300) {
      const text = String(json?.choices?.[0]?.message?.content ?? '').trim();
      return { text, inputTokens: Number(json?.usage?.prompt_tokens ?? 0), outputTokens: Number(json?.usage?.completion_tokens ?? 0) };
    }
    const param = json?.error?.param;
    if (status === 400 && typeof param === 'string' && param in body && param !== 'model' && param !== 'messages') {
      skip.add(param);
      refused.set(model, skip);
      continue;
    }
    throw explain('OpenAI', status, String(json?.error?.message ?? ''));
  }
  throw new LlmError('OpenAI would not accept the request.');
}

export async function completeGemini(key: string, model: string, req: LlmRequest): Promise<LlmResult> {
  const body = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [{ role: 'user', parts: [{ text: req.user }] }],
    generationConfig: {
      // Gemini's newer models think before they answer and count it against
      // this allowance, so a small one can come back with nothing written.
      maxOutputTokens: Math.max(req.maxTokens * 2, 2048),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.json ? { responseMimeType: 'application/json' } : {}),
    },
  };
  const { status, json } = await post(
    `${GEMINI_URL}/${encodeURIComponent(model)}:generateContent`,
    { 'x-goog-api-key': key },
    body,
    req.timeoutMs,
  );
  if (status < 200 || status >= 300) throw explain('Gemini', status, String(json?.error?.message ?? ''));
  const parts = (json?.candidates?.[0]?.content?.parts ?? []) as { text?: string; thought?: boolean }[];
  const text = parts.filter((p) => !p.thought).map((p) => p.text ?? '').join('').trim();
  const usage = json?.usageMetadata ?? {};
  return {
    text,
    inputTokens: Number(usage.promptTokenCount ?? 0),
    outputTokens: Number(usage.candidatesTokenCount ?? 0) + Number(usage.thoughtsTokenCount ?? 0),
  };
}

/** The price per million tokens for a route: what was saved with it, else the preset's. */
export function priceOf(route: LlmRoute): { input: number; output: number } | null {
  if (Number.isFinite(route.inputPer1M) && Number.isFinite(route.outputPer1M)) {
    return { input: route.inputPer1M as number, output: route.outputPer1M as number };
  }
  const p = LLM_MODEL_PRESETS.find((m) => m.provider === route.provider && m.id === route.model);
  return p ? { input: p.inputPer1M, output: p.outputPer1M } : null;
}

export function costOf(route: LlmRoute, inputTokens: number, outputTokens: number): number {
  const price = priceOf(route);
  return price ? (inputTokens * price.input + outputTokens * price.output) / 1_000_000 : 0;
}

export async function complete(route: LlmRoute, key: string, req: LlmRequest): Promise<LlmResult> {
  return route.provider === 'openai' ? completeOpenAi(key, route.model, req) : completeGemini(key, route.model, req);
}

/** One row on the usage report, success or failure. Never throws: book-keeping must not take the work down with it. */
async function record(ctx: CallContext, route: LlmRoute, result: LlmResult | null, latencyMs: number, error: unknown): Promise<void> {
  try {
    if (!supabaseAdmin) return;
    const orgId = await resolveOrgId(ctx.orgId);
    if (!orgId) return;
    const input = result?.inputTokens ?? 0;
    const output = result?.outputTokens ?? 0;
    await supabaseAdmin.from('activity_log').insert({
      org_id: orgId,
      actor: ctx.actor ?? null,
      action: AI_USAGE_ACTION,
      entity: ctx.entity ?? null,
      entity_id: ctx.entityId ?? null,
      meta: {
        feature: ctx.feature,
        provider: route.provider as LlmProvider,
        model: route.model,
        input_tokens: input,
        output_tokens: output,
        cache_write_tokens: 0,
        cache_read_tokens: 0,
        cost_usd: Number(costOf(route, input, output).toFixed(6)),
        latency_ms: latencyMs,
        ok: !error,
        error: error ? String((error as Error).message ?? error).slice(0, 500) : null,
      },
    });
  } catch (err) {
    console.error('[ai_usage] could not record call', (err as Error).message);
  }
}

/**
 * Run an action on the provider the studio chose for it, if it chose one.
 *
 * Returns null — and the caller carries on with Claude exactly as before —
 * when the action is left on Claude, or when its provider has no key (a key
 * removed after the choice was made must not stop mail being read). A call
 * that reaches the provider and fails throws instead: quietly re-running it on
 * Claude would spend twice and hide that the chosen provider is down.
 */
export async function tryRouted(ctx: CallContext, req: LlmRequest): Promise<string | null> {
  const route = await resolveRoute(ctx.feature, ctx.orgId);
  if (!route) return null;
  const key = await keyFor(route.provider as Exclude<LlmProvider, 'anthropic'>, ctx.orgId);
  if (!key) {
    console.warn(`[llm] ${ctx.feature} is set to ${route.provider} but it has no key — using Claude`);
    return null;
  }
  const started = Date.now();
  try {
    const result = await complete(route, key, req);
    await record(ctx, route, result, Date.now() - started, null);
    return result.text;
  } catch (err) {
    await record(ctx, route, null, Date.now() - started, err);
    throw err;
  }
}
