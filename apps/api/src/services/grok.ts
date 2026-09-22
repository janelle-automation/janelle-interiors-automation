import { grokImageCostUsd, maxVideoSeconds, videoCostUsd } from '@janelle/shared';
import { resolveXai } from '../lib/aiSettings.js';
import { resolveOrgId } from '../lib/org.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { AI_USAGE_ACTION, type CallContext } from './anthropic.js';

/**
 * Renderings and short video, from xAI's Grok Imagine models.
 *
 * The second image provider in the app, and the first that can animate.
 * `services/images.ts` draws the studio's presentation boards and keeps
 * doing so — the house template is a typography job and Gemini holds the
 * reference-matching logic for it. This is for everything that template
 * never covered: a rendering of a room, a concept image, a walk-through.
 *
 * The interface is deliberately not Grok-shaped. A caller asks for a
 * picture or starts a clip; `request_id`, `generate_audio` and
 * `respect_moderation` never leave this file. What does leave it is bytes,
 * a job id, and sentences a person can act on.
 *
 * The one thing that genuinely cannot be hidden is the clock: an image
 * comes back inside a request and a video does not, and no amount of
 * interface design makes a 60-second serverless function wait two minutes.
 * So video is two calls — `startVideo`, then `pollVideo` — and
 * `services/mediaJobs.ts` owns the waiting.
 */

const XAI_URL = 'https://api.x.ai/v1';

/**
 * How long one image call may run.
 *
 * Bounded well inside what is left of the assistant's own budget
 * (ASSISTANT_BUDGET_MS, 40s): a render that outlives the turn does not
 * produce a late picture, it produces no answer at all. Deliberately NOT
 * the 180s the board renderer asks for — that one already outlives the
 * function it runs in.
 */
const IMAGE_TIMEOUT_MS = Number(process.env.XAI_IMAGE_TIMEOUT_MS || 25_000);

/** Starting a video returns an id, not a video, so this is a short call. */
const START_TIMEOUT_MS = Number(process.env.XAI_START_TIMEOUT_MS || 15_000);

/** One poll. Short: it is a status read, and something is waiting on it. */
const POLL_TIMEOUT_MS = Number(process.env.XAI_POLL_TIMEOUT_MS || 10_000);

/** Fetching the finished mp4 out of the provider's temporary URL. */
const FETCH_TIMEOUT_MS = Number(process.env.XAI_FETCH_TIMEOUT_MS || 30_000);

/**
 * The studio's own ceiling on a clip, under the provider's 15s.
 *
 * At eight cents a second the difference between six seconds and fifteen
 * is the difference between fifty cents and a pound twenty, on an action
 * someone can trigger by speaking a sentence. The default is deliberately
 * conservative; raise it in the environment once the studio has agreed
 * what a month of this should cost.
 */
export const MEDIA_MAX_SECONDS = Number(process.env.MEDIA_MAX_SECONDS || 8);

export interface GeneratedImage {
  bytes: Buffer;
  mimeType: string;
  model: string;
  /** Anything the model said alongside the picture — usually a limitation. */
  note: string | null;
  /** Whether a picture was transformed, or one was drawn from words alone. */
  mode: 'edit' | 'generate';
}

export interface ImageRequest {
  prompt: string;
  /**
   * The picture to transform.
   *
   * Its presence is what decides which endpoint is used, because the
   * provider draws and edits in two different places. Editing takes
   * exactly ONE source image and keeps its aspect ratio — which is the
   * behaviour wanted when someone hands over a sketch and asks for it
   * built: the drawing's proportions are the proportions of the building.
   */
  source?: { mimeType: string; bytes: Buffer } | null;
  /** Ignored when editing: the edit endpoint takes one picture and no more. */
  aspectRatio?: string;
  /** 2K is the tier a client-facing visualisation wants. */
  resolution?: '1K' | '2K';
  /**
   * How long this render may take, set by the caller because only the
   * caller knows how much of its request is left. The direct Image mode
   * has nearly the whole function to spend; a render inside one of Jenny's
   * turns has what her budget leaves. IMAGE_TIMEOUT_MS when unset.
   */
  timeoutMs?: number;
}

export interface VideoRequest {
  prompt: string;
  /** Image-to-video: animate this still rather than drawing from words. */
  image?: { mimeType: string; bytes: Buffer } | null;
  seconds?: number;
  aspectRatio?: string;
  resolution?: '480p' | '720p' | '1080p';
  /**
   * Sound. Off unless someone asks, and the default is the reason why: the
   * provider generates audio by default, Jenny reads her answers aloud, and
   * a talking video plus a talking assistant is two voices at once — which
   * the browser's own echo filter then feeds back as the next question.
   */
  withAudio?: boolean;
}

export type VideoStatus =
  | { status: 'pending' }
  | { status: 'done'; url: string; seconds: number; model: string }
  | { status: 'failed' | 'expired'; message: string };

