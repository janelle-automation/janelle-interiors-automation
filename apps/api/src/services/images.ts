import { DEFAULT_IMAGE_MODEL, IMAGE_MODELS, imageCostUsd, imageModelKind } from '@janelle/shared';
import { env } from '../env.js';
import { resolveOrgId } from '../lib/org.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { AI_USAGE_ACTION, type CallContext } from './anthropic.js';
import { resolveImageAi } from '../lib/aiSettings.js';

/**
 * Rendering a presentation board.
 *
 * Claude writes; it does not draw. A board — the room title, the elevation,
 * the specification column, the swatch row — comes from an image model, and
 * this is the only place in the app that talks to one. The interface is
 * deliberately provider-shaped rather than Gemini-shaped: prompt in,
 * reference images in, one picture out. Swapping providers should be a new
 * function beneath this file's exports, not a change at every call site.
 *
 * What makes the house template enforceable is `references`: the approved
 * board goes in on every render, so "match the Laundry Room board exactly"
 * is a picture the model can see rather than an instruction it can drift
 * away from.
 */

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * What a TEXT model is told, when a studio has one configured instead of an
 * image model.
 *
 * Left to itself it describes the board — headings and bullet points about
 * what the page would contain — because describing is what a text model
 * does. Asked for SVG in as many words, it draws one: flat, illustrated, and
 * with the typography exactly right, which on a specification sheet is most
 * of the value. Photographs it cannot make become labelled placeholders, so
 * the layout is complete and the gaps are obvious.
 */
const AS_VECTOR = `
OUTPUT FORMAT — DRAW IT AS SVG
You cannot return a photograph, so draw the page as a vector document instead.

Return ONLY one complete <svg> element and nothing else: no prose before it, no explanation after it, no code fence.

- Landscape page: viewBox="0 0 1600 1000", with a white or warm-white background rect.
- Set font-family, font-size, fill and text-anchor explicitly on every <text>. A serif for the room title, a clean sans-serif for specifications and labels. Nothing inherits.
- Draw rules and borders as thin <line> or <rect> elements. Keep them hairline and restrained.
- Every specification value, label and note must be real <text>, laid out so nothing overlaps and nothing runs past the page edge. Left-align a column of values on a common x.
- Material swatches: a <rect> filled with that material's actual colour, its name in <text> beneath it.
- Anything that would be a photograph — the elevation, a fixture, a hardware shot — becomes a bordered placeholder <rect> with a light fill and its subject named in <text> at the centre. Never leave an empty area.
- Draw the elevation itself as a simple line drawing: cabinet boxes, counter line, appliances as plain rectangles.
- Dimension lines carry a figure ONLY where one was supplied above. Where none was, draw the line and label it TBD — CONFIRM. Never put a plausible-looking number on a dimension the studio did not give you: an invented measurement is the one mistake this board must not make.`;

/** Gemini takes up to 14; beyond that the request is refused outright. */
const MAX_REFERENCES = 14;

/** Inline data has to fit in the request. Well under Gemini's own ceiling. */
const MAX_REFERENCE_BYTES = 18 * 1024 * 1024;

/** A board is slower than a sentence: Pro routinely runs past half a minute. */
const RENDER_TIMEOUT_MS = Number(process.env.IMAGE_TIMEOUT_MS || 180_000);

export interface ImageReference {
  /** image/png, image/jpeg, image/webp — or application/pdf for a plan sheet. */
  mimeType: string;
  bytes: Buffer;
  /** What this picture IS, named in the prompt so the model can tell them apart. */
  label?: string;
}

export interface RenderResult {
  bytes: Buffer;
  mimeType: string;
  model: string;
  /** Anything the model said alongside the picture — usually what it could not do. */
  note: string | null;
}

export class ImagesNotConfigured extends Error {
  constructor() {
    super('Board rendering is not set up yet — add an image API key in Settings.');
    this.name = 'ImagesNotConfigured';
  }
}

/** Whether this studio can render at all. */
export async function isImageReady(orgId?: string | null): Promise<boolean> {
  const ai = await resolveImageAi(orgId);
  return Boolean(ai.apiKey);
}

/** The models a studio may choose between, with what each costs per board. */
export function imageModels() {
  return IMAGE_MODELS;
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  inline_data?: { mime_type?: string; data?: string };
}

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
}

/** The picture out of a response, whichever casing the API used. */
function imagePart(parts: GeminiPart[]): { mimeType: string; data: string } | null {
  for (const p of parts) {
    const inline = p.inlineData ?? p.inline_data;
    if (!inline) continue;
    const mimeType = (p.inlineData?.mimeType ?? p.inline_data?.mime_type) || 'image/png';
    const data = inline.data;
    if (data) return { mimeType, data };
  }
  return null;
}

/**
 * An SVG page written as text.
 *
 * The text models answer "draw this" with vector markup rather than with a
 * raster image — a real drawing, and the one kind of picture that gets the
 * typography exactly right, which on a specification board is most of the
 * job. Taken whenever no raster part came back, so a studio without image
 * billing still gets a board.
 */
function svgOf(text: string | null): string | null {
  if (!text) return null;
  const start = text.indexOf('<svg');
  const end = text.lastIndexOf('</svg>');
  if (start === -1 || end === -1 || end < start) return null;
  const svg = text.slice(start, end + 6);

  // Model-written, but it is still markup that will be served back to a
  // browser: script and event handlers come out before it is stored.
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, '');
}

function textOf(parts: GeminiPart[]): string | null {
  const said = parts.map((p) => p.text).filter((t): t is string => !!t?.trim()).join('\n').trim();
  return said || null;
}

