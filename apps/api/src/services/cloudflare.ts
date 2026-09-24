import { supabaseAdmin } from '../lib/supabase.js';
import { resolveOrgId } from '../lib/org.js';
import { resolveCloudflare } from '../lib/aiSettings.js';
import { AI_USAGE_ACTION, type CallContext } from './anthropic.js';
import type { RenderResult } from './images.js';

/**
 * Photoreal renderings on Cloudflare Workers AI — the free picture source.
 *
 * FLUX.1 [schnell] draws a convincing room in a few seconds, and the free
 * Workers plan gives 10,000 "neurons" a day at no charge: roughly 100 to 170
 * images. Past that, Cloudflare refuses the request rather than billing it,
 * which is exactly the behaviour a studio without image billing wants.
 *
 * FLUX.1 draws from words; an attached photograph goes to FLUX.2 [klein]
 * instead (`editWithCloudflare`), which keeps the room and changes only
 * what the brief describes.
 */

const BASE = 'https://api.cloudflare.com/client/v4/accounts';

/** FLUX's own ceiling on the prompt; anything longer is refused outright. */
const MAX_PROMPT_CHARS = 2048;

export class CloudflareQuotaExceeded extends Error {
  constructor() {
    super('Today’s free Cloudflare image allowance is used up — it resets daily.');
    this.name = 'CloudflareQuotaExceeded';
  }
}

export async function isCloudflareReady(orgId?: string | null): Promise<boolean> {
  const cf = await resolveCloudflare(orgId);
  return Boolean(cf.accountId && cf.apiToken);
}

/** Neurons at 1024×1024 — four 512 tiles plus the steps — for the usage report. */
function neuronsFor(model: string, steps: number): number {
  return /flux-1-schnell/.test(model) ? Math.round(4 * 4.8 + steps * 9.6) : 0;
}

async function record(
  ctx: CallContext,
  model: string,
  steps: number,
  latencyMs: number,
  error: unknown,
  neuronsUsed?: number,
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
        // The free allowance: nothing is billed. Neurons are kept so a
        // studio can see how close a day came to the limit.
        cost_usd: 0,
        neurons: error ? 0 : neuronsUsed ?? neuronsFor(model, steps),
        latency_ms: latencyMs,
        ok: !error,
        error: error ? String((error as Error).message ?? error).slice(0, 500) : null,
      },
    });
  } catch (err) {
    console.error('[ai_usage] could not record Cloudflare render', (err as Error).message);
  }
}

/**
 * The model that works FROM a picture: FLUX.2 [klein] 4B takes the photo as
 * a reference and changes only what the brief asks — the room stays the
 * room. About 126 neurons an edit at 1024 wide, so roughly 80 a day free.
 */
export const CLOUDFLARE_EDIT_MODEL = '@cf/black-forest-labs/flux-2-klein-4b';

/** Width and height from a JPEG or PNG header, without decoding it. */
function imageSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      const length = bytes.readUInt16BE(i + 2);
      // Start-of-frame markers carry the dimensions (not DHT/JPG/DAC).
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
      }
      i += 2 + length;
    }
  }
  return null;
}

/** The output size: the photo's own proportions, longest side 1024, in 16s. */
function outputSize(source: Buffer): { width: number; height: number } {
  const size = imageSize(source);
  if (!size || !size.width || !size.height) return { width: 1024, height: 768 };
  const scale = 1024 / Math.max(size.width, size.height);
  const round = (n: number) => Math.max(256, Math.round((n * scale) / 16) * 16);
  return { width: round(size.width), height: round(size.height) };
}

/**
 * Change a supplied photograph — furnish the empty room, re-do the kitchen —
 * keeping its architecture, window, floor and camera where they are.
 */
