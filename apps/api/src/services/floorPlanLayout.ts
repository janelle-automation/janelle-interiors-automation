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
 * This closes that gap the same way `floorPlan.ts` closes its own: split
 * what needs to be EXACT from what only needs to be PLAUSIBLE.
 *   1. Claude sorts the room list into rows and wings — a small, discrete
 *      judgement call (which rooms sit together, front to back, left to
 *      right) that a language model is actually reliable at.
 *   2. This file's own arithmetic packs those rooms into a real,
 *      non-overlapping, to-scale rectangle layout — the part an LLM is NOT
 *      reliable at, done instead by code that cannot misplace a wall.
 *   3. The result is drawn as a real blueprint (real text, real dimension
 *      lines, a real room-dimensions table) and handed to
 *      `renderFloorPlan` exactly as an uploaded drawing would be: furnished
 *      by the image model, then the blueprint's own lines and lettering
 *      composited back on top, character for character.
 */

// ── Step 1: Claude sorts the rooms (semantic, not geometric) ──

export type RoomPlacement = 'main' | 'wing_left' | 'wing_right' | 'exterior_front' | 'exterior_rear';

export interface LayoutRoom {
  name: string;
  /** Left-right size, in feet. */
  widthFt: number;
  /** Front-back size, in feet. */
  depthFt: number;
  placement: RoomPlacement;
  /** Main rooms only: 0 is the front-most row, increasing toward the back. */
  row: number;
  /** Left-to-right within a row, or top-to-bottom within a wing/exterior stack. */
  order: number;
}

export interface PlannedFloorPlan {
  title: string;
  /** The stated overall footprint, in feet — the dimension line drawn around the whole house. */
  widthFt: number;
  depthFt: number;
  rooms: LayoutRoom[];
}

const PLAN_LAYOUT = `You sort a designer's room list into an architectural floor plan layout. You do not compute positions — only which rooms sit together.

Return JSON: {"title": string, "widthFt": number, "depthFt": number, "rooms": [{"name": string, "widthFt": number, "depthFt": number, "placement": string, "row": number, "order": number}]}

- "title": a short building description, e.g. "Single Story Residence" — the home type the brief names.
- Top-level "widthFt"/"depthFt": the OVERALL footprint. Read it straight from the brief if it states one (e.g. "60 ft wide x 45 ft deep" -> 60, 45). If it does not, estimate a reasonable overall size from the rooms listed.
- Every room the brief lists becomes exactly one entry — never invent a room, never drop one. Read each room's own "W x D" as given; "widthFt" is its left-right size, "depthFt" its front-to-back size.
- "placement", one of:
  - "main": an enclosed room inside the house's own footprint — bedrooms, bathrooms, kitchen, living/dining, closets, laundry, pantry, a hallway or circulation strip, the entry foyer.
  - "wing_left" / "wing_right": a garage, or anything the brief calls a separate wing or attached to one side. Use the side the brief names; default to "wing_left" when it names neither.
  - "exterior_front" / "exterior_rear": an open, uncovered structure outside the conditioned house — a porch, patio, deck, terrace. Match "front"/"entry" language to "exterior_front", "rear"/"back" language to "exterior_rear".
- "row" (main rooms only; 0 for every other placement): which front-to-back band of the house a room sits in. Group rooms the brief places side by side into the same row — "kitchen, centrally located" beside "bedroom 2" beside "bedroom 3" is one row; "living room, front-left" beside "dining room, adjacent to the entry" beside "entry" is another.
- "order": left-to-right position within its row (main rooms), or top-to-bottom position within its wing/exterior stack (other placements) — 0, 1, 2, ... in the order the brief implies.
- Each row is drawn spanning the FULL overall width, so a row whose rooms add up to much less than it looks wrong — an empty gap, not a floor plan. Put a room's closet, bathroom or pantry in the SAME row as the room it serves rather than a row of its own, so every row reads as a believable full-width slice of the house. A row that still falls short after that is fine — a hallway of ordinary width fills what is left — but a row left mostly empty is not.`;

