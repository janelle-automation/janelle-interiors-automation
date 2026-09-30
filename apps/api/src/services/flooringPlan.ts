import { extractJson, type CallContext } from './anthropic.js';

/**
 * A flooring plan: the drawing a flooring contractor and a client read.
 *
 * It is NOT a furnished floor plan. That is a different deliverable
 * (floorPlan.ts furnishes a drawing with an image model), and asked for a
 * flooring plan it produced photographs of beds and dining tables pasted
 * into rooms of the wrong name, with materials that meant nothing and no
 * sign of which way anything was laid. A flooring plan shows the FLOOR:
 * what material is in each room, how it is laid and in which direction,
 * where one material meets another and what goes at that joint, and the
 * dimensions to set it out from.
 *
 * So nothing here is drawn by an image model. Claude makes the design
 * decisions (the rooms, the materials, the lay direction, which rooms
 * connect) and this file draws them as a vector plan — real joints at the
 * material's real size, real walls, door openings, transition strips,
 * dimension chains and a legend. Every label and number is computed from
 * the geometry that is actually drawn, so the plan cannot disagree with
 * itself.
 *
 * The layout is asked for as BANDS, not free coordinates. A model given
 * free x/y placed rooms with gaps and overlaps; rooms in rows whose widths
 * sum to the house width cannot overlap, always share walls, and always
 * fill the footprint.
 */

/** Asked for a plan of the flooring, by name. A "furnished floor plan" is not this. */
export const FLOORING_PLAN =
  /\bflooring\s+(plans?|layouts?|schedules?|designs?)\b|\bfloor(?:ing)?\s+finish(?:es)?\s+plans?\b|\btile\s+layout\s+plans?\b|\bflooring\s+and\s+(?:tile|material)/i;

type Category = 'wood' | 'tile' | 'stone' | 'concrete' | 'carpet';
type PatternKind = 'plank' | 'herringbone' | 'grid' | 'running_bond' | 'stone' | 'solid';
type Side = 'N' | 'S' | 'E' | 'W';

interface Material {
  key: string;
  name: string;
  category: Category;
  size: string;
  pattern: PatternKind;
  color: string;
}

interface RawRoom {
  name?: string;
  widthFt?: number;
  material?: string;
  direction?: string;
}
interface RawPlan {
  title?: string;
  widthFt?: number;
  materials?: Partial<Material>[];
  bands?: { depthFt?: number; rooms?: RawRoom[] }[];
  exterior?: (RawRoom & { attach?: string; offsetFt?: number; depthFt?: number })[];
  doors?: { a?: string; b?: string; kind?: string }[];
  entries?: { room?: string; side?: string; kind?: string }[];
}

interface Room {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  material: Material;
  dir: 'x' | 'y';
  exterior: boolean;
  open: boolean; // a porch, patio or deck: no walls of its own
}

const SYSTEM = `You are a flooring designer producing the DESIGN DECISIONS for a professional architectural flooring plan of a single-story residence. A drawing program will draw your answer exactly — so it must be complete, buildable and consistent.

Return JSON only:
{
 "title": string,                     // e.g. "Luxury Single-Story Residence"
 "widthFt": number,                   // overall width of the main house
 "materials": [ {"key":"A","name":string,"category":"wood"|"tile"|"stone"|"concrete"|"carpet","size":string,"pattern":"plank"|"herringbone"|"grid"|"running_bond"|"stone"|"solid","color":"#rrggbb"} ],
 "bands": [ {"depthFt": number, "rooms":[ {"name":string,"widthFt":number,"material":"A","direction":"x"|"y"} ] } ],
 "exterior": [ {"name":string,"attach":"N"|"S"|"E"|"W","offsetFt":number,"widthFt":number,"depthFt":number,"material":"A","direction":"x"|"y"} ],
 "doors": [ {"a":string,"b":string,"kind":"door"|"opening"} ],
 "entries": [ {"room":string,"side":"N"|"S"|"E"|"W","kind":"door"|"double"} ]
}

LAYOUT — "bands" are horizontal rows of the house from the back (north, top of the drawing) to the front (south). Each band has one depthFt, and its rooms sit side by side across the whole house. THE WIDTHS IN EVERY BAND MUST ADD UP TO EXACTLY widthFt. Every room in a band is as deep as the band. Design it the way an architect would: an entry leading to living/dining, the kitchen beside the dining, bedrooms grouped near their bathrooms, a hallway or gallery as its own room wherever rooms are not directly adjacent. Use the room list and sizes the brief gives, exactly, whenever it gives them (a "14 x 12" room is widthFt 14 in a band 12 deep); size any room the brief does not size sensibly for the house. Never invent a room the brief did not list, except a hallway or gallery you need to connect rooms.
"exterior" holds spaces outside the main footprint — garage, porch, patio, deck — each attached to one side of the house ("attach") at "offsetFt" along that side, measured from the house's north-west corner.

MATERIALS — a small, elegant, cohesive palette (typically 4 to 7 materials), each with a short key ("A", "B"...). Every room names one material. "size" is the unit as installed, in inches with a plain multiplication sign: "9\\" x 72\\"" for a plank, "24\\" x 24\\"" for a tile; a herringbone wood is its board size ("3\\" x 18\\""). "pattern" is how it is laid: plank (straight or staggered boards), herringbone, grid (stacked tile), running_bond (offset tile), stone (random ashlar), solid (poured/continuous). "color" a realistic hex of the material. Use the brief's own materials and sizes when it names them. Keep bathrooms, laundry and garage in appropriate, durable materials and the living spaces continuous.

DIRECTION — "direction" is the way planks and long tile edges run: "x" left-right on the drawing or "y" up-down. Lay planks along the longest sightline of a room, toward the entry or windows, and keep the SAME direction through rooms that share a material and are connected, so the floor reads as one run.

DOORS — "doors" lists every pair of rooms that are connected and touch each other. "door" is a normal door opening; "opening" is a wide cased or open-plan connection (living to dining, dining to kitchen). Every room must be reachable. "entries" are the exterior doors: the room, which wall it is on, "double" for double doors. Give the front door, the garage entry, and the patio doors.

Room names are exactly as the brief words them. Never leave a band short or long of widthFt.`;

