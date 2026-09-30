import { openAiImageCostUsd, type OpenAiQuality } from '@janelle/shared';
import { resolveOpenAi } from '../lib/aiSettings.js';
import { resolveOrgId } from '../lib/org.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { compactImage } from '../lib/compactImage.js';
import { AI_USAGE_ACTION, type CallContext } from './anthropic.js';
import { RenderTimeout, type GeneratedImage, type ImageRequest } from './grok.js';

/**
 * Renderings from OpenAI's GPT Image models.
 *
 * The same shape as Grok's `generateImage` on purpose — a prompt and an
 * optional source in, bytes out — so `imagine.ts` can put it in the same
 * chain and Jenny neither knows nor cares who drew the picture. No SDK, for
 * the reason grok.ts gives: `fetch` does it, and the timeout has to be ours
 * because every caller sits inside a function the platform will kill.
 *
 * Two endpoints. Drawing from words is `/images/generations`. A supplied
 * picture goes to `/images/edits`, which holds its frame and changes what
 * the brief asks — the behaviour wanted when a designer attaches a room
 * photo and says "make the floor herringbone oak".
 *
 * GPT Image always answers with base64 and takes no `response_format`;
 * sending one is refused, so it is never sent.
 */

const OPENAI_URL = 'https://api.openai.com/v1';

/** One render. Callers pass what their own request has left; this is the fallback. */
const IMAGE_TIMEOUT_MS = Number(process.env.OPENAI_IMAGE_TIMEOUT_MS || 55_000);

export class OpenAiNotConfigured extends Error {
  constructor() {
    super('OpenAI is not set up yet — add an OpenAI API key in Settings.');
    this.name = 'OpenAiNotConfigured';
  }
}

export async function isOpenAiReady(orgId?: string | null): Promise<boolean> {
  const ai = await resolveOpenAi(orgId);
  return Boolean(ai.apiKey);
}

/** The three shapes GPT Image draws, chosen from the aspect ratio asked for. */
function sizeFor(aspect: string | undefined): { size: '1024x1024' | '1536x1024' | '1024x1536'; wide: boolean } {
  const m = String(aspect ?? '').match(/^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/);
  if (!m) return { size: '1536x1024', wide: true };
  const ratio = Number(m[1]) / Number(m[2]);
  if (ratio > 1.15) return { size: '1536x1024', wide: true };
  if (ratio < 0.87) return { size: '1024x1536', wide: true };
  return { size: '1024x1024', wide: false };
}

interface OpenAiErrorBody {
  error?: { message?: string; code?: string; type?: string } | string;
}

function messageOf(json: Record<string, unknown>): string {
  const e = (json as OpenAiErrorBody).error;
  if (typeof e === 'string') return e.trim();
  return typeof e?.message === 'string' ? e.message.trim() : '';
}

/** A provider failure, turned into something a person can act on. */
function explain(res: Response, json: Record<string, unknown>, what: string): Error {
  const said = messageOf(json);
  const code = String((json as { error?: { code?: string } }).error?.code ?? '');

  if (res.status === 401) {
    return new Error('The OpenAI key is not valid — check it in Settings, or create a new one at platform.openai.com.');
  }
  if (/organization.*verif|must be verified/i.test(said)) {
    return new Error(
      'OpenAI needs the studio’s organization verified before it will draw with this model — verify it at platform.openai.com (Settings → Organization → Verify), or choose GPT Image 1 mini in Settings.',
    );
  }
  if (res.status === 402 || /billing|insufficient_quota|credit/i.test(`${said} ${code}`)) {
    return new Error('The studio’s OpenAI credit has run out. Add credit at platform.openai.com under Billing, then try again.');
  }
  if (res.status === 429 || /rate.?limit/i.test(`${said} ${code}`)) {
    return new Error('OpenAI is rate-limiting the studio right now. Wait a moment and try again.');
  }
  if (res.status === 404 || /model.*(not found|does not exist)/i.test(said)) {
    return new Error(`${said || `${what} was refused`} — check the model in Settings.`);
  }
  if (/moderation|safety|content.?policy|not allowed|blocked/i.test(`${said} ${code}`)) {
    return new Error(`OpenAI would not draw that: ${said}`);
  }
  return new Error(said || `${what} failed (${res.status}).`);
}

function timedOut(err: unknown, what: string): Error {
  if ((err as Error)?.name === 'AbortError') {
    return new RenderTimeout(`${what} took longer than the time limit. Try again, or ask for something simpler.`);
  }
  return err as Error;
}

