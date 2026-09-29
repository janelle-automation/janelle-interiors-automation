import sharp from 'sharp';
import { extractJson, type CallContext } from './anthropic.js';
import type { ImageReference } from './images.js';

/**
 * A floor plan drawn from a room list, with no plan to edit.
 *
 * `floorPlan.ts` furnishes an EXISTING drawing — a photograph or PDF of a
 * real architect's plan — because an image model can lay AI texture over
 * real walls and real lettering, but cannot be trusted to invent either
 * (see that file's own note: "image models cannot write"). A designer who
 * has no drawing yet, only a room list with sizes, had no way into that
 * pipeline at all: asked for a picture from words, every provider is told
 * `Do not draw any text, labels, watermarks or dimension figures` — so the
 * room names and measurements the designer typed never appeared anywhere
 * in the result, no matter how precisely they were given.
 *
 * This closes that gap the same way `floorPlan.ts` closes its own, split on
 * the one thing an image model genuinely cannot do rather than on how much
 * of the design is "AI": Claude designs the ENTIRE layout — every room's
 * actual position, not just which rooms sit together — because that is a
 * real design judgement call, and a language model is the right tool for
 * it. What this file's own code does is narrower and non-negotiable: draw
 * whatever Claude designed as real text and real lines, because an image
 * model cannot spell a room name or hold a dimension steady, no matter how
 * good its layout sense is. Nothing here repositions, rescales or
 * "corrects" a room Claude placed — the drawing is Claude's plan, exactly,
 * lettered precisely rather than approximately.
 *
 * The result is drawn as a real blueprint (real text, real dimension
 * lines, a real room-dimensions table) and handed to `renderFloorPlan`
 * exactly as an uploaded drawing would be: furnished by the image model,
 * then the blueprint's own lines and lettering composited back on top,
 * character for character.
 */

export interface LayoutRoom {
  name: string;
  /** The room's own top-left corner, in feet, in one shared coordinate space for the whole drawing. */
  x: number;
  y: number;
  /** Left-right size, in feet. */
  widthFt: number;
  /** Front-back size, in feet. */
  depthFt: number;
  /** Inside the main conditioned house the stated footprint describes — false for a garage, porch, patio, deck or balcony. */
  core: boolean;
  /** As stated in a flooring schedule, e.g. "600×1200mm porcelain tile"; null when the brief names none for this room. */
  flooring: string | null;
}

export interface PlannedFloorPlan {
  title: string;
  /** The overall footprint Claude was designing toward, in feet — read from the brief when it states one. Display uses the geometry's own measured footprint instead (see computeFloorPlanGeometry), so a label never disagrees with what is actually drawn. */
  widthFt: number;
  depthFt: number;
  rooms: LayoutRoom[];
}

const PLAN_LAYOUT = `You design a real, buildable single-story floor plan layout from a designer's room list — actual room positions, not just which rooms sit together.

Return JSON: {"title": string, "widthFt": number, "depthFt": number, "rooms": [{"name": string, "x": number, "y": number, "widthFt": number, "depthFt": number, "core": boolean, "flooring": string|null}]}

- "title": a short building description, e.g. "Single Story Residence" — the home type the brief names.
- Top-level "widthFt"/"depthFt": the overall footprint of the MAIN house. Read it straight from the brief if it states one (e.g. "60 ft wide x 45 ft deep" -> 60, 45); otherwise estimate a reasonable one from the rooms listed. This is your own design target, not read back afterward — aim the "core" rooms' combined footprint close to it.
- Every room the brief lists becomes exactly one entry — never invent a room, never drop one. A room named only in a flooring schedule (material and size, no room dimensions) is still one entry, not skipped for lacking a "W x D".
- "widthFt"/"depthFt" per room: read each room's own "W x D" as given, "widthFt" its left-right size and "depthFt" its front-to-back size. When the brief gives no size for a room — most often because it only lists flooring materials by room, not room dimensions — choose a plausible size for a home of the stated overall footprint (living/dining larger, a bathroom or utility room small).
- "x"/"y": the room's own top-left corner, in feet, in ONE shared coordinate space for the whole drawing — (0,0) is the main house's own top-left corner, x increases rightward, y increases toward the back of the house.
- Design an actual buildable layout, the way a real architect would arrange these rooms, not a grid: no two rooms may ever overlap, and touching rooms should share a wall exactly (one room's right edge equal to its neighbour's left edge) rather than leaving an unexplained gap. Cluster rooms the way a home actually works — an entry leading into living/dining, a kitchen near dining, bedrooms grouped together each near a bathroom, a hallway threading between them wherever rooms are not directly adjacent. Vary room shapes and the layout's overall footprint sensibly instead of forcing every room into uniform rows.
- "core": true for every room inside the main conditioned house the overall footprint describes; false for a garage, porch, patio, deck or balcony — place it at whatever x/y sits naturally beside the main house (negative x/y, or past the main footprint, is fine for these).
- "flooring": the flooring material and size for this room, exactly as a flooring schedule in the brief states it (e.g. "600×1200mm porcelain tile", "300×300mm anti-skid tile"), or null when the brief gives none for that room.`;

