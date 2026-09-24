import { createMessage, extractJson, firstJson, type CallContext } from './anthropic.js';
import { editWithCloudflare, renderWithCloudflare } from './cloudflare.js';
import type { ImageReference, RenderResult } from './images.js';

/**
 * A floor plan, rendered as a furnished top-down plan.
 *
 * Sent to an image-editing model like a room photo, a plan came back as a
 * mash-up: rooms painted in perspective inside the drawing, and every label
 * redrawn as gibberish — image models cannot write. So a plan is handled on
 * its own terms:
 *
 *  1. The model renders the SAME plan, straight down, with floors, furniture
 *     and shadows — and is told to leave out every word and number.
 *  2. The original drawing is laid back on top in `multiply`: its white is
 *     transparent, its lines and lettering stay exactly as the architect
 *     drew them. The labels are the studio's own, character for character.
 */

const NAMED_A_PLAN = /\b(floor ?plans?|flooring (sketch|plan|layout)|floor (sketch|layout)|blue ?prints?|site plan|house plan|layout plan)\b/i;

const CLAUDE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * Whether the attachment is an architectural plan rather than a photograph.
 *
 * Said in the brief, it is taken at its word. Otherwise Claude looks — one
 * short call, and only for an attached picture on its way to be edited.
 */
export async function isFloorPlan(brief: string, source: ImageReference, ctx: CallContext): Promise<boolean> {
  if (NAMED_A_PLAN.test(brief)) return true;
  if (!CLAUDE_IMAGE_TYPES.has(source.mimeType) || source.bytes.length > 5 * 1024 * 1024) return false;
  try {
    const message = await createMessage(
      { ...ctx, feature: ctx.feature },
      {
        max_tokens: 60,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: source.mimeType as 'image/png', data: source.bytes.toString('base64') } },
              {
                type: 'text',
                text: 'Is this image an architectural floor plan or site plan drawn from directly above (walls as lines, rooms labelled), rather than a photograph or perspective view of a space? Reply with JSON only: {"floor_plan": true} or {"floor_plan": false}.',
              },
            ],
          },
        ],
      },
      { timeoutMs: 12_000 },
    );
    const text = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return firstJson<{ floor_plan?: boolean }>(text)?.floor_plan === true;
  } catch (err) {
    console.warn('[floorplan] could not tell whether the attachment is a plan:', (err as Error).message);
    return false;
  }
}

// ── Room by room ────────────────────────────────────────────

/** One room as the plan draws it — what a perspective render is made from. */
export interface PlanRoom {
  name: string;
  /** As written on the plan, e.g. 14'0" x 16'0"; null when unlabelled. */
  size: string | null;
  /** What the plan shows in it: the island and its stools, the tub, the fireplace. */
  details: string;
}

export interface PlanReading {
  /** One look for the whole house, so the rooms read as the same home. */
  style: string;
  rooms: PlanRoom[];
}

/** A room's perspective rendering, ready to store. */
export interface RoomRender extends RenderResult {
  room: PlanRoom;
}

/** How many rooms one request renders — each is a separate free-allowance image. */
export const MAX_ROOM_RENDERS = 6;

const READ_PLAN = `You read architectural floor plans for an interior designer.

Return JSON: {"style": string, "rooms": [{"name": string, "size": string|null, "details": string}]}

- "style": one sentence of design direction for the WHOLE house — materials, palette, mood. Take it from the designer's request; if it names no style, use "warm contemporary, natural materials, soft neutral palette".
- "rooms": the key living spaces worth seeing in perspective, most important first, at most ${MAX_ROOM_RENDERS}: kitchen, living room, dining room, primary/master bedroom, primary bathroom, other bedrooms. Skip garages, closets, pantries, laundry, hallways, porches and patios UNLESS the request names them.
- "name": as labelled on the plan (e.g. "Kitchen", "Master Bedroom").
- "size": the dimensions as written on the plan (e.g. 14'0" x 16'0"), or null if none is written.
- "details": one short sentence of what the plan shows in that room and where the windows are — e.g. "4' x 9' island with four barstools, sink under the window wall". Nothing the plan does not show.`;