async function callGemini(
  apiKey: string,
  model: string,
  body: unknown,
): Promise<{ res: Response; json: GeminiResponse }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);
  try {
    const res = await fetch(`${GEMINI_URL}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      // In the header rather than the query string: a key in a URL ends up
      // in logs and proxies.
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => ({}))) as GeminiResponse;
    return { res, json };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Render one board.
 *
 * Every attempt lands on the spend report, successful or not — a render that
 * failed still cost time, and a studio wondering why the month looks
 * expensive should be able to see the failures too.
 */
export async function renderImage(
  prompt: string,
  references: ImageReference[],
  ctx: CallContext,
): Promise<RenderResult> {
  const ai = await resolveImageAi(ctx.orgId);
  if (!ai.apiKey) throw new ImagesNotConfigured();

  const usable = references
    .filter((r) => r.bytes.length > 0 && r.bytes.length <= MAX_REFERENCE_BYTES)
    .slice(0, MAX_REFERENCES);

  // The references are unlabelled bytes to the model unless the prompt says
  // what they are and in what order they arrive.
  const manifest = usable.length
    ? `\n\nREFERENCE IMAGES, in order:\n${usable
        .map((r, i) => `${i + 1}. ${r.label ?? 'reference image'}`)
        .join('\n')}`
    : '';

  // An image model gets the prompt as written; a text model is told to draw
  // instead of describe, or it answers with an outline of the board.
  const drawsRaster = imageModelKind(ai.model || DEFAULT_IMAGE_MODEL) === 'raster';
  const parts: unknown[] = [{ text: prompt + manifest + (drawsRaster ? '' : `\n${AS_VECTOR}`) }];
  for (const r of usable) {
    parts.push({ inline_data: { mime_type: r.mimeType, data: r.bytes.toString('base64') } });
  }

  const model = ai.model || DEFAULT_IMAGE_MODEL;
  const request = (modalities: string[]) => ({
    contents: [{ role: 'user', parts }],
    generationConfig: { responseModalities: modalities },
  });

  // A text model asked for IMAGE only answers with an empty body; asked for
  // both, it writes the page as SVG. The image models are happy either way,
  // so both go out as TEXT+IMAGE and whichever comes back is used.
  const started = Date.now();
  try {
    let { res, json } = await callGemini(ai.apiKey, model, request(['TEXT', 'IMAGE']));

    // Some models reject the pairing and want one modality named. Cheap to
    // try the other way round rather than fail on a config detail.
    if (!res.ok && /responseModalities|modalit/i.test(json.error?.message ?? '')) {
      ({ res, json } = await callGemini(ai.apiKey, model, request(['IMAGE'])));
    }

    if (!res.ok) {
      const message = json.error?.message ?? `Image API returned ${res.status}`;

      // Worth naming, because the provider's own wording sends people to a
      // rate-limit page when the real answer is that image generation has no
      // free tier at all: every image model reports limit 0 until the Google
      // project behind the key has billing enabled.
      if (res.status === 429 || /quota|RESOURCE_EXHAUSTED/i.test(message)) {
        throw new Error(
          'The image account has no quota left. Image generation has no free tier — enable billing on the Google ' +
            'Cloud project behind this API key (AI Studio → your key → project), then try again.',
        );
      }

      throw new Error(
        res.status === 404
          ? `${message} — check the image model id "${model}" (Settings, or GEMINI_IMAGE_MODEL).`
          : message,
      );
    }

    const blocked = json.promptFeedback?.blockReason;
    if (blocked) throw new Error(`The image request was blocked (${blocked}).`);

    const parted = json.candidates?.[0]?.content?.parts ?? [];
    const said = textOf(parted);
    const picture = imagePart(parted);

    if (picture) {
      await record(ctx, model, Date.now() - started, null);
      return {
        bytes: Buffer.from(picture.data, 'base64'),
        mimeType: picture.mimeType,
        model,
        note: said,
      };
    }

    const svg = svgOf(said);
    if (svg) {
      await record(ctx, model, Date.now() - started, null);
      return {
        bytes: Buffer.from(svg, 'utf8'),
        mimeType: 'image/svg+xml',
        model,
        note: 'Drawn as vector rather than photographed — the type is exact, the imagery is illustrated.',
      };
    }

    if (!parted.length) {
      throw new Error(
        `"${model}" returned nothing. It is a text model: ask it for IMAGE only and it has no image to give. ` +
          'Use an image model, or leave it to answer in words.',
      );
    }
    // A model that answers in words when asked for a picture has usually
    // refused; its own sentence is the most useful error we can give.
    throw new Error(said ? `No image came back: ${said.slice(0, 300)}` : 'No image came back.');
  } catch (err) {
    await record(ctx, model, Date.now() - started, err);
    if ((err as Error).name === 'AbortError') {
      throw new Error('The board took longer than the time limit to render. Try again, or use the Flash model while iterating.');
    }
    throw err;
  }
}

/**
 * Onto the same spend report as every Claude call.
 *
 * Written to `activity_log` for the same reason the Claude recorder is: a
 * table of its own would need DDL, and this genuinely is activity. Priced
 * per image rather than per token, which is why `cost_usd` is computed here
 * instead of from a token count.
 */
async function record(
  ctx: CallContext,
  model: string,
  latencyMs: number,
  error: unknown,
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
        // The usage report reads these four off every row; a render has no
        // tokens, and zeroes keep it from having to special-case the shape.
        input_tokens: 0,
        output_tokens: 0,
        cache_write_tokens: 0,
        cache_read_tokens: 0,
        images: error ? 0 : 1,
        cost_usd: error ? 0 : Number(imageCostUsd(model).toFixed(6)),
        latency_ms: latencyMs,
        ok: !error,
        error: error ? String((error as Error).message ?? error).slice(0, 500) : null,
      },
    });
  } catch (err) {
    console.error('[ai_usage] could not record render', (err as Error).message);
  }
}
