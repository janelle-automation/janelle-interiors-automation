import Anthropic from '@anthropic-ai/sdk';
import { estimateCostUsd, type AiFeature } from '@janelle/shared';
import { env, isAnthropicConfigured } from '../env.js';
import { resolveAi } from '../lib/aiSettings.js';
import { resolveOrgId } from '../lib/org.js';
import { supabaseAdmin } from '../lib/supabase.js';

/** The activity_log action that marks one Claude call. */
export const AI_USAGE_ACTION = 'ai.usage';

/**
 * How long one call to Claude may take, and how often it is re-sent.
 *
 * The SDK's own defaults are ten minutes and two retries, which is right
 * for a script and wrong here: every caller runs inside a serverless
 * function that the platform kills at 60s, and a single call left hanging
 * takes the whole invocation down with it — the browser then sees a
 * dropped connection rather than an error. Bounding each attempt is what
 * makes the callers' own time budgets mean anything. One retry is kept,
 * because a 429 or a 500 is worth re-sending and is usually quick.
 *
 * A PDF that cannot be read inside this is skipped and logged, which is
 * why `MAX_PDF_BYTES` keeps documents small enough to finish.
 */
const CALL_TIMEOUT_MS = Number(process.env.ANTHROPIC_TIMEOUT_MS || 25_000);
const CALL_MAX_RETRIES = Number(process.env.ANTHROPIC_MAX_RETRIES ?? 1);

/**
 * The environment-configured client, kept for callers that only need to
 * know whether Claude is available at boot. The client actually used for
 * a call is resolved per studio in `clientFor()`, because the key and
 * model are now editable from Settings.
 */
export const anthropic: Anthropic | null = isAnthropicConfigured()
  ? new Anthropic({
      apiKey: env.anthropic.apiKey,
      timeout: CALL_TIMEOUT_MS,
      maxRetries: CALL_MAX_RETRIES,
    })
  : null;

/**
 * One client per distinct key. Constructing an SDK client is cheap but
 * not free, and every Claude call goes through here.
 */
const clients = new Map<string, Anthropic>();

function clientForKey(apiKey: string): Anthropic {
  const existing = clients.get(apiKey);
  if (existing) return existing;
  const created = new Anthropic({ apiKey, timeout: CALL_TIMEOUT_MS, maxRetries: CALL_MAX_RETRIES });
  clients.set(apiKey, created);
  return created;
}

/**
 * The studio's key and model, falling back to the environment. Null when
 * no key is configured anywhere — callers degrade gracefully.
 */
export async function clientFor(
  orgId?: string | null,
): Promise<{ client: Anthropic; model: string } | null> {
  const { apiKey, model } = await resolveAi(orgId);
  if (!apiKey) return null;
  return { client: clientForKey(apiKey), model };
}

/** Whether this studio can call Claude at all. */
export async function isAiReady(orgId?: string | null): Promise<boolean> {
  return Boolean(await clientFor(orgId));
}

export class AnthropicNotConfigured extends Error {
  constructor() {
    super('Claude API is not configured (set ANTHROPIC_API_KEY).');
    this.name = 'AnthropicNotConfigured';
  }
}

/**
 * Who this call was for. Every helper below takes one, so a new caller
 * cannot spend the studio's money without appearing on the usage report.
 */
export interface CallContext {
  feature: AiFeature;
  /** Left out by the background services, which resolve the studio below. */
  orgId?: string | null;
  /** The person who pressed the button; null when the agent acted alone. */
  actor?: string | null;
  entity?: string | null;
  entityId?: string | null;
}

/** Concatenate the text blocks of a Claude response. */
function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// ── Usage recording ─────────────────────────────────────────

/**
 * One row per API call, success or failure. Never throws and never
 * blocks the caller: a book-keeping problem must not take down the
 * feature that was doing the actual work.
 */