export class GrokNotConfigured extends Error {
  constructor() {
    super('Grok is not set up yet — add an xAI API key in Settings.');
    this.name = 'GrokNotConfigured';
  }
}

/** Whether this studio can render or animate at all. */
export async function isGrokReady(orgId?: string | null): Promise<boolean> {
  const ai = await resolveXai(orgId);
  return Boolean(ai.apiKey);
}

/** The models this studio is set to use, for a tool that wants to say so. */
export async function grokModels(orgId?: string | null): Promise<{ image: string; video: string }> {
  const ai = await resolveXai(orgId);
  return { image: ai.imageModel, video: ai.videoModel };
}

/** Seconds the caller may actually have: their ask, the studio cap, the provider cap. */
export function clampSeconds(asked: number | undefined, model: string): number {
  const wanted = Number.isFinite(asked) ? Math.round(Number(asked)) : 6;
  return Math.max(1, Math.min(wanted, MEDIA_MAX_SECONDS, maxVideoSeconds(model)));
}

// ── Talking to the provider ─────────────────────────────────

interface XaiError {
  error?: { message?: string; code?: string } | string;
  message?: string;
  detail?: string;
}

/**
 * One call, bounded, with the key in a header.
 *
 * No SDK: the dependency would buy nothing that `fetch` does not already
 * do, and the timeout has to be ours because every caller is inside a
 * function the platform will kill.
 */