/** Claude designs the whole layout; nothing here moves a room it placed. */
export async function planFloorLayout(
  brief: string,
  ctx: CallContext,
  timeoutMs: number,
): Promise<PlannedFloorPlan | null> {
  const plan = await extractJson<PlannedFloorPlan>(PLAN_LAYOUT, brief.slice(0, 4000), ctx, timeoutMs);
  if (!plan || !Array.isArray(plan.rooms) || !plan.rooms.length) return null;
  const rooms = plan.rooms
    .map((r) => ({
      name: String(r.name ?? 'Room').slice(0, 40),
      x: Number(r.x) || 0,
      y: Number(r.y) || 0,
      widthFt: Number(r.widthFt) || 0,
      depthFt: Number(r.depthFt) || 0,
      core: r.core !== false,
      flooring: r.flooring ? String(r.flooring).slice(0, 60) : null,
    }))
    .filter((r) => r.widthFt > 0 && r.depthFt > 0 && Number.isFinite(r.x) && Number.isFinite(r.y));
  if (!rooms.length) return null;
  return {
    title: String(plan.title || 'Single Story Residence').slice(0, 60),
    widthFt: Number(plan.widthFt) || 40,
    depthFt: Number(plan.depthFt) || 30,
    rooms,
  };
}

// ── Turn Claude's design into drawing coordinates ──────────────

export interface PositionedRoom {
  name: string;
  statedWidthFt: number;
  statedDepthFt: number;
  /** Position and size, in feet, in the shared drawing space — Claude's own numbers, untouched. */
  x: number;
  y: number;
  w: number;
  h: number;
  flooring?: string | null;
}