/** Claude groups the rooms; nothing here computes a single coordinate. */
export async function planFloorLayout(
  brief: string,
  ctx: CallContext,
  timeoutMs: number,
): Promise<PlannedFloorPlan | null> {
  const plan = await extractJson<PlannedFloorPlan>(PLAN_LAYOUT, brief.slice(0, 4000), ctx, timeoutMs);
  if (!plan || !Array.isArray(plan.rooms) || !plan.rooms.length) return null;
  const PLACEMENTS: RoomPlacement[] = ['main', 'wing_left', 'wing_right', 'exterior_front', 'exterior_rear'];
  const rooms = plan.rooms
    .map((r) => ({
      name: String(r.name ?? 'Room').slice(0, 40),
      widthFt: Number(r.widthFt) || 0,
      depthFt: Number(r.depthFt) || 0,
      placement: PLACEMENTS.includes(r.placement) ? r.placement : ('main' as RoomPlacement),
      row: Number.isFinite(r.row) ? Math.max(0, Math.round(r.row)) : 0,
      order: Number.isFinite(r.order) ? Math.max(0, Math.round(r.order)) : 0,
    }))
    .filter((r) => r.widthFt > 0 && r.depthFt > 0);
  if (!rooms.length) return null;
  return {
    title: String(plan.title || 'Single Story Residence').slice(0, 60),
    widthFt: Number(plan.widthFt) || rooms.reduce((s, r) => (r.placement === 'main' ? s + r.widthFt : s), 0) || 40,
    depthFt: Number(plan.depthFt) || 40,
    rooms,
  };
}

// ── Step 2: pack the rooms into real, non-overlapping rectangles ──

export interface PositionedRoom {
  name: string;
  statedWidthFt: number;
  statedDepthFt: number;
  /** Rendered position and size, in feet, in the shared drawing space. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** A filler strip this code added to square off a row — never labelled. */
  isFiller?: boolean;
}