async function call(
  path: string,
  init: { method?: string; body?: unknown; apiKey: string; timeoutMs: number },
): Promise<{ res: Response; json: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  try {
    const res = await fetch(`${XAI_URL}${path}`, {
      method: init.method ?? 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${init.apiKey}`,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { res, json };
  } finally {
    clearTimeout(timer);
  }
}

/** The provider's own words, dug out of whichever shape it used. */
function messageOf(json: Record<string, unknown>): string {
  const e = (json as XaiError).error;
  if (typeof e === 'string' && e.trim()) return e.trim();
  if (e && typeof e === 'object' && typeof e.message === 'string' && e.message.trim()) {
    return e.message.trim();
  }
  const top = (json as XaiError).message ?? (json as XaiError).detail;
  return typeof top === 'string' && top.trim() ? top.trim() : '';
}

/**
 * A provider failure, turned into something worth reading.
 *
 * The rule the rest of the app already follows: an API error that reaches
 * the screen as "Server error" reads like a bug in the app, when in fact
 * exactly one person can fix it and they need to be told which thing to
 * go and do.
 */
function explain(res: Response, json: Record<string, unknown>, what: string): Error {
  const said = messageOf(json);

  if (res.status === 401 || res.status === 403) {
    return new Error('The xAI key is not valid — check it in Settings, or replace it at console.x.ai.');
  }
  if (res.status === 402 || /credit|billing|insufficient/i.test(said)) {
    return new Error(
      "The studio's xAI credit has run out. Top it up at console.x.ai under Billing, then try again.",
    );
  }
  if (res.status === 429 || /rate.?limit|quota/i.test(said)) {
    return new Error('xAI is rate-limiting the studio right now. Wait a moment and try again.');
  }
  if (res.status === 404) {
    return new Error(`${said || `${what} was refused`} — check the model id in Settings.`);
  }
  if (/moderat|policy|refus|not allowed|blocked/i.test(said)) {
    return new Error(`Grok would not draw that: ${said}`);
  }
  return new Error(said || `${what} failed (${res.status}).`);
}

/**
 * An aborted call is the clock, not the request, and reads differently.
 *
 * Tagged, so a caller can tell "Grok was slow" from "Grok said no" — the
 * first is worth another go as it stands, the second is not.
 */
export class RenderTimeout extends Error {
  readonly timedOut = true;
}

function timedOut(err: unknown, what: string): Error {
  if ((err as Error)?.name === 'AbortError') {
    return new RenderTimeout(`${what} took longer than the time limit. Try again, or ask for something simpler.`);
  }
  return err as Error;
}

// ── Images ──────────────────────────────────────────────────

/**
 * The picture out of a response.
 *
 * Two shapes are accepted because the provider documents an OpenAI-shaped
 * `data[0].url` and the same family of APIs commonly also returns
 * `b64_json`. Whichever arrives is used; a URL is fetched here so that
 * every caller above this line deals in bytes, never in a link that is
 * going to expire.
 */
async function imageBytes(
  json: Record<string, unknown>,
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  // Two shapes, because the two endpoints answer differently: generations
  // is OpenAI-shaped with a `data` array, and editing is documented as
  // returning the picture at the top level. Whichever arrived is used.
  const candidates = [
    (json.data as { url?: unknown; b64_json?: unknown }[] | undefined)?.[0],
    json as { url?: unknown; b64_json?: unknown },
    json.image as { url?: unknown; b64_json?: unknown } | undefined,
  ];

  for (const found of candidates) {
    if (!found) continue;
    if (typeof found.b64_json === 'string' && found.b64_json) {
      return { bytes: Buffer.from(found.b64_json, 'base64'), mimeType: 'image/png' };
    }
    if (typeof found.url === 'string' && found.url) {
      return fetchMedia(found.url, 'image/png');
    }
  }
  return null;
}

/**
 * Pull bytes out of a provider URL.
 *
 * Every one of these URLs is temporary — the video docs say so outright —
 * so nothing is ever stored as a link to xAI. It is fetched, put in the
 * studio's own bucket, and served from there.
 */
export async function fetchMedia(
  url: string,
  fallbackType: string,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`The finished media could not be fetched (${res.status}).`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const mimeType = (res.headers.get('content-type') ?? '').split(';')[0].trim() || fallbackType;
    return { bytes, mimeType };
  } catch (err) {
    throw timedOut(err, 'Fetching the finished media');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Draw one picture.
 *
 * Every attempt lands on the spend report, successful or not: a render
 * that failed still cost time, and a studio wondering why the month looks
 * expensive should see the failures too.
 */
export async function generateImage(req: ImageRequest, ctx: CallContext): Promise<GeneratedImage> {
  const ai = await resolveXai(ctx.orgId);
  if (!ai.apiKey) throw new GrokNotConfigured();
  const model = ai.imageModel;
  const mode: 'edit' | 'generate' = req.source ? 'edit' : 'generate';

  // Two endpoints, not one flag. Editing holds the frame it was given and
  // changes what was asked for; generation starts from nothing. Handing a
  // sketch to the generation endpoint gets a picture loosely "inspired by"
  // it, which is the wrong answer when someone wants THEIR building built.
  const path = mode === 'edit' ? '/images/edits' : '/images/generations';
  const resolution = req.resolution ?? '2K';

  const body: Record<string, unknown> = { model, prompt: req.prompt, resolution };
  if (req.source) {
    body.image = {
      url: `data:${req.source.mimeType};base64,${req.source.bytes.toString('base64')}`,
      type: 'image_url',
    };
    // Deliberately no aspect_ratio: an edit keeps the source's proportions,
    // and a sketch's proportions are the drawing's own.
  } else {
    body.n = 1;
    body.response_format = 'b64_json';
    if (req.aspectRatio) body.aspect_ratio = req.aspectRatio;
  }

  const started = Date.now();
  const limit = req.timeoutMs && req.timeoutMs > 0 ? req.timeoutMs : IMAGE_TIMEOUT_MS;
  try {
    let { res, json } = await call(path, {
      body,
      apiKey: ai.apiKey,
      timeoutMs: limit,
    });

    // Not every optional field is documented for every model, and one the
    // account does not accept should not cost the whole picture. Retried
    // once with nothing but the model, the prompt and the source image —
    // a plainer request beats an error about a field nobody chose. Only
    // with what is left of the limit: the retry must not double it.
    const left = limit - (Date.now() - started);
    if (!res.ok && left > 5_000 && /response_format|b64_json|resolution|aspect|unknown|unsupported|invalid.*(field|param)/i.test(messageOf(json))) {
      const plain: Record<string, unknown> = { model, prompt: req.prompt };
      if (body.image) plain.image = body.image;
      ({ res, json } = await call(path, { body: plain, apiKey: ai.apiKey, timeoutMs: left }));
    }

    if (!res.ok) throw explain(res, json, mode === 'edit' ? 'The image edit' : 'The image request');

    const picture = await imageBytes(json);
    if (!picture) throw new Error('No image came back from Grok.');

    await record(ctx, model, Date.now() - started, null, { images: 1, cost: grokImageCostUsd(model, 1) });

    const revised =
      (json.data as { revised_prompt?: unknown }[] | undefined)?.[0]?.revised_prompt ??
      (json as { revised_prompt?: unknown }).revised_prompt;
    return {
      bytes: picture.bytes,
      mimeType: picture.mimeType,
      model,
      mode,
      note: typeof revised === 'string' && revised.trim() ? revised.trim() : null,
    };
  } catch (err) {
    const error = timedOut(err, mode === 'edit' ? 'The image edit' : 'The image');
    await record(ctx, model, Date.now() - started, error, { images: 0, cost: 0 });
    throw error;
  }
}

// ── Video ───────────────────────────────────────────────────

/**
 * Start a clip, and return as soon as the provider has taken the job.
 *
 * This is the whole reason video is shaped differently from everything
 * else in the app: the provider answers with an id and nothing to watch,
 * and the answer that asked for it has to end long before there is
 * anything to show.
 *
 * The start is NOT recorded on the spend report. Nothing has been drawn
 * yet, and a job that fails a second later would otherwise be billed here
 * and never corrected. The poll that sees `done` records the cost.
 */
export async function startVideo(
  req: VideoRequest,
  ctx: CallContext,
): Promise<{ requestId: string; model: string; seconds: number }> {
  const ai = await resolveXai(ctx.orgId);
  if (!ai.apiKey) throw new GrokNotConfigured();
  const model = ai.videoModel;
  const seconds = clampSeconds(req.seconds, model);

  const body: Record<string, unknown> = {
    model,
    prompt: req.prompt,
    duration: seconds,
    aspect_ratio: req.aspectRatio || '16:9',
    resolution: req.resolution || '720p',
    // Explicit, not omitted: the provider's own default is true.
    generate_audio: req.withAudio === true,
  };
  const dataUri = req.image
    ? `data:${req.image.mimeType};base64,${req.image.bytes.toString('base64')}`
    : null;
  // The same object the edit endpoint documents. Retried as a bare string
  // below if this endpoint wants the other shape — a refused start costs
  // nothing, since a video is only billed once it has been drawn.
  if (dataUri) body.image = { url: dataUri, type: 'image_url' };

  try {
    let { res, json } = await call('/videos/generations', {
      body,
      apiKey: ai.apiKey,
      timeoutMs: START_TIMEOUT_MS,
    });

    if (!res.ok && dataUri && /image/i.test(messageOf(json))) {
      ({ res, json } = await call('/videos/generations', {
        body: { ...body, image: dataUri },
        apiKey: ai.apiKey,
        timeoutMs: START_TIMEOUT_MS,
      }));
    }

    if (!res.ok) throw explain(res, json, 'The video request');

    const requestId = typeof json.request_id === 'string' ? json.request_id : '';
    if (!requestId) throw new Error('Grok accepted the video but returned no request id.');
    return { requestId, model, seconds };
  } catch (err) {
    throw timedOut(err, 'Starting the video');
  }
}

/**
 * Ask whether a clip is ready.
 *
 * Never throws for a provider-side "no": a failed or expired job is a
 * status, not an outage, and the caller writes it onto the job row for the
 * person to read. A network or auth problem does throw, because that is
 * worth retrying rather than recording as a dead job.
 */
export async function pollVideo(requestId: string, orgId?: string | null): Promise<VideoStatus> {
  const ai = await resolveXai(orgId);
  if (!ai.apiKey) throw new GrokNotConfigured();

  const { res, json } = await call(`/videos/${encodeURIComponent(requestId)}`, {
    method: 'GET',
    apiKey: ai.apiKey,
    timeoutMs: POLL_TIMEOUT_MS,
  });
  if (!res.ok) throw explain(res, json, 'Checking the video');

  const status = String(json.status ?? 'pending');
  if (status === 'failed' || status === 'expired') {
    return {
      status,
      message:
        messageOf(json) ||
        (status === 'expired'
          ? 'Grok dropped the request before it finished.'
          : 'Grok could not make that clip.'),
    };
  }
  if (status !== 'done') return { status: 'pending' };

  const video = (json.video ?? {}) as { url?: unknown; duration?: unknown };
  if (typeof video.url !== 'string' || !video.url) {
    return { status: 'failed', message: 'Grok reported the clip as done but gave no video.' };
  }
  return {
    status: 'done',
    url: video.url,
    seconds: Number(video.duration) || 0,
    model: typeof json.model === 'string' ? json.model : ai.videoModel,
  };
}

/** Book what a finished clip cost. Called once, by whoever first sees `done`. */
export async function recordVideo(
  ctx: CallContext,
  model: string,
  seconds: number,
  latencyMs: number,
  error: unknown,
): Promise<void> {
  await record(ctx, model, latencyMs, error, {
    seconds,
    cost: error ? 0 : videoCostUsd(model, seconds),
  });
}

// ── Spend ───────────────────────────────────────────────────

/**
 * Onto the same report as every Claude call and every board.
 *
 * Written to `activity_log` for the reason the other two recorders give:
 * the audit log already exists, is already org-scoped, and this genuinely
 * is activity. Priced per image or per second rather than per token, so
 * the four token counts are zeroed to keep the row's shape uniform — the
 * usage report reads all four off every row.
 */
async function record(
  ctx: CallContext,
  model: string,
  latencyMs: number,
  error: unknown,
  billed: { images?: number; seconds?: number; cost: number },
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
        images: billed.images ?? 0,
        video_seconds: billed.seconds ?? 0,
        cost_usd: Number(billed.cost.toFixed(6)),
        latency_ms: latencyMs,
        ok: !error,
        error: error ? String((error as Error).message ?? error).slice(0, 500) : null,
      },
    });
  } catch (err) {
    console.error('[ai_usage] could not record a Grok call', (err as Error).message);
  }
}