// ── Materials ──────────────────────────────────────────────────

const DEFAULT_COLOR: Record<Category, string> = {
  wood: '#c9a77c',
  tile: '#d9d6cf',
  stone: '#b9b3a8',
  concrete: '#c7c7c4',
  carpet: '#d8cfc4',
};
const DEFAULT_SIZE: Record<Category, [number, number]> = {
  wood: [7, 48],
  tile: [24, 24],
  stone: [12, 24],
  concrete: [120, 120],
  carpet: [12, 12],
};
const PATTERNS: PatternKind[] = ['plank', 'herringbone', 'grid', 'running_bond', 'stone', 'solid'];
const PATTERN_LABEL: Record<PatternKind, string> = {
  plank: 'Plank, staggered joints',
  herringbone: 'Herringbone',
  grid: 'Stacked grid',
  running_bond: 'Running bond',
  stone: 'Random ashlar',
  solid: 'Continuous',
};

const hex = (s: unknown, fallback: string) => (typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s.trim()) ? s.trim() : fallback);

function shade(color: string, amount: number): string {
  const n = parseInt(color.slice(1), 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(amount >= 0 ? v + (255 - v) * amount : v * (1 + amount))));
  const r = ch((n >> 16) & 255);
  const g = ch((n >> 8) & 255);
  const b = ch(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** "9\" x 72\"", "600×1200mm", "24 x 24 in" — inches, the long edge last. */
function parseSizeInches(size: string, category: Category): [number, number] {
  const m = size.match(/(\d+(?:\.\d+)?)\s*(?:"|”|in\b|inch(?:es)?|mm|cm)?\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(mm|cm|"|”|in\b|inch(?:es)?)?/i);
  if (!m) return DEFAULT_SIZE[category];
  let a = Number(m[1]);
  let b = Number(m[2]);
  const unit = (m[3] ?? '').toLowerCase();
  const mm = unit === 'mm' || (/mm/i.test(size) && !unit) || Math.max(a, b) > 400;
  const cm = unit === 'cm';
  if (mm) [a, b] = [a / 25.4, b / 25.4];
  else if (cm) [a, b] = [a / 2.54, b / 2.54];
  if (!(a > 0) || !(b > 0)) return DEFAULT_SIZE[category];
  return [Math.min(a, b), Math.max(a, b)];
}

function cleanMaterials(raw: Partial<Material>[] | undefined): Material[] {
  const out: Material[] = [];
  for (const m of raw ?? []) {
    if (!m || !m.name) continue;
    const category = (['wood', 'tile', 'stone', 'concrete', 'carpet'] as Category[]).includes(m.category as Category)
      ? (m.category as Category)
      : 'tile';
    const pattern = PATTERNS.includes(m.pattern as PatternKind)
      ? (m.pattern as PatternKind)
      : category === 'wood'
        ? 'plank'
        : category === 'stone'
          ? 'stone'
          : category === 'concrete'
            ? 'solid'
            : 'grid';
    out.push({
      key: String(m.key || String.fromCharCode(65 + out.length)).slice(0, 3),
      name: String(m.name).slice(0, 60),
      category,
      size: String(m.size ?? '').slice(0, 40),
      pattern,
      color: hex(m.color, DEFAULT_COLOR[category]),
    });
  }
  return out;
}

// ── Layout ─────────────────────────────────────────────────────

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const OPEN_ROOM = /\b(patio|porch|deck|terrace|balcony|veranda|lanai)\b/i;
const CIRCULATION = /\b(hall|hallway|corridor|gallery|foyer|entry|entrance|vestibule)\b/i;

function fuzzyRoom(rooms: Room[], name: string | undefined): Room | null {
  if (!name) return null;
  const n = norm(name);
  return (
    rooms.find((r) => norm(r.name) === n) ??
    rooms.find((r) => norm(r.name).includes(n) || n.includes(norm(r.name))) ??
    null
  );
}

function layout(raw: RawPlan, materials: Material[]): { rooms: Room[]; width: number; depth: number } | null {
  const byKey = new Map(materials.map((m) => [m.key.toLowerCase(), m]));
  const pick = (key: string | undefined) => byKey.get(String(key ?? '').toLowerCase()) ?? materials[0];
  const dirOf = (d: string | undefined): 'x' | 'y' => (String(d).toLowerCase() === 'y' ? 'y' : 'x');

  const bands = (raw.bands ?? [])
    .map((b) => ({
      depth: Number(b.depthFt) || 0,
      rooms: (b.rooms ?? []).filter((r) => r && r.name && Number(r.widthFt) > 0),
    }))
    .filter((b) => b.depth > 0 && b.rooms.length);
  if (!bands.length) return null;

  // Every band spans the same width. Where the design's widths do not add up
  // to it, the band's rooms are scaled to fit — the plan is then labelled
  // from what is drawn, so no figure ever disagrees with the picture.
  const declared = Number(raw.widthFt) || 0;
  const sums = bands.map((b) => b.rooms.reduce((s, r) => s + Number(r.widthFt), 0));
  const target = declared > 10 ? declared : Math.max(...sums);

  const rooms: Room[] = [];
  let y = 0;
  bands.forEach((b, bi) => {
    const scale = target / sums[bi];
    let x = 0;
    b.rooms.forEach((r, ri) => {
      const last = ri === b.rooms.length - 1;
      const w = last ? target - x : Math.round(Number(r.widthFt) * scale * 2) / 2;
      rooms.push({
        name: String(r.name).slice(0, 34),
        x,
        y,
        w,
        h: b.depth,
        material: pick(r.material),
        dir: dirOf(r.direction),
        exterior: false,
        open: false,
      });
      x += w;
    });
    y += b.depth;
  });
  const depth = y;

  // Outside spaces sit against the side they name, side by side where more
  // than one is on the same wall, and never overlapping the house or each other.
  const cursors: Record<Side, number> = { N: 0, S: 0, E: 0, W: 0 };
  for (const e of raw.exterior ?? []) {
    if (!e || !e.name) continue;
    const w = Number(e.widthFt) || 0;
    const h = Number(e.depthFt) || 0;
    if (!(w > 0) || !(h > 0)) continue;
    const side = (['N', 'S', 'E', 'W'].includes(String(e.attach).toUpperCase()) ? String(e.attach).toUpperCase() : 'S') as Side;
    const alongX = side === 'N' || side === 'S';
    const wanted = Math.max(Number(e.offsetFt) || 0, cursors[side]);
    const along = alongX ? Math.min(wanted, Math.max(0, target - 1)) : Math.min(wanted, Math.max(0, depth - 1));
    const ex = side === 'W' ? -w : side === 'E' ? target : along;
    const ey = side === 'N' ? -h : side === 'S' ? depth : along;
    cursors[side] = along + (alongX ? w : h);
    rooms.push({
      name: String(e.name).slice(0, 34),
      x: ex,
      y: ey,
      w,
      h,
      material: pick(e.material),
      dir: dirOf(e.direction),
      exterior: true,
      open: OPEN_ROOM.test(String(e.name)),
    });
  }
  return { rooms, width: target, depth };
}

interface Seg {
  /** true: the shared wall is vertical (rooms side by side). */
  vertical: boolean;
  /** Fixed coordinate (x for a vertical wall, y for a horizontal one). */
  at: number;
  from: number;
  to: number;
}

const EPS = 0.06;

/** The wall two rooms share, or null when they only meet at a corner or not at all. */
function sharedWall(a: Room, b: Room): Seg | null {
  const overlap = (a1: number, a2: number, b1: number, b2: number) => [Math.max(a1, b1), Math.min(a2, b2)] as const;
  if (Math.abs(a.x + a.w - b.x) < EPS || Math.abs(b.x + b.w - a.x) < EPS) {
    const at = Math.abs(a.x + a.w - b.x) < EPS ? b.x : a.x;
    const [from, to] = overlap(a.y, a.y + a.h, b.y, b.y + b.h);
    if (to - from > 1) return { vertical: true, at, from, to };
  }
  if (Math.abs(a.y + a.h - b.y) < EPS || Math.abs(b.y + b.h - a.y) < EPS) {
    const at = Math.abs(a.y + a.h - b.y) < EPS ? b.y : a.y;
    const [from, to] = overlap(a.x, a.x + a.w, b.x, b.x + b.w);
    if (to - from > 1) return { vertical: false, at, from, to };
  }
  return null;
}

interface Door {
  a: Room;
  b: Room | null;
  seg: Seg;
  /** Where along the wall the opening starts, and its length, in feet. */
  start: number;
  length: number;
  kind: 'door' | 'opening' | 'double';
  /** Exterior doors: the wall the door is in. */
  side?: Side;
}

function connect(rooms: Room[], raw: RawPlan): Door[] {
  const doors: Door[] = [];
  const linked = new Set<string>();
  const key = (a: Room, b: Room) => [rooms.indexOf(a), rooms.indexOf(b)].sort().join('-');

  const add = (a: Room, b: Room, kind: 'door' | 'opening') => {
    const seg = sharedWall(a, b);
    if (!seg || linked.has(key(a, b))) return;
    linked.add(key(a, b));
    const span = seg.to - seg.from;
    // A door is 3 feet; an opening takes most of the shared wall.
    const length = kind === 'opening' ? Math.max(3, Math.min(span - 1, 12)) : Math.min(3, Math.max(2, span - 1));
    doors.push({ a, b, seg, start: seg.from + (span - length) / 2, length, kind });
  };

  for (const d of raw.doors ?? []) {
    const a = fuzzyRoom(rooms, d.a);
    const b = fuzzyRoom(rooms, d.b);
    if (a && b && a !== b) add(a, b, d.kind === 'opening' ? 'opening' : 'door');
  }

  // A room the design left without a way in gets one, to the neighbour it
  // shares the most wall with — a hallway or entry first.
  const reachable = (r: Room) => doors.some((d) => d.a === r || d.b === r);
  for (const r of rooms) {
    if (reachable(r)) continue;
    const options = rooms
      .filter((o) => o !== r)
      .map((o) => ({ o, seg: sharedWall(r, o) }))
      .filter((c): c is { o: Room; seg: Seg } => c.seg !== null)
      .sort((p, q) => {
        const pc = CIRCULATION.test(p.o.name) ? 1 : 0;
        const qc = CIRCULATION.test(q.o.name) ? 1 : 0;
        return qc - pc || q.seg.to - q.seg.from - (p.seg.to - p.seg.from);
      });
    if (options[0]) add(r, options[0].o, 'door');
  }

  for (const e of raw.entries ?? []) {
    const a = fuzzyRoom(rooms, e.room);
    const side = String(e.side ?? '').toUpperCase() as Side;
    if (!a || !['N', 'S', 'E', 'W'].includes(side)) continue;
    const vertical = side === 'E' || side === 'W';
    const at = side === 'W' ? a.x : side === 'E' ? a.x + a.w : side === 'N' ? a.y : a.y + a.h;
    const from = vertical ? a.y : a.x;
    const to = vertical ? a.y + a.h : a.x + a.w;
    const kind = e.kind === 'double' ? 'double' : 'door';
    const length = Math.min(kind === 'double' ? 6 : 3, Math.max(2, to - from - 1));
    doors.push({ a, b: null, seg: { vertical, at, from, to }, start: from + (to - from - length) / 2, length, kind, side });
  }
  return doors;
}

// ── Drawing ────────────────────────────────────────────────────

const PX = 24; // pixels per foot
const MARGIN = 150;
const PANEL = 560;
const INK = '#161616';
const BRASS = '#a8843f';
const FONT = 'Helvetica, Arial, sans-serif';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n1 = (v: number) => v.toFixed(1);

/** 12'-6" — feet and whole inches. */
function ft(v: number): string {
  const total = Math.round(v * 12);
  const f = Math.floor(total / 12);
  const i = total % 12;
  return `${f}'-${i}"`;
}

/** A tiny deterministic generator, so a stone pattern is the same every time. */
function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function patternDef(id: string, m: Material, dir: 'x' | 'y'): string {
  const [shortIn, longIn] = parseSizeInches(m.size, m.category);
  const pxIn = PX / 12;
  const line = shade(m.color, -0.3);
  const lt = shade(m.color, 0.05);
  const rot = dir === 'y' ? ' patternTransform="rotate(90)"' : '';
  const open = (w: number, h: number) => `<pattern id="${id}" width="${n1(w)}" height="${n1(h)}" patternUnits="userSpaceOnUse"${rot}>`;
  const bg = (w: number, h: number) => `<rect width="${n1(w)}" height="${n1(h)}" fill="${m.color}"/>`;
  const stroke = `stroke="${line}" stroke-width="0.8"`;
  const ln = (x1: number, y1: number, x2: number, y2: number) =>
    `<line x1="${n1(x1)}" y1="${n1(y1)}" x2="${n1(x2)}" y2="${n1(y2)}" ${stroke}/>`;

  switch (m.pattern) {
    case 'plank': {
      const w = Math.max(6, shortIn * pxIn);
      const L = Math.max(w * 4, Math.min(longIn * pxIn, PX * 8));
      // Three rows, each starting a third of a plank further along.
      let body = bg(L, w * 3);
      for (let r = 0; r < 3; r++) {
        if (r > 0) body += ln(0, r * w, L, r * w);
        const x = (r * L) / 3;
        body += ln(x, r * w, x, (r + 1) * w);
      }
      body += ln(0, 3 * w, L, 3 * w);
      return open(L, w * 3) + body + '</pattern>';
    }
    case 'herringbone': {
      const w = Math.max(6, shortIn * pxIn);
      const n = Math.max(3, Math.min(8, Math.round(longIn / shortIn)));
      const cell = 2 * n * w;
      let body = bg(cell, cell);
      let rects = '';
      for (let k = -1; k <= 1; k++) {
        for (let i = -2 * n; i <= 2 * n; i++) {
          const hx = (i + 2 * n * k) * w;
          const hy = i * w;
          const vx = (i + n + 2 * n * k) * w;
          const vy = (i + 1 - n) * w;
          rects += `<rect x="${n1(hx)}" y="${n1(hy)}" width="${n1(n * w)}" height="${n1(w)}" fill="${lt}" stroke="${line}" stroke-width="0.6"/>`;
          rects += `<rect x="${n1(vx)}" y="${n1(vy)}" width="${n1(w)}" height="${n1(n * w)}" fill="${m.color}" stroke="${line}" stroke-width="0.6"/>`;
        }
      }
      return open(cell, cell) + body + rects + '</pattern>';
    }
    case 'running_bond': {
      const w = Math.max(8, shortIn * pxIn);
      const L = Math.max(w * 1.5, longIn * pxIn);
      return (
        open(L, w * 2) + bg(L, w * 2) + ln(0, 0, L, 0) + ln(0, w, L, w) + ln(0, 2 * w, L, 2 * w) + ln(0, 0, 0, w) + ln(L / 2, w, L / 2, 2 * w) + '</pattern>'
      );
    }
    case 'grid': {
      const a = Math.max(8, shortIn * pxIn);
      const b = Math.max(8, longIn * pxIn);
      return open(b, a) + bg(b, a) + ln(0, 0, b, 0) + ln(0, 0, 0, a) + '</pattern>';
    }
    case 'stone': {
      const size = PX * 6;
      const rnd = seeded(m.name.length * 7919 + m.color.charCodeAt(1));
      const heights = [0.2, 0.15, 0.22, 0.18, 0.25];
      let body = bg(size, size);
      let y = 0;
      for (const hgt of heights) {
        const rowH = hgt * size;
        body += ln(0, y, size, y);
        const parts = 3 + Math.floor(rnd() * 2);
        const widths = Array.from({ length: parts }, () => 0.6 + rnd());
        const total = widths.reduce((s, v) => s + v, 0);
        let x = rnd() * size * 0.3;
        for (const wv of widths) {
          body += ln(x % size, y, x % size, y + rowH);
          x += (wv / total) * size;
        }
        y += rowH;
      }
      return open(size, size) + body + '</pattern>';
    }
    case 'solid':
      // Saw-cut control joints, ten feet apart.
      return open(PX * 10, PX * 10) + bg(PX * 10, PX * 10) + ln(0, 0, PX * 10, 0) + ln(0, 0, 0, PX * 10) + '</pattern>';
    default:
      return open(20, 20) + bg(20, 20) + '</pattern>';
  }
}

/** The kind of joint two materials make, and what goes in it. */
function transitionSpec(a: Material, b: Material, exterior: boolean): { label: string; how: string } {
  const cats = [a.category, b.category].sort().join('+');
  if (exterior) return { label: 'Exterior threshold', how: 'Weather-sealed threshold, set flush' };
  if (cats === 'tile+wood') return { label: 'Wood to tile', how: 'Flush T-molding; tile and wood set to the same height' };
  if (cats === 'stone+wood') return { label: 'Wood to stone', how: 'Flush metal or stone saddle threshold' };
  if (cats === 'carpet+wood') return { label: 'Wood to carpet', how: 'Carpet reducer strip' };
  if (cats === 'carpet+tile') return { label: 'Tile to carpet', how: 'Carpet-to-tile transition strip' };
  if (cats === 'concrete+wood' || cats === 'concrete+tile') return { label: `${a.category} to ${b.category}`, how: 'Reducer or threshold at the step down' };
  if (a.category === b.category) return { label: 'Change of pattern', how: 'Flush divider strip; align the two layouts on the door centre' };
  return { label: `${a.category} to ${b.category}`, how: 'Flush transition strip' };
}

function wrap(text: string, max: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max) {
      if (cur) lines.push(cur);
      cur = w;
    } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines;
}