/** Spend goes on the same report as every other picture. */
async function record(
  ctx: CallContext,
  model: string,
  latencyMs: number,
  error: unknown,
  cost: number,
): Promise<void> {
  try {
    if (!supabaseAdmin) return;
    const orgId = await resolveOrgId(ctx.orgId);
    if (!orgId) return;
    await supabaseAdmin.from('activity_log').insert({
      org_id: orgId,
      actor: ctx.actor ?? null,
      action: AI_USAGE_ACTION,
      entity: ctx.entity ?? null,
      entity_id: ctx.entityId ?? null,
      meta: {
        feature: ctx.feature,
        model,
        input_tokens: 0,
        output_tokens: 0,
        cache_write_tokens: 0,
        cache_read_tokens: 0,
        images: error ? 0 : 1,
        cost_usd: Number(cost.toFixed(6)),
        latency_ms: latencyMs,
        ok: !error,
        error: error ? String((error as Error).message ?? error).slice(0, 500) : null,
      },
    });
  } catch (err) {
    console.error('[ai_usage] could not record an OpenAI call', (err as Error).message);
  }
}

/** Draw one picture — from words, or by editing the supplied one. */
export async function generateOpenAiImage(
  req: ImageRequest & { quality?: OpenAiQuality },
  ctx: CallContext,
): Promise<GeneratedImage> {
  const ai = await resolveOpenAi(ctx.orgId);
  if (!ai.apiKey) throw new OpenAiNotConfigured();
  const model = ai.imageModel;
  const mode: 'edit' | 'generate' = req.source ? 'edit' : 'generate';
  const { size, wide } = sizeFor(req.aspectRatio);
  // Quality is the studio's dial; a "1K" ask is the quick draft.
  const quality: OpenAiQuality = req.quality ?? (req.resolution === '1K' && ai.quality === 'high' ? 'medium' : ai.quality);

  const limit = req.timeoutMs && req.timeoutMs > 0 ? req.timeoutMs : IMAGE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limit);
  const started = Date.now();

  try {
    let res: Response;
    if (req.source) {
      // An edit keeps the picture's own shape: size is left to the model.
      const form = new FormData();
      form.append('model', model);
      form.append('prompt', req.prompt.slice(0, 32_000));
      form.append('quality', quality);
      form.append('size', 'auto');
      const ext = req.source.mimeType.includes('jpeg') ? 'jpg' : req.source.mimeType.includes('webp') ? 'webp' : 'png';
      form.append('image[]', new Blob([new Uint8Array(req.source.bytes)], { type: req.source.mimeType }), `source.${ext}`);
      res = await fetch(`${OPENAI_URL}/images/edits`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ai.apiKey}` },
        body: form,
        signal: controller.signal,
      });
    } else {
      res = await fetch(`${OPENAI_URL}/images/generations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ai.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: req.prompt.slice(0, 32_000), n: 1, size, quality }),
        signal: controller.signal,
      });
    }

    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    // The clock can run out while the picture is still arriving; that reads
    // as an empty body, and must not be reported as "no image came back".
    if (controller.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (!res.ok) throw explain(res, json, mode === 'edit' ? 'The image edit' : 'The image request');

    const item = (json.data as { b64_json?: unknown; url?: unknown; revised_prompt?: unknown }[] | undefined)?.[0];
    let bytes: Buffer | null = null;
    if (typeof item?.b64_json === 'string' && item.b64_json) bytes = Buffer.from(item.b64_json, 'base64');
    else if (typeof item?.url === 'string' && item.url) {
      const fetched = await fetch(item.url, { signal: controller.signal });
      if (fetched.ok) bytes = Buffer.from(await fetched.arrayBuffer());
    }
    if (!bytes?.length) throw new Error('No image came back from OpenAI.');

    await record(ctx, model, Date.now() - started, null, openAiImageCostUsd(model, quality, wide && !req.source));
    const compact = await compactImage({ bytes, mimeType: 'image/png' });
    return {
      bytes: compact.bytes,
      mimeType: compact.mimeType,
      model,
      mode,
      note: typeof item?.revised_prompt === 'string' && item.revised_prompt.trim() ? item.revised_prompt.trim() : null,
    };
  } catch (err) {
    const error = timedOut(err, mode === 'edit' ? 'The image edit' : 'The image');
    await record(ctx, model, Date.now() - started, error, 0);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