async function record(
  ctx: CallContext,
  model: string,
  usage: Anthropic.Usage | null,
  latencyMs: number,
  error: unknown,
): Promise<void> {
  try {
    if (!supabaseAdmin) return;
    const orgId = await resolveOrgId(ctx.orgId);
    if (!orgId) return;

    const tokens = {
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
      cache_write_tokens: usage?.cache_creation_input_tokens ?? 0,
      cache_read_tokens: usage?.cache_read_input_tokens ?? 0,
    };

    // Written to activity_log rather than a table of its own: the studio
    // has one database connection, and a new table would need DDL and a
    // second credential before any of this could be recorded at all. The
    // audit log already exists, is already org-scoped, and this genuinely
    // is activity — the Audit Log screen filters these out so it stays
    // readable, and the usage report reads them back by action.
    await supabaseAdmin.from('activity_log').insert({
      org_id: orgId,
      actor: ctx.actor ?? null,
      action: AI_USAGE_ACTION,
      entity: ctx.entity ?? null,
      entity_id: ctx.entityId ?? null,
      meta: {
        feature: ctx.feature,
        model,
        ...tokens,
        cost_usd: Number(estimateCostUsd(model, tokens).toFixed(6)),
        latency_ms: latencyMs,
        ok: !error,
        // The message only — an API error can carry a whole request in it.
        error: error ? String((error as Error).message ?? error).slice(0, 500) : null,
      },
    });
  } catch (err) {
    console.error('[ai_usage] could not record call', (err as Error).message);
  }
}

/**
 * Run a Claude call and record what it cost, whatever happens to it.
 *
 * The model comes from the studio's settings unless the caller named one
 * explicitly, so changing the model in Settings changes every feature at
 * once without touching a single call site.
 */
async function recorded(
  ctx: CallContext,
  params: Omit<Anthropic.MessageCreateParamsNonStreaming, 'model'> & { model?: string },
): Promise<Anthropic.Message> {
  const ai = await clientFor(ctx.orgId);
  if (!ai) throw new AnthropicNotConfigured();

  const request = { ...params, model: params.model ?? ai.model };
  const started = Date.now();
  try {
    const message = await ai.client.messages.create(request);
    await record(ctx, request.model, message.usage, Date.now() - started, null);
    return message;
  } catch (err) {
    await record(ctx, request.model, null, Date.now() - started, err);
    throw err;
  }
}

/**
 * For callers that build their own request (the Assistant runs a tool
 * loop). Everything still lands on the usage report.
 */
export function createMessage(
  ctx: CallContext,
  params: Omit<Anthropic.MessageCreateParamsNonStreaming, 'model'> & { model?: string },
): Promise<Anthropic.Message> {
  return recorded(ctx, params);
}

// ── Helpers ─────────────────────────────────────────────────

/** Pull the first balanced JSON object/array out of a string. */
export function firstJson<T>(text: string): T | null {
  const start = text.search(/[[{]/);
  if (start === -1) return null;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as T;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

type UserContent = string | Anthropic.ContentBlockParam[];

/**
 * Ask Claude for a JSON object matching a described shape. The prompt
 * must instruct the required fields; this returns the parsed object or
 * null if nothing parseable came back.
 */
export async function extractJson<T>(
  system: string,
  user: UserContent,
  ctx: CallContext,
): Promise<T | null> {
  const message = await recorded(ctx, {
    max_tokens: 4096,
    // Reading, not writing: the same document should give the same fields
    // every time. At the default temperature one estimate named its job on
    // one read and not on the next.
    temperature: 0,
    system: `${system}\n\nRespond with ONLY a single JSON object. No prose, no code fences.`,
    messages: [{ role: 'user', content: user }],
  });
  return firstJson<T>(textOf(message));
}

/** Free-form generation (prompt runner, report narrative). */
export async function generate(
  system: string,
  user: string,
  ctx: CallContext,
  maxTokens = 8000,
): Promise<string> {
  const message = await recorded(ctx, {
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return textOf(message);
}