function drawPlan(title: string, rooms: Room[], doors: Door[], width: number, depth: number, materials: Material[]): string {
  const minX = Math.min(...rooms.map((r) => r.x));
  const minY = Math.min(...rooms.map((r) => r.y));
  const maxX = Math.max(...rooms.map((r) => r.x + r.w));
  const maxY = Math.max(...rooms.map((r) => r.y + r.h));
  const ox = MARGIN - minX * PX;
  const oy = MARGIN + 30 - minY * PX;
  const drawW = (maxX - minX) * PX;
  const drawH = (maxY - minY) * PX;
  const px = (v: number) => ox + v * PX;
  const py = (v: number) => oy + v * PX;

  // The patterns actually used, one per material and lay direction.
  const usedPatterns = new Map<string, { m: Material; dir: 'x' | 'y' }>();
  for (const r of rooms) usedPatterns.set(`${r.material.key}-${r.dir}`, { m: r.material, dir: r.dir });
  const patId = (m: Material, dir: 'x' | 'y') => `pat-${esc(m.key).replace(/[^A-Za-z0-9]/g, '_')}-${dir}`;
  const defs = [...usedPatterns.values()].map(({ m, dir }) => patternDef(patId(m, dir), m, dir)).join('');
  const legendPatterns = materials.map((m) => patternDef(`leg-${esc(m.key).replace(/[^A-Za-z0-9]/g, '_')}`, m, 'x')).join('');

  const parts: string[] = [];

  // Floors.
  for (const r of rooms) {
    parts.push(`<rect x="${n1(px(r.x))}" y="${n1(py(r.y))}" width="${n1(r.w * PX)}" height="${n1(r.h * PX)}" fill="url(#${patId(r.material, r.dir)})"/>`);
  }

  // Walls: the house's own outline heavy, interior partitions lighter,
  // outdoor spaces dashed (a patio has no walls).
  for (const r of rooms) {
    const dash = r.open ? ' stroke-dasharray="10 6"' : '';
    const sw = r.exterior ? (r.open ? 2 : 4.5) : 3;
    parts.push(`<rect x="${n1(px(r.x))}" y="${n1(py(r.y))}" width="${n1(r.w * PX)}" height="${n1(r.h * PX)}" fill="none" stroke="${INK}" stroke-width="${sw}"${dash}/>`);
  }
  parts.push(`<rect x="${n1(px(0))}" y="${n1(py(0))}" width="${n1(width * PX)}" height="${n1(depth * PX)}" fill="none" stroke="${INK}" stroke-width="7"/>`);

  // Openings, and the strip where one flooring meets another.
  const transitions: { tag: string; where: string; spec: { label: string; how: string } }[] = [];
  for (const d of doors) {
    const thick = 9;
    const [x1, y1, x2, y2] = d.seg.vertical
      ? [px(d.seg.at), py(d.start), px(d.seg.at), py(d.start + d.length)]
      : [px(d.start), py(d.seg.at), px(d.start + d.length), py(d.seg.at)];
    // Break the wall.
    parts.push(
      d.seg.vertical
        ? `<rect x="${n1(x1 - thick / 2)}" y="${n1(y1)}" width="${thick}" height="${n1(y2 - y1)}" fill="#ffffff"/>`
        : `<rect x="${n1(x1)}" y="${n1(y1 - thick / 2)}" width="${n1(x2 - x1)}" height="${thick}" fill="#ffffff"/>`,
    );
    // The door leaf and its swing (interior doors only).
    if (d.kind !== 'opening') {
      const leaves = d.kind === 'double' ? 2 : 1;
      const len = (d.length * PX) / leaves;
      for (let i = 0; i < leaves; i++) {
        const hingeAt = leaves === 1 ? 0 : i === 0 ? 0 : d.length * PX;
        const dirSign = leaves === 2 && i === 1 ? -1 : 1;
        const into = d.b ? 1 : d.side === 'N' || d.side === 'W' ? -1 : 1;
        if (d.seg.vertical) {
          const hx = x1;
          const hy = y1 + hingeAt;
          parts.push(`<path d="M ${n1(hx)} ${n1(hy)} L ${n1(hx + into * len)} ${n1(hy)} A ${n1(len)} ${n1(len)} 0 0 ${into * dirSign > 0 ? 1 : 0} ${n1(hx)} ${n1(hy + dirSign * len)}" fill="none" stroke="${INK}" stroke-width="1"/>`);
        } else {
          const hx = x1 + hingeAt;
          const hy = y1;
          parts.push(`<path d="M ${n1(hx)} ${n1(hy)} L ${n1(hx)} ${n1(hy + into * len)} A ${n1(len)} ${n1(len)} 0 0 ${into * dirSign > 0 ? 0 : 1} ${n1(hx + dirSign * len)} ${n1(hy)}" fill="none" stroke="${INK}" stroke-width="1"/>`);
        }
      }
    }
    // Transition strip where the flooring changes.
    const differs = d.b ? d.a.material.key !== d.b.material.key : false;
    const toOutside = !!d.b && (d.a.exterior !== d.b.exterior);
    if (d.b && differs) {
      const tag = `T${transitions.length + 1}`;
      const spec = transitionSpec(d.a.material, d.b.material, toOutside);
      transitions.push({ tag, where: `${d.a.name} / ${d.b.name}`, spec });
      const strip = d.seg.vertical
        ? `<rect x="${n1(x1 - 4)}" y="${n1(y1 + 1)}" width="8" height="${n1(y2 - y1 - 2)}" fill="${BRASS}" stroke="${INK}" stroke-width="0.7"/>`
        : `<rect x="${n1(x1 + 1)}" y="${n1(y1 - 4)}" width="${n1(x2 - x1 - 2)}" height="8" fill="${BRASS}" stroke="${INK}" stroke-width="0.7"/>`;
      parts.push(strip);
      const tx = (x1 + x2) / 2 + (d.seg.vertical ? 15 : 0);
      const ty = (y1 + y2) / 2 + (d.seg.vertical ? 0 : 15);
      parts.push(
        `<rect x="${n1(tx - 12)}" y="${n1(ty - 8)}" width="24" height="16" rx="8" fill="#ffffff" stroke="${BRASS}" stroke-width="1.3"/>` +
          `<text x="${n1(tx)}" y="${n1(ty + 3.5)}" text-anchor="middle" font-family="${FONT}" font-size="9.5" font-weight="700" fill="${INK}">${tag}</text>`,
      );
    }
  }

  // Room labels: name, size, material key, and the lay direction.
  for (const r of rooms) {
    const cx = px(r.x + r.w / 2);
    const cy = py(r.y + r.h / 2);
    const fitsSize = r.w * PX > 96 && r.h * PX > 64;
    const upper = r.name.toUpperCase();
    const nameSize = Math.max(8.5, Math.min(13, (r.w * PX * 0.86) / (upper.length * 0.62)));
    const boxW = Math.min(r.w * PX - 8, Math.max(upper.length * nameSize * 0.64 + 18, 64));
    const boxH = fitsSize ? 44 : 22;
    parts.push(`<rect x="${n1(cx - boxW / 2)}" y="${n1(cy - boxH / 2)}" width="${n1(boxW)}" height="${boxH}" rx="3" fill="#ffffff" fill-opacity="0.88"/>`);
    parts.push(`<text x="${n1(cx)}" y="${n1(cy - (fitsSize ? 6 : -3))}" text-anchor="middle" font-family="${FONT}" font-size="${n1(nameSize)}" font-weight="700" letter-spacing="0.4" fill="${INK}">${esc(upper)}</text>`);
    if (fitsSize) {
      parts.push(`<text x="${n1(cx)}" y="${n1(cy + 9)}" text-anchor="middle" font-family="${FONT}" font-size="10.5" fill="#444444">${esc(`${ft(r.w)} × ${ft(r.h)}`)}</text>`);
      parts.push(`<text x="${n1(cx)}" y="${n1(cy + 21)}" text-anchor="middle" font-family="${FONT}" font-size="9.5" font-weight="700" fill="${BRASS}">${esc(`MATERIAL ${r.material.key}`)}</text>`);
    }
    // Which way it runs: a double arrow along the boards for anything with a grain.
    if (['plank', 'running_bond', 'grid'].includes(r.material.pattern) && r.w * PX > 70 && r.h * PX > 70) {
      const len = Math.min(3.5 * PX, (r.dir === 'x' ? r.w : r.h) * PX * 0.3);
      const ax = cx;
      const ay = cy + (fitsSize ? 44 : 30);
      if (ay < py(r.y + r.h) - 10) {
        const [dx, dy] = r.dir === 'x' ? [len, 0] : [0, len];
        const y2 = r.dir === 'x' ? ay : Math.min(ay, py(r.y + r.h) - len - 8);
        parts.push(
          `<g stroke="${INK}" stroke-width="1.4" fill="${INK}"><line x1="${n1(ax - dx)}" y1="${n1(y2 - dy)}" x2="${n1(ax + dx)}" y2="${n1(y2 + dy)}"/>` +
            (r.dir === 'x'
              ? `<path d="M ${n1(ax + dx)} ${n1(y2)} l -7 -3.5 l 0 7 z M ${n1(ax - dx)} ${n1(y2)} l 7 -3.5 l 0 7 z" stroke="none"/>`
              : `<path d="M ${n1(ax)} ${n1(y2 + dy)} l -3.5 -7 l 7 0 z M ${n1(ax)} ${n1(y2 - dy)} l -3.5 7 l 7 0 z" stroke="none"/>`) +
            `</g>`,
        );
      }
    } else if (r.material.pattern === 'herringbone' && r.w * PX > 90 && r.h * PX > 60) {
      parts.push(`<text x="${n1(cx)}" y="${n1(cy + (fitsSize ? 36 : 26))}" text-anchor="middle" font-family="${FONT}" font-size="9" letter-spacing="1" fill="#444444">HERRINGBONE</text>`);
    }
  }

  // Dimension chains around the house.
  const dimLine = (x1: number, y1: number, x2: number, y2: number, label: string, vertical: boolean) => {
    const t = 6;
    const ticks = vertical
      ? `<line x1="${x1 - t}" y1="${n1(y1)}" x2="${x1 + t}" y2="${n1(y1)}" stroke="${INK}" stroke-width="1.2"/><line x1="${x2 - t}" y1="${n1(y2)}" x2="${x2 + t}" y2="${n1(y2)}" stroke="${INK}" stroke-width="1.2"/>`
      : `<line x1="${n1(x1)}" y1="${y1 - t}" x2="${n1(x1)}" y2="${y1 + t}" stroke="${INK}" stroke-width="1.2"/><line x1="${n1(x2)}" y1="${y2 - t}" x2="${n1(x2)}" y2="${y2 + t}" stroke="${INK}" stroke-width="1.2"/>`;
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const text = vertical
      ? `<text x="${x1 - 8}" y="${n1(my)}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="${INK}" transform="rotate(-90 ${x1 - 8} ${n1(my)})">${esc(label)}</text>`
      : `<text x="${n1(mx)}" y="${y1 - 7}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="${INK}">${esc(label)}</text>`;
    return `<line x1="${n1(x1)}" y1="${n1(y1)}" x2="${n1(x2)}" y2="${n1(y2)}" stroke="${INK}" stroke-width="1.2"/>${ticks}${text}`;
  };
  const topY = py(minY) - 32;
  const topY2 = py(minY) - 64;
  const leftX = px(minX) - 32;
  const leftX2 = px(minX) - 64;
  // Room widths across the first band, then overall.
  const firstBand = rooms.filter((r) => !r.exterior && Math.abs(r.y) < EPS);
  for (const r of firstBand) parts.push(dimLine(px(r.x), topY, px(r.x + r.w), topY, ft(r.w), false));
  parts.push(dimLine(px(0), topY2, px(width), topY2, ft(width), false));
  // Band depths down the left, then overall.
  const seenY = new Set<number>();
  for (const r of rooms.filter((q) => !q.exterior && Math.abs(q.x) < EPS)) {
    if (seenY.has(r.y)) continue;
    seenY.add(r.y);
    parts.push(dimLine(leftX, py(r.y), leftX, py(r.y + r.h), ft(r.h), true));
  }
  parts.push(dimLine(leftX2, py(0), leftX2, py(depth), ft(depth), true));

  // ── Side panel ──
  const panelX = MARGIN + drawW + 90;
  const panelRight = panelX + PANEL - 40;
  let ty = MARGIN + 10;
  const heading = (text: string) => {
    parts.push(`<text x="${panelX}" y="${ty}" font-family="${FONT}" font-size="15" font-weight="700" letter-spacing="0.6" fill="${INK}">${esc(text)}</text>`);
    ty += 12;
    parts.push(`<line x1="${panelX}" y1="${ty}" x2="${panelRight}" y2="${ty}" stroke="${INK}" stroke-width="1"/>`);
    ty += 22;
  };

  heading('FLOORING LEGEND');
  const usedKeys = new Set(rooms.map((r) => r.material.key));
  for (const m of materials.filter((q) => usedKeys.has(q.key))) {
    const id = `leg-${esc(m.key).replace(/[^A-Za-z0-9]/g, '_')}`;
    parts.push(`<rect x="${panelX}" y="${ty - 14}" width="64" height="44" fill="url(#${id})" stroke="${INK}" stroke-width="1"/>`);
    parts.push(`<circle cx="${panelX + 32}" cy="${ty + 8}" r="10" fill="#ffffff" stroke="${INK}" stroke-width="1.2"/><text x="${panelX + 32}" y="${ty + 12}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="700" fill="${INK}">${esc(m.key)}</text>`);
    parts.push(`<text x="${panelX + 78}" y="${ty - 1}" font-family="${FONT}" font-size="13" font-weight="700" fill="${INK}">${esc(m.name)}</text>`);
    const spec = [m.category[0].toUpperCase() + m.category.slice(1), m.size, PATTERN_LABEL[m.pattern]].filter(Boolean).join(' · ');
    parts.push(`<text x="${panelX + 78}" y="${ty + 15}" font-family="${FONT}" font-size="11" fill="#555555">${esc(spec)}</text>`);
    const used = rooms.filter((r) => r.material.key === m.key).map((r) => r.name);
    const usedLines = wrap(`Used in: ${used.join(', ')}`, 62).slice(0, 2);
    usedLines.forEach((l, i) => parts.push(`<text x="${panelX + 78}" y="${ty + 30 + i * 13}" font-family="${FONT}" font-size="10.5" fill="#777777">${esc(l)}</text>`));
    ty += 54 + (usedLines.length - 1) * 13;
  }

  ty += 10;
  heading('TRANSITIONS');
  if (!transitions.length) {
    parts.push(`<text x="${panelX}" y="${ty}" font-family="${FONT}" font-size="12" fill="#555555">The flooring is continuous throughout.</text>`);
    ty += 24;
  }
  for (const t of transitions) {
    parts.push(`<rect x="${panelX}" y="${ty - 12}" width="26" height="16" rx="8" fill="#ffffff" stroke="${BRASS}" stroke-width="1.3"/><text x="${panelX + 13}" y="${ty}" text-anchor="middle" font-family="${FONT}" font-size="9.5" font-weight="700" fill="${INK}">${t.tag}</text>`);
    parts.push(`<text x="${panelX + 38}" y="${ty}" font-family="${FONT}" font-size="12" font-weight="700" fill="${INK}">${esc(t.where)}</text>`);
    const how = wrap(`${t.spec.label} — ${t.spec.how}`, 66);
    how.slice(0, 2).forEach((l, i) => parts.push(`<text x="${panelX + 38}" y="${ty + 15 + i * 13}" font-family="${FONT}" font-size="10.5" fill="#555555">${esc(l)}</text>`));
    ty += 22 + Math.min(how.length, 2) * 13;
  }

  ty += 10;
  heading('ROOM SCHEDULE');
  for (const r of rooms) {
    parts.push(`<text x="${panelX}" y="${ty}" font-family="${FONT}" font-size="12" fill="${INK}">${esc(r.name)}</text>`);
    parts.push(`<text x="${panelX + 250}" y="${ty}" font-family="${FONT}" font-size="12" fill="#444444">${esc(`${ft(r.w)} × ${ft(r.h)}`)}</text>`);
    parts.push(`<text x="${panelRight}" y="${ty}" text-anchor="end" font-family="${FONT}" font-size="12" font-weight="700" fill="${BRASS}">${esc(r.material.key)}${['plank', 'running_bond', 'grid'].includes(r.material.pattern) ? (r.dir === 'x' ? ' ↔' : ' ↕') : ''}</text>`);
    ty += 20;
  }

  ty += 16;
  heading('NOTES');
  const notes = [
    'Arrows show the direction planks and long tile edges run.',
    'Brass strips mark a change of flooring; the tag refers to the transition schedule.',
    'Where a material continues through a doorway, it is laid without a break.',
    'All dimensions to finished wall face; verify on site before ordering.',
  ];
  for (const note of notes) {
    wrap(note, 74).forEach((l, i) => parts.push(`<text x="${panelX + (i ? 12 : 0)}" y="${ty + i * 14}" font-family="${FONT}" font-size="11" fill="#555555">${esc((i ? '' : '• ') + l)}</text>`));
    ty += 16 + (wrap(note, 74).length - 1) * 14;
  }

  const height = Math.round(Math.max(MARGIN + 30 + drawH + 210, ty + 190));

  // Title block, north arrow and scale bar.
  const sbY = height - 90;
  const sbX = MARGIN;
  parts.push(`<g font-family="${FONT}" font-size="10" fill="${INK}">` +
    [0, 5, 10, 20].map((v) => `<line x1="${sbX + v * PX}" y1="${sbY}" x2="${sbX + v * PX}" y2="${sbY + 8}" stroke="${INK}" stroke-width="1.2"/><text x="${sbX + v * PX}" y="${sbY + 22}" text-anchor="middle">${v}${v === 20 ? " ft" : ''}</text>`).join('') +
    `<line x1="${sbX}" y1="${sbY + 4}" x2="${sbX + 20 * PX}" y2="${sbY + 4}" stroke="${INK}" stroke-width="1.2"/></g>`);
  const nx = sbX + 20 * PX + 90;
  parts.push(`<g font-family="${FONT}"><circle cx="${nx}" cy="${sbY}" r="22" fill="none" stroke="${INK}" stroke-width="1.2"/><path d="M ${nx} ${sbY - 18} L ${nx + 8} ${sbY + 12} L ${nx} ${sbY + 6} L ${nx - 8} ${sbY + 12} Z" fill="${INK}"/><text x="${nx}" y="${sbY - 27}" text-anchor="middle" font-size="12" font-weight="700" fill="${INK}">N</text></g>`);
  parts.push(`<text x="${panelX}" y="${height - 62}" font-family="Georgia, 'Times New Roman', serif" font-size="30" fill="${INK}">FLOORING PLAN</text>`);
  parts.push(`<text x="${panelX}" y="${height - 38}" font-family="${FONT}" font-size="12" letter-spacing="1.4" fill="#777777">${esc(title.toUpperCase())}</text>`);

  const totalW = Math.round(panelX + PANEL);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalW} ${height}" width="${totalW}" height="${height}"><defs>${defs}${legendPatterns}</defs><rect width="${totalW}" height="${height}" fill="#ffffff"/>${parts.join('')}</svg>`;
}