export interface FloorPlanGeometry {
  rooms: PositionedRoom[];
  /** The main house's own footprint, in feet — the "core" rooms' own combined bounding box, measured from where Claude actually placed them. */
  main: { x: number; y: number; w: number; h: number };
  /** Everything Claude placed, core rooms plus any garage, porch or patio. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/**
 * A straight readout of Claude's own layout — no packing, no rescaling, no
 * invented filler. The only arithmetic here is measuring what Claude
 * actually placed, so the dimension lines drawn around it are always true
 * to the picture rather than to a number Claude merely aimed for.
 */
export function computeFloorPlanGeometry(plan: PlannedFloorPlan): FloorPlanGeometry {
  const rooms: PositionedRoom[] = plan.rooms.map((r) => ({
    name: r.name,
    statedWidthFt: r.widthFt,
    statedDepthFt: r.depthFt,
    x: r.x,
    y: r.y,
    w: r.widthFt,
    h: r.depthFt,
    flooring: r.flooring,
  }));

  const core = plan.rooms.filter((r) => r.core);
  const span = (list: LayoutRoom[]) => ({
    minX: Math.min(...list.map((r) => r.x)),
    minY: Math.min(...list.map((r) => r.y)),
    maxX: Math.max(...list.map((r) => r.x + r.widthFt)),
    maxY: Math.max(...list.map((r) => r.y + r.depthFt)),
  });
  const coreSpan = core.length ? span(core) : { minX: 0, minY: 0, maxX: plan.widthFt, maxY: plan.depthFt };
  const main = { x: coreSpan.minX, y: coreSpan.minY, w: coreSpan.maxX - coreSpan.minX, h: coreSpan.maxY - coreSpan.minY };

  const all = span(plan.rooms);
  const bounds = { minX: all.minX, minY: all.minY, maxX: all.maxX, maxY: all.maxY };

  return { rooms, main, bounds };
}

// ── Draw Claude's layout as a real blueprint ───────────────────

const PX_PER_FT = 22;
const TABLE_WIDTH = 340;
const MARGIN = 90;

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** "8' x 10'" — whole feet, the same shorthand every room in the brief was given in. */
function ftLabel(ft: number): string {
  return `${Math.round(ft)}'`;
}
function sizeLabel(w: number, d: number): string {
  return `${ftLabel(w)} x ${ftLabel(d)}`;
}

/**
 * A furniture/fixture symbol for what the room is, drawn from its name.
 *
 * The furnish pass downstream is told to fill each room with "furniture
 * already sketched" — plausible on a real architect's drawing, which
 * always has some, and wrong for a bare labelled rectangle. Without an
 * icon here it had nothing to go on once this schematic's own text is
 * stripped for that pass, and guessed from shape alone: a bed in the
 * garage, a car in the walk-in closet. A schematic symbol is a shape, not
 * text, so it draws safely — the "image models cannot write" problem
 * this whole file exists to avoid never applies to a rectangle or a line.
 */
function furnitureIcon(name: string, x: number, y: number, w: number, h: number): string {
  const n = name.toLowerCase();
  const S = '#111111';
  const F = '#e9e9e9';
  const line = (x1: number, y1: number, x2: number, y2: number) =>
    `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${S}" stroke-width="1.5"/>`;
  const rect = (rx: number, ry: number, rw: number, rh: number, fill = F, rd = 3) =>
    `<rect x="${rx.toFixed(1)}" y="${ry.toFixed(1)}" width="${rw.toFixed(1)}" height="${rh.toFixed(1)}" rx="${rd}" fill="${fill}" stroke="${S}" stroke-width="1.3"/>`;
  const circle = (cx: number, cy: number, r: number, fill = F) =>
    `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${fill}" stroke="${S}" stroke-width="1.3"/>`;
  const pad = Math.min(w, h) * 0.08;
  const ix = x + pad;
  const iy = y + pad;
  const iw = w - pad * 2;
  const ih = h - pad * 2;
  if (iw < 12 || ih < 12) return '';

  // Bed: headboard against the shorter wall, two pillows, a throw at the foot.
  if (/bedroom|\bbed\b/.test(n) && !/wic|closet/.test(n)) {
    const bw = Math.min(iw * 0.75, ih * 0.6);
    const bh = Math.min(ih * 0.75, iw * 0.9);
    const bx = ix + (iw - bw) / 2;
    const by = iy + pad;
    return (
      rect(bx, by, bw, bh, '#f4efe8') +
      rect(bx + bw * 0.08, by + bh * 0.04, bw * 0.36, bh * 0.18, '#ffffff') +
      rect(bx + bw * 0.56, by + bh * 0.04, bw * 0.36, bh * 0.18, '#ffffff') +
      rect(bx, by + bh * 0.7, bw, bh * 0.22, '#ddd6c8')
    );
  }
  // Bath: tub along the back wall, a sink circle, a small toilet oval.
  if (/\bbath/.test(n)) {
    return (
      rect(ix, iy, iw * 0.42, ih * 0.9, '#ffffff') +
      circle(ix + iw * 0.65, iy + ih * 0.22, Math.min(iw, ih) * 0.11) +
      rect(ix + iw * 0.55, iy + ih * 0.55, iw * 0.28, ih * 0.32, '#ffffff', 8)
    );
  }
  // Kitchen (not the island, not the pantry): an L counter, a stove.
  if (/kitchen/.test(n) && !/island|pantry/.test(n)) {
    return (
      rect(ix, iy, iw, ih * 0.22, '#e2e2e2') +
      rect(ix, iy, iw * 0.2, ih, '#e2e2e2') +
      rect(ix + iw * 0.06, iy + ih * 0.06, iw * 0.1, ih * 0.1, '#ffffff')
    );
  }
  if (/island/.test(n)) return rect(ix, iy + ih * 0.2, iw, ih * 0.6, '#e2e2e2');
  if (/pantry/.test(n)) return [0.2, 0.45, 0.7].map((f) => line(ix, iy + ih * f, ix + iw, iy + ih * f)).join('');
  if (/laundry/.test(n)) return rect(ix, iy, iw * 0.42, ih * 0.6, '#e2e2e2') + rect(ix + iw * 0.5, iy, iw * 0.42, ih * 0.6, '#e2e2e2');
  // Living room: an L sofa, a coffee table.
  if (/living/.test(n)) {
    return (
      rect(ix, iy, iw * 0.6, ih * 0.3, '#e5ddd0') +
      rect(ix, iy, iw * 0.22, ih * 0.7, '#e5ddd0') +
      rect(ix + iw * 0.3, iy + ih * 0.5, iw * 0.3, ih * 0.22, '#ffffff')
    );
  }
  // Dining, porch or patio: a table with chairs around it.
  if (/dining|porch|patio/.test(n)) {
    const tw = iw * 0.5;
    const th = ih * 0.35;
    const tx = ix + (iw - tw) / 2;
    const ty = iy + (ih - th) / 2;
    const chair = (cx: number, cy: number) => rect(cx - 5, cy - 5, 10, 10, '#ffffff');
    return (
      rect(tx, ty, tw, th, '#ffffff', 6) +
      chair(tx + tw * 0.2, ty - 8) +
      chair(tx + tw * 0.8, ty - 8) +
      chair(tx + tw * 0.2, ty + th + 8) +
      chair(tx + tw * 0.8, ty + th + 8)
    );
  }
  // Garage: one car per stall the width allows, two abreast at most. A
  // garage is rarely drawn as a single-car box at this size, so a near
  // square or wider room reads as two stalls, not one.
  //
  // Wheels at the four corners are what make this read as a car rather
  // than a second bed — a plain rounded rectangle here and the bed icon
  // above are otherwise the same shape, and the furnish pass drew a bed
  // in the garage before this had anything to tell the two apart.
  if (/garage/.test(n)) {
    const stalls = iw > ih * 0.85 ? 2 : 1;
    const cw = iw / stalls;
    let out = '';
    for (let i = 0; i < stalls; i++) {
      const bx = ix + cw * i + cw * 0.16;
      const bw = cw * 0.68;
      const by = iy + pad * 2;
      const bh = ih - pad * 4;
      const wheelW = Math.min(bw * 0.16, 10);
      const wheelH = Math.min(bh * 0.1, 16);
      out +=
        rect(bx, by, bw, bh, '#dedede', bw * 0.3) +
        rect(bx + bw * 0.15, by + bh * 0.14, bw * 0.7, bh * 0.22, '#b9c7d6', 4) + // windshield
        [0.08, 0.92].map((f) => rect(bx - wheelW * 0.4, by + bh * f - wheelH / 2, wheelW, wheelH, '#333333', 2)).join('') +
        [0.08, 0.92].map((f) => rect(bx + bw - wheelW * 0.6, by + bh * f - wheelH / 2, wheelW, wheelH, '#333333', 2)).join('');
    }
    return out;
  }
  // Walk-in closet: a hanging rod along the back wall, drawn as ticks.
  if (/closet|\bwic\b/.test(n)) {
    const rodY = iy + ih * 0.18;
    const ticks: string[] = [line(ix, rodY, ix + iw, rodY)];
    for (let f = 0.1; f < 1; f += 0.14) ticks.push(line(ix + iw * f, rodY, ix + iw * f, rodY + ih * 0.12));
    return ticks.join('');
  }
  // Entry or foyer: a mat.
  if (/entry|foyer/.test(n)) return rect(ix + iw * 0.15, iy + ih * 0.15, iw * 0.7, ih * 0.7, '#e5ddd0');
  return '';
}

const MM_PER_FT = 304.8;
// Dark enough to still read crossing a furniture icon's own light fill
// (icons use tones like #e5ddd0, #f4efe8) — #cfcfcf all but vanished there.
const TILE_STROKE = '#a8a8a8';

/** A tile's long and short edge, in feet, read from "600×1200 mm ... tile" — or null when the brief states no size. */
function parseTileFt(flooring: string | null | undefined): { longFt: number; shortFt: number; wood: boolean } | null {
  if (!flooring) return null;
  const m = flooring.match(/(\d+(?:\.\d+)?)\s*[×x]\s*(\d+(?:\.\d+)?)\s*mm/i);
  if (!m) return null;
  const a = Number(m[1]) / MM_PER_FT;
  const b = Number(m[2]) / MM_PER_FT;
  if (!(a > 0) || !(b > 0)) return null;
  return { longFt: Math.max(a, b), shortFt: Math.min(a, b), wood: /wood/i.test(flooring) };
}

/**
 * A room's floor, drawn as real tile or plank joints rather than left for an
 * image model to invent — the exact material size and lay direction the
 * brief's flooring schedule states, guaranteed by arithmetic rather than
 * hoped for from a prompt. The tile's long edge runs along the room's own
 * longer axis, and a wood finish also gets the row-to-row stagger a strip
 * floor is laid with — everything else lays in a plain aligned grid.
 */
function floorPattern(x: number, y: number, w: number, h: number, tile: { longFt: number; shortFt: number; wood: boolean }): string {
  const long = tile.longFt * PX_PER_FT;
  const short = tile.shortFt * PX_PER_FT;
  // Too fine to read as anything but noise at this drawing's scale.
  if (long < 5 || short < 5) return '';
  const alongIsX = w >= h;
  const alongLen = alongIsX ? w : h;
  const acrossLen = alongIsX ? h : w;
  const rows = Math.max(1, Math.round(acrossLen / short));
  const rowH = acrossLen / rows;

  const acrossLine = (at: number) =>
    alongIsX
      ? `<line x1="${x.toFixed(1)}" y1="${(y + at).toFixed(1)}" x2="${(x + w).toFixed(1)}" y2="${(y + at).toFixed(1)}" stroke="${TILE_STROKE}" stroke-width="0.7"/>`
      : `<line x1="${(x + at).toFixed(1)}" y1="${y.toFixed(1)}" x2="${(x + at).toFixed(1)}" y2="${(y + h).toFixed(1)}" stroke="${TILE_STROKE}" stroke-width="0.7"/>`;
  const alongLine = (at: number, from: number, to: number) =>
    alongIsX
      ? `<line x1="${(x + at).toFixed(1)}" y1="${(y + from).toFixed(1)}" x2="${(x + at).toFixed(1)}" y2="${(y + to).toFixed(1)}" stroke="${TILE_STROKE}" stroke-width="0.7"/>`
      : `<line x1="${(x + from).toFixed(1)}" y1="${(y + at).toFixed(1)}" x2="${(x + to).toFixed(1)}" y2="${(y + at).toFixed(1)}" stroke="${TILE_STROKE}" stroke-width="0.7"/>`;

  const lines: string[] = [];
  for (let r = 1; r < rows; r++) lines.push(acrossLine(r * rowH));
  for (let r = 0; r < rows; r++) {
    const from = r * rowH;
    const to = Math.min(acrossLen, from + rowH);
    // Every other row's joints shift half a tile along — a running bond,
    // the way strip wood flooring is actually laid. Everything else keeps
    // every row's joints lined up in a plain grid.
    const offset = tile.wood && r % 2 === 1 ? long / 2 : 0;
    for (let at = offset; at < alongLen - 0.5; at += long) {
      if (at < 0.5) continue;
      lines.push(alongLine(at, from, to));
    }
  }
  return lines.join('');
}

/** A small lettered circle in a room's corner, keyed to the flooring legend. */
function keyBadge(x: number, y: number, letter: string): string {
  const cx = x + 15;
  const cy = y + 15;
  return (
    `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="9" fill="#ffffff" stroke="#111111" stroke-width="1.3"/>` +
    `<text x="${cx.toFixed(1)}" y="${(cy + 3.5).toFixed(1)}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="10" font-weight="700" fill="#111111">${escape(letter)}</text>`
  );
}

function room(r: PositionedRoom, ox: number, oy: number, keyLetter?: string): string {
  const x = ox + r.x * PX_PER_FT;
  const y = oy + r.y * PX_PER_FT;
  const w = r.w * PX_PER_FT;
  const h = r.h * PX_PER_FT;
  const rect = `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="#ffffff" stroke="#111111" stroke-width="3"/>`;
  if (!r.name) return rect;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const tile = parseTileFt(r.flooring);
  const floor = tile ? floorPattern(x, y, w, h, tile) : '';
  // A label wider than its room would spill into the next one; small rooms
  // get the name only; larger ones get the name and the size beneath it.
  const fits = w > 70 && h > 40;
  const icon = fits ? furnitureIcon(r.name, x, y, w, h) : '';
  const upper = r.name.toUpperCase();
  // A rough monospace-ish estimate is enough to keep a narrow room's name
  // (a 4'-wide kitchen island beside a 14'-wide kitchen) from running past
  // its own walls — the actual glyph widths need not be exact here.
  const nameSize = Math.max(8, Math.min(13, (w * 0.92) / (upper.length * 0.62)));
  const label = `<text x="${cx.toFixed(1)}" y="${(cy - (fits ? 6 : 0)).toFixed(1)}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${nameSize.toFixed(1)}" font-weight="700" letter-spacing="0.4" fill="#111111">${escape(upper)}</text>`;
  const size = fits
    ? `<text x="${cx.toFixed(1)}" y="${(cy + 12).toFixed(1)}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="11" fill="#555555">${escape(sizeLabel(r.statedWidthFt, r.statedDepthFt))}</text>`
    : '';
  // Small enough that even a compact bathroom or utility room clears it.
  const badge = keyLetter && w > 36 && h > 36 ? keyBadge(x, y, keyLetter) : '';
  // After the icon, not before: a bath's tub and a closet's hanging rod are
  // drawn as solid fills wide enough to hide most of a room's floor — the
  // exact rooms (bath, utility) an anti-skid call-out most needs to read.
  return rect + icon + floor + label + size + badge;
}

/**
 * One letter per distinct flooring call-out, assigned in the order rooms
 * first state it — A, B, C... — so the legend and the room badges agree.
 * Rooms the brief gives no flooring for carry no badge at all.
 */
function keyFlooring(rooms: { flooring?: string | null }[]): Map<string, string> {
  const keys = new Map<string, string>();
  for (const r of rooms) {
    if (!r.flooring || keys.has(r.flooring)) continue;
    keys.set(r.flooring, String.fromCharCode(65 + keys.size));
  }
  return keys;
}

function dimensionLine(x1: number, y1: number, x2: number, y2: number, label: string, vertical: boolean): string {
  const tick = 8;
  const ticks = vertical
    ? `<line x1="${x1 - tick}" y1="${y1}" x2="${x1 + tick}" y2="${y1}" stroke="#111111" stroke-width="1.5"/>` +
      `<line x1="${x2 - tick}" y1="${y2}" x2="${x2 + tick}" y2="${y2}" stroke="#111111" stroke-width="1.5"/>`
    : `<line x1="${x1}" y1="${y1 - tick}" x2="${x1}" y2="${y1 + tick}" stroke="#111111" stroke-width="1.5"/>` +
      `<line x1="${x2}" y1="${y2 - tick}" x2="${x2}" y2="${y2 + tick}" stroke="#111111" stroke-width="1.5"/>`;
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  const text = vertical
    ? `<text x="${midX - 12}" y="${midY}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="13" fill="#111111" transform="rotate(-90 ${midX - 12} ${midY})">${escape(label)}</text>`
    : `<text x="${midX}" y="${midY - 10}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="13" fill="#111111">${escape(label)}</text>`;
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#111111" stroke-width="1.5"/>${ticks}${text}`;
}

/** The blueprint the image model furnishes, and whose lines and lettering come back exactly as drawn here. */
export function renderFloorPlanSvg(
  plan: PlannedFloorPlan,
  geo: FloorPlanGeometry,
): { svg: string; width: number; height: number; drawing: { x: number; y: number; width: number; height: number } } {
  const ox = MARGIN - geo.bounds.minX * PX_PER_FT;
  const oy = MARGIN - geo.bounds.minY * PX_PER_FT;
  const drawingW = (geo.bounds.maxX - geo.bounds.minX) * PX_PER_FT;
  const drawingH = (geo.bounds.maxY - geo.bounds.minY) * PX_PER_FT;
  const width = Math.round(MARGIN + drawingW + MARGIN + TABLE_WIDTH);

  const flooringKeys = keyFlooring(geo.rooms);
  const rooms = geo.rooms.map((r) => room(r, ox, oy, r.flooring ? flooringKeys.get(r.flooring) : undefined)).join('');

  const mainX1 = ox + geo.main.x * PX_PER_FT;
  const mainX2 = ox + (geo.main.x + geo.main.w) * PX_PER_FT;
  const mainY1 = oy + geo.main.y * PX_PER_FT;
  const mainY2 = oy + (geo.main.y + geo.main.h) * PX_PER_FT;
  // The measured "core" footprint, never the brief's stated target — so
  // this label can never disagree with the tick marks it sits beside.
  const topDim = dimensionLine(mainX1, mainY1 - 40, mainX2, mainY1 - 40, `${ftLabel(geo.main.w)}-0"`, false);
  const sideDim = dimensionLine(mainX1 - 40, mainY1, mainX1 - 40, mainY2, `${ftLabel(geo.main.h)}-0"`, true);

  const tableX = MARGIN + drawingW + MARGIN;
  const tableRooms = plan.rooms;
  let ty = 40;
  const tableRows: string[] = [
    `<text x="${tableX}" y="${ty}" font-family="Helvetica, Arial, sans-serif" font-size="15" font-weight="700" letter-spacing="0.5" fill="#111111">ROOM DIMENSIONS</text>`,
  ];
  ty += 14;
  tableRows.push(`<line x1="${tableX}" y1="${ty}" x2="${width - MARGIN / 2}" y2="${ty}" stroke="#111111" stroke-width="1"/>`);
  ty += 24;
  for (const r of tableRooms) {
    tableRows.push(
      `<text x="${tableX}" y="${ty}" font-family="Helvetica, Arial, sans-serif" font-size="12.5" fill="#111111">${escape(r.name)}</text>`,
    );
    tableRows.push(
      `<text x="${width - MARGIN / 2}" y="${ty}" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="12.5" fill="#111111">${escape(sizeLabel(r.widthFt, r.depthFt))}</text>`,
    );
    ty += 22;
  }
  ty += 14;
  tableRows.push(
    `<text x="${tableX}" y="${ty}" font-family="Helvetica, Arial, sans-serif" font-size="15" font-weight="700" letter-spacing="0.5" fill="#111111">OVERALL DIMENSIONS</text>`,
  );
  ty += 14;
  tableRows.push(`<line x1="${tableX}" y1="${ty}" x2="${width - MARGIN / 2}" y2="${ty}" stroke="#111111" stroke-width="1"/>`);
  ty += 24;
  for (const [label, ft] of [['Width', geo.main.w], ['Depth', geo.main.h]] as const) {
    tableRows.push(`<text x="${tableX}" y="${ty}" font-family="Helvetica, Arial, sans-serif" font-size="12.5" fill="#111111">${label}</text>`);
    tableRows.push(
      `<text x="${width - MARGIN / 2}" y="${ty}" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="12.5" fill="#111111">${ftLabel(ft)}-0"</text>`,
    );
    ty += 22;
  }

  // Only when the brief actually named flooring materials — a plain room
  // list with no schedule gets no legend, same layout as before this key.
  if (flooringKeys.size) {
    ty += 14;
    tableRows.push(
      `<text x="${tableX}" y="${ty}" font-family="Helvetica, Arial, sans-serif" font-size="15" font-weight="700" letter-spacing="0.5" fill="#111111">FLOORING LEGEND</text>`,
    );
    ty += 14;
    tableRows.push(`<line x1="${tableX}" y1="${ty}" x2="${width - MARGIN / 2}" y2="${ty}" stroke="#111111" stroke-width="1"/>`);
    ty += 24;
    for (const [material, letter] of [...flooringKeys.entries()].sort((a, b) => a[1].localeCompare(b[1]))) {
      tableRows.push(
        `<circle cx="${tableX + 8}" cy="${(ty - 4).toFixed(1)}" r="8" fill="#ffffff" stroke="#111111" stroke-width="1.2"/>` +
          `<text x="${tableX + 8}" y="${(ty - 0.5).toFixed(1)}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="9.5" font-weight="700" fill="#111111">${escape(letter)}</text>`,
      );
      tableRows.push(
        `<text x="${tableX + 24}" y="${ty}" font-family="Helvetica, Arial, sans-serif" font-size="12" fill="#111111">${escape(material)}</text>`,
      );
      ty += 22;
    }
  }

  // Tall enough for the drawing, or for the side panel's own content plus
  // room for the title block beneath it — whichever needs more.
  const height = Math.round(Math.max(drawingH + MARGIN * 2 + 60, ty + 140, 560));

  const titleBlock = `
<text x="${tableX}" y="${height - 60}" font-family="Georgia, 'Times New Roman', serif" font-size="22" fill="#111111">${escape(plan.title.includes('Floor Plan') ? plan.title : 'FLOOR PLAN')}</text>
<text x="${tableX}" y="${height - 40}" font-family="Helvetica, Arial, sans-serif" font-size="11" letter-spacing="1" fill="#777777">${escape(plan.title.toUpperCase())}</text>`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="#ffffff"/>
${rooms}
${topDim}
${sideDim}
${tableRows.join('\n')}
${titleBlock}
</svg>`;

  // The drawing itself, excluding the side panel and the outer dimension
  // ticks — the region an image model should actually be shown (see
  // sketchFloorPlanFromBrief, which scales this into the rasterised pixels).
  const drawing = { x: MARGIN, y: MARGIN, width: drawingW, height: drawingH };

  return { svg, width, height, drawing };
}

export interface FloorPlanSchematic {
  /** The full schematic — drawing plus the room-dimensions/legend/title panel. */
  image: ImageReference;
  /**
   * Where the actual walled drawing sits within `image`'s own pixels,
   * excluding the side panel — what should be cropped out and sent to an
   * image model for furnishing, so a text-heavy legend a third of the
   * canvas wide never gets mistaken for part of the building.
   */
  drawingRegion: { x: number; y: number; width: number; height: number };
}

/**
 * Claude sorts, this file packs and draws, then the whole picture is
 * rasterised — Cloudflare's edit model takes pixels, not markup.
 */
export async function sketchFloorPlanFromBrief(
  brief: string,
  ctx: CallContext,
  timeoutMs: number,
): Promise<FloorPlanSchematic | null> {
  const plan = await planFloorLayout(brief, ctx, timeoutMs);
  if (!plan) return null;
  const geo = computeFloorPlanGeometry(plan);
  const { svg, width, height, drawing } = renderFloorPlanSvg(plan, geo);
  const bytes = await sharp(Buffer.from(svg), { density: 144 }).png().toBuffer();
  // The nominal SVG units above and the actual raster pixels agree up to a
  // uniform scale (the density); read that scale back from what was
  // actually produced rather than assume it, so this never drifts out of
  // step with whatever DPI sharp used.
  const meta = await sharp(bytes).metadata();
  const scaleX = (meta.width || width) / width;
  const scaleY = (meta.height || height) / height;
  const drawingRegion = {
    x: Math.round(drawing.x * scaleX),
    y: Math.round(drawing.y * scaleY),
    width: Math.round(drawing.width * scaleX),
    height: Math.round(drawing.height * scaleY),
  };
  return {
    image: { mimeType: 'image/png', bytes, label: `${plan.title} — schematic floor plan` },
    drawingRegion,
  };
}