/** Claude reads the drawing: which rooms, how big, what is in them. */
export async function readPlanRooms(
  brief: string,
  source: ImageReference,
  ctx: CallContext,
  timeoutMs: number,
): Promise<PlanReading | null> {
  if (!CLAUDE_IMAGE_TYPES.has(source.mimeType) || source.bytes.length > 5 * 1024 * 1024) return null;
  const reading = await extractJson<PlanReading>(
    READ_PLAN,
    [
      { type: 'image', source: { type: 'base64', media_type: source.mimeType as 'image/png', data: source.bytes.toString('base64') } },
      { type: 'text', text: `The designer's request: ${brief.slice(0, 1500)}` },
    ],
    ctx,
    timeoutMs,
  );
  if (!reading || !Array.isArray(reading.rooms) || !reading.rooms.length) return null;
  return {
    style: String(reading.style || 'warm contemporary, natural materials, soft neutral palette').slice(0, 300),
    rooms: reading.rooms.slice(0, MAX_ROOM_RENDERS).map((r) => ({
      name: String(r.name ?? 'Room').slice(0, 40),
      size: r.size ? String(r.size).slice(0, 24) : null,
      details: String(r.details ?? '').slice(0, 240),
    })),
  };
}

/**
 * Every room at once, in parallel — the free allowance does not mind, and
 * one after another would not fit in a request. A room that fails is left
 * out rather than failing the rest.
 */
export async function renderPlanRooms(
  reading: PlanReading,
  ctx: CallContext,
  timeoutMs: number,
): Promise<RoomRender[]> {
  const results = await Promise.allSettled(
    reading.rooms.map(async (room): Promise<RoomRender> => {
      const prompt =
        `Photorealistic eye-level interior photograph of the ${room.name.toLowerCase()} of a single-family home` +
        (room.size ? `, a room of ${room.size}` : '') +
        `. ${room.details} Design: ${reading.style}. ` +
        'High-end interior photography, 24mm lens, realistic proportions, soft natural daylight, natural shadows, uncluttered. ' +
        'Do not draw any text, labels, watermarks or dimension figures into the image.';
      const drawn = await renderWithCloudflare(prompt, ctx, { timeoutMs });
      return { ...drawn, room };
    }),
  );
  return results.flatMap((r) => {
    if (r.status === 'fulfilled') return [r.value];
    console.warn('[floorplan] a room render failed:', (r.reason as Error)?.message);
    return [];
  });
}

/** The render instruction. The studio's own words steer the look. */
function planPrompt(brief: string): string {
  return `Render this exact architectural floor plan as a high-end, photorealistic, top-down furnished floor plan for a real-estate brochure. Orthographic view looking straight down. Keep every wall, door, window, room shape, room position, the dimension lines and the overall proportions exactly as drawn — do not move, add or remove any wall.
REMOVE ALL TEXT: no words, no letters, no numbers, no room names, no measurements anywhere in the image — leave those areas as clean floor.
Fill each room with realistic textures and furniture seen from directly above, matching the furniture already sketched and the room's use: wood plank flooring in living areas, bedrooms and halls; stone or tile in bathrooms and laundry; polished concrete in a garage; stone pavers on porches and patios. Beds with soft linen, upholstered sofas, dining tables with chairs, kitchen cabinets and islands with stone tops, white bathroom fixtures, cars in a garage, a few potted plants. Soft natural shadows, clean white background outside the building.

The studio's design direction — apply it to the materials, colours and furniture style: ${brief.slice(0, 900)}`;
}

function dimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
      }
      i += 2 + bytes.readUInt16BE(i + 2);
    }
  }
  return { width: 1600, height: 1000 };
}

/**
 * Render the plan, then put the architect's own drawing back on top.
 *
 * SVG because it has to hold both pictures and blend them; the rendering is
 * stretched to the drawing's exact size so the two line up.
 */
export async function renderFloorPlan(
  brief: string,
  source: ImageReference,
  ctx: CallContext,
  options?: { timeoutMs?: number },
): Promise<RenderResult> {
  const rendered = await editWithCloudflare(planPrompt(brief), source, ctx, options);
  const { width, height } = dimensions(source.bytes);
  const href = (bytes: Buffer, type: string) => `data:${type};base64,${bytes.toString('base64')}`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="#ffffff"/>` +
    `<image href="${href(rendered.bytes, rendered.mimeType)}" width="${width}" height="${height}" preserveAspectRatio="none"/>` +
    // The drawing itself, multiplied: white vanishes, lines and lettering stay.
    `<image href="${href(source.bytes, source.mimeType)}" width="${width}" height="${height}" preserveAspectRatio="none" style="mix-blend-mode:multiply"/>` +
    `</svg>`;
  return {
    bytes: Buffer.from(svg, 'utf8'),
    mimeType: 'image/svg+xml',
    model: rendered.model,
    note: 'A furnished rendering of the attached floor plan. The walls, labels and dimensions are the original drawing’s; furniture and finishes are illustrative.',
    plan: true,
  };
}