export interface FlooringPlanResult {
  svg: string;
  rooms: number;
  materials: number;
  transitions: number;
}

/**
 * Turn a plan design into the drawing. Pure — no model call — so the drawing
 * can be tested and reproduced from the design alone.
 */
export function drawFlooringPlan(raw: RawPlan): FlooringPlanResult | null {
  const materials = cleanMaterials(raw.materials);
  if (!materials.length) return null;
  const laid = layout(raw, materials);
  if (!laid || laid.rooms.length < 2) return null;
  const doors = connect(laid.rooms, raw);
  const svg = drawPlan(String(raw.title || 'Single-Story Residence').slice(0, 70), laid.rooms, doors, laid.width, laid.depth, materials);
  const transitions = (svg.match(/>T\d+</g) ?? []).length / 2;
  return { svg, rooms: laid.rooms.length, materials: materials.length, transitions: Math.round(transitions) };
}

/** Claude makes the design decisions; the drawing is made from them. Null when there is not enough to draw. */
export async function planFlooring(brief: string, ctx: CallContext, timeoutMs: number): Promise<FlooringPlanResult | null> {
  const raw = await extractJson<RawPlan>(SYSTEM, brief.slice(0, 5000), ctx, timeoutMs);
  if (!raw) return null;
  return drawFlooringPlan(raw);
}