export async function editWithCloudflare(
  prompt: string,
  source: { bytes: Buffer; mimeType: string },
  ctx: CallContext,
  options?: { timeoutMs?: number },
): Promise<RenderResult> {
  const cf = await resolveCloudflare(ctx.orgId);
  if (!cf.accountId || !cf.apiToken) throw new Error('Cloudflare is not set up — add the Account ID and API token in Settings.');

  const { width, height } = outputSize(source.bytes);
  const form = new FormData();
  form.append('prompt', prompt.slice(0, MAX_PROMPT_CHARS));
  form.append('input_image_0', new Blob([new Uint8Array(source.bytes)], { type: source.mimeType }), 'source');
  form.append('width', String(width));
  form.append('height', String(height));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 40_000);
  const started = Date.now();
  // Output tiles at the chosen size, plus the input photo, as Cloudflare prices it.
  const tiles = (w: number, h: number) => Math.ceil(w / 512) * Math.ceil(h / 512);
  const inputSize = imageSize(source.bytes);
  const neurons = Math.round(tiles(width, height) * 26.05 + (inputSize ? tiles(inputSize.width, inputSize.height) : 4) * 5.37);
  try {
    const res = await fetch(`${BASE}/${encodeURIComponent(cf.accountId)}/ai/run/${CLOUDFLARE_EDIT_MODEL}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cf.apiToken}` },
      body: form,
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => ({}))) as {
      result?: { image?: string };
      errors?: { message?: string }[];
    };
    const image = json.result?.image;
    if (res.ok && image) {
      const bytes = Buffer.from(image, 'base64');
      await record(ctx, CLOUDFLARE_EDIT_MODEL, 0, Date.now() - started, null, neurons);
      return { bytes, mimeType: bytes[0] === 0x89 ? 'image/png' : 'image/jpeg', model: CLOUDFLARE_EDIT_MODEL, note: null };
    }
    const message = json.errors?.map((e) => e.message).filter(Boolean).join('; ') || `Cloudflare returned ${res.status}`;
    if (res.status === 429 || /neuron|daily|allocation|quota|limit/i.test(message)) throw new CloudflareQuotaExceeded();
    throw new Error(message);
  } catch (err) {
    await record(ctx, CLOUDFLARE_EDIT_MODEL, 0, Date.now() - started, err);
    if ((err as Error).name === 'AbortError') throw new Error('Cloudflare took longer than the time limit to render.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One picture from words.
 *
 * The response shape differs by model: FLUX answers JSON with the image as
 * base64, Stable Diffusion answers with the PNG bytes themselves. Both are
 * handled, so switching model in Settings needs nothing else.
 */
export async function renderWithCloudflare(
  prompt: string,
  ctx: CallContext,
  options?: { timeoutMs?: number },
): Promise<RenderResult> {
  const cf = await resolveCloudflare(ctx.orgId);
  if (!cf.accountId || !cf.apiToken) throw new Error('Cloudflare is not set up — add the Account ID and API token in Settings.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 40_000);
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/${encodeURIComponent(cf.accountId)}/ai/run/${cf.model}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cf.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt.slice(0, MAX_PROMPT_CHARS), steps: cf.steps }),
      signal: controller.signal,
    });

    const type = res.headers.get('content-type') ?? '';
    if (res.ok && type.startsWith('image/')) {
      const bytes = Buffer.from(await res.arrayBuffer());
      await record(ctx, cf.model, cf.steps, Date.now() - started, null);
      return { bytes, mimeType: type.split(';')[0], model: cf.model, note: null };
    }

    const json = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      result?: { image?: string };
      errors?: { code?: number; message?: string }[];
    };
    const image = json.result?.image;
    if (res.ok && image) {
      const bytes = Buffer.from(image, 'base64');
      await record(ctx, cf.model, cf.steps, Date.now() - started, null);
      // FLUX returns JPEG; sniffed rather than assumed.
      const mimeType = bytes[0] === 0x89 ? 'image/png' : 'image/jpeg';
      return { bytes, mimeType, model: cf.model, note: null };
    }

    const message = json.errors?.map((e) => e.message).filter(Boolean).join('; ') || `Cloudflare returned ${res.status}`;
    // The daily free allocation, used up. Worded by Cloudflare in more than
    // one way over time; the status and the words together catch it.
    if (res.status === 429 || /neuron|daily|allocation|quota|limit/i.test(message)) throw new CloudflareQuotaExceeded();
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Cloudflare refused the token (${message}). Check the Account ID and that the token has Workers AI permission.`);
    }
    throw new Error(message);
  } catch (err) {
    await record(ctx, cf.model, cf.steps, Date.now() - started, err);
    if ((err as Error).name === 'AbortError') throw new Error('Cloudflare took longer than the time limit to render.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