export interface FloorPlanGeometry {
  rooms: PositionedRoom[];
  /** The main house's own footprint, in feet. */
  main: { x: number; y: number; w: number; h: number };
  /** Everything, main house plus wings and exteriors. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/**
 * A row's leftover width becomes a hallway strip only inside this range —
 * a real one. Outside it (too little to read as a corridor, or so much
 * that it would read as a hole in the house) the row is stretched to fit
 * the full width exactly instead: the room LABELS still carry the
 * designer's true stated sizes (the dimension table is never touched),
 * only the drawn rectangles flex, which is the far smaller lie of the
 * two — a floor plan with a blank void in it looks broken outright.
 */
const MIN_CIRCULATION_FT = 3;
const MAX_CIRCULATION_FT = 8;

function packRow(row: LayoutRoom[], y: number, overallWidthFt: number): { rooms: PositionedRoom[]; depth: number } {
  const ordered = [...row].sort((a, b) => a.order - b.order);
  const totalW = ordered.reduce((s, r) => s + r.widthFt, 0);
  const depth = Math.max(...ordered.map((r) => r.depthFt), 1);
  const gap = overallWidthFt - totalW;

  const rooms: PositionedRoom[] = [];
  let x = 0;
  for (const r of ordered) {
    rooms.push({ name: r.name, statedWidthFt: r.widthFt, statedDepthFt: r.depthFt, x, y, w: r.widthFt, h: depth });
    x += r.widthFt;
  }

  if (gap >= MIN_CIRCULATION_FT && gap <= MAX_CIRCULATION_FT) {
    rooms.push({ name: '', statedWidthFt: gap, statedDepthFt: depth, x, y, w: gap, h: depth, isFiller: true });
  } else if (Math.abs(gap) > 0.05 && totalW > 0) {
    // Stretch the row to fit the full width exactly, rather than leave a
    // gap too large to read as a hallway, or run the last room past the
    // wall when the row overflows.
    const scale = overallWidthFt / totalW;
    let sx = 0;
    for (const p of rooms) {
      p.x = sx;
      p.w *= scale;
      sx += p.w;
    }
  }
  return { rooms, depth };
}

function packStack(list: LayoutRoom[]): { rooms: PositionedRoom[]; width: number; height: number } {
  const ordered = [...list].sort((a, b) => a.order - b.order);
  const rooms: PositionedRoom[] = [];
  let y = 0;
  let maxW = 0;
  for (const r of ordered) {
    rooms.push({ name: r.name, statedWidthFt: r.widthFt, statedDepthFt: r.depthFt, x: 0, y, w: r.widthFt, h: r.depthFt });
    y += r.depthFt;
    maxW = Math.max(maxW, r.widthFt);
  }
  return { rooms, width: maxW, height: y };
}

/**
 * The one place geometry gets decided. Deterministic: the same plan
 * always packs to the same rectangles, and no two rooms ever overlap —
 * the thing an LLM asked for raw coordinates cannot promise.
 */
export function computeFloorPlanGeometry(plan: PlannedFloorPlan): FloorPlanGeometry {
  const mainByRow = new Map<number, LayoutRoom[]>();
  for (const r of plan.rooms) {
    if (r.placement !== 'main') continue;
    mainByRow.set(r.row, [...(mainByRow.get(r.row) ?? []), r]);
  }
  const rowKeys = [...mainByRow.keys()].sort((a, b) => a - b);

  const rooms: PositionedRoom[] = [];
  let y = 0;
  for (const key of rowKeys) {
    const { rooms: rowRooms, depth } = packRow(mainByRow.get(key)!, y, plan.widthFt);
    rooms.push(...rowRooms);
    y += depth;
  }
  const mainH = y || 1;

  // Scale the packed depth to match the stated overall depth exactly, so
  // the dimension line drawn around the house is the designer's own
  // number, not this code's running total.
  const depthScale = plan.depthFt / mainH;
  for (const r of rooms) {
    r.y *= depthScale;
    r.h *= depthScale;
  }
  const main = { x: 0, y: 0, w: plan.widthFt, h: plan.depthFt };

  const bounds = { minX: 0, minY: 0, maxX: plan.widthFt, maxY: plan.depthFt };

  const wingLeft = packStack(plan.rooms.filter((r) => r.placement === 'wing_left'));
  for (const r of wingLeft.rooms) {
    r.x -= wingLeft.width;
    rooms.push(r);
  }
  if (wingLeft.rooms.length) bounds.minX = Math.min(bounds.minX, -wingLeft.width);

  const wingRight = packStack(plan.rooms.filter((r) => r.placement === 'wing_right'));
  for (const r of wingRight.rooms) {
    r.x += plan.widthFt;
    rooms.push(r);
  }
  if (wingRight.rooms.length) bounds.maxX = Math.max(bounds.maxX, plan.widthFt + wingRight.width);

  const front = [...plan.rooms.filter((r) => r.placement === 'exterior_front')].sort((a, b) => a.order - b.order);
  let fx = 0;
  let frontDepth = 0;
  for (const r of front) {
    rooms.push({ name: r.name, statedWidthFt: r.widthFt, statedDepthFt: r.depthFt, x: fx, y: -r.depthFt, w: r.widthFt, h: r.depthFt });
    fx += r.widthFt;
    frontDepth = Math.max(frontDepth, r.depthFt);
  }
  if (front.length) bounds.minY = Math.min(bounds.minY, -frontDepth);

  const rear = [...plan.rooms.filter((r) => r.placement === 'exterior_rear')].sort((a, b) => a.order - b.order);
  let rx = 0;
  let rearDepth = 0;
  for (const r of rear) {
    rooms.push({ name: r.name, statedWidthFt: r.widthFt, statedDepthFt: r.depthFt, x: rx, y: plan.depthFt, w: r.widthFt, h: r.depthFt });
    rx += r.widthFt;
    rearDepth = Math.max(rearDepth, r.depthFt);
  }
  if (rear.length) bounds.maxY = Math.max(bounds.maxY, plan.depthFt + rearDepth);

  return { rooms, main, bounds };
}

// ── Step 3: draw it as a real blueprint ────────────────────────

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

function room(r: PositionedRoom, ox: number, oy: number): string {
  const x = ox + r.x * PX_PER_FT;
  const y = oy + r.y * PX_PER_FT;
  const w = r.w * PX_PER_FT;
  const h = r.h * PX_PER_FT;
  const rect = `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="#ffffff" stroke="#111111" stroke-width="3"/>`;
  if (r.isFiller || !r.name) return rect;
  const cx = x + w / 2;
  const cy = y + h / 2;
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
  return rect + icon + label + size;
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
export function renderFloorPlanSvg(plan: PlannedFloorPlan, geo: FloorPlanGeometry): { svg: string; width: number; height: number } {
  const ox = MARGIN - geo.bounds.minX * PX_PER_FT;
  const oy = MARGIN - geo.bounds.minY * PX_PER_FT;
  const drawingW = (geo.bounds.maxX - geo.bounds.minX) * PX_PER_FT;
  const drawingH = (geo.bounds.maxY - geo.bounds.minY) * PX_PER_FT;
  const width = Math.round(MARGIN + drawingW + MARGIN + TABLE_WIDTH);
  const height = Math.round(Math.max(drawingH + MARGIN * 2 + 60, 560));

  const rooms = geo.rooms.map((r) => room(r, ox, oy)).join('');

  const mainX1 = ox + geo.main.x * PX_PER_FT;
  const mainX2 = ox + (geo.main.x + geo.main.w) * PX_PER_FT;
  const mainY1 = oy + geo.main.y * PX_PER_FT;
  const mainY2 = oy + (geo.main.y + geo.main.h) * PX_PER_FT;
  const topDim = dimensionLine(mainX1, mainY1 - 40, mainX2, mainY1 - 40, `${ftLabel(plan.widthFt)}-0"`, false);
  const sideDim = dimensionLine(mainX1 - 40, mainY1, mainX1 - 40, mainY2, `${ftLabel(plan.depthFt)}-0"`, true);

  const tableX = MARGIN + drawingW + MARGIN;
  const tableRooms = plan.rooms
    .filter((r) => r.placement === 'main' || r.placement === 'wing_left' || r.placement === 'wing_right')
    .concat(plan.rooms.filter((r) => r.placement === 'exterior_front' || r.placement === 'exterior_rear'));
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
  for (const [label, ft] of [['Width', plan.widthFt], ['Depth', plan.depthFt]] as const) {
    tableRows.push(`<text x="${tableX}" y="${ty}" font-family="Helvetica, Arial, sans-serif" font-size="12.5" fill="#111111">${label}</text>`);
    tableRows.push(
      `<text x="${width - MARGIN / 2}" y="${ty}" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="12.5" fill="#111111">${ftLabel(ft)}-0"</text>`,
    );
    ty += 22;
  }

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

  return { svg, width, height };
}

/**
 * Claude sorts, this file packs and draws, then the whole picture is
 * rasterised — Cloudflare's edit model takes pixels, not markup.
 */
export async function sketchFloorPlanFromBrief(
  brief: string,
  ctx: CallContext,
  timeoutMs: number,
): Promise<ImageReference | null> {
  const plan = await planFloorLayout(brief, ctx, timeoutMs);
  if (!plan) return null;
  const geo = computeFloorPlanGeometry(plan);
  const { svg, width, height } = renderFloorPlanSvg(plan, geo);
  const bytes = await sharp(Buffer.from(svg), { density: 144 }).png().toBuffer();
  return { mimeType: 'image/png', bytes, label: `${plan.title} — schematic floor plan` };
}
