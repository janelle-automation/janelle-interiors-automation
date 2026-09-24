import { supabaseAdmin } from '../lib/supabase.js';
import { extractJson, type CallContext } from './anthropic.js';

/**
 * A rendering laid out as a studio presentation board.
 *
 * The house format: the rendering large on the left with its overall
 * dimensions, a specification column down the right, a MATERIALS + FINISHES
 * row of swatches beneath, and the studio's name at the foot.
 *
 * The picture comes from the image model and nothing else on the page does.
 * Every word is laid out here, from specifications Claude pulls out of the
 * brief, because an image model writing a spec sheet misspells the tile
 * supplier and invents a dimension — and on a board that is the one mistake
 * that matters.
 */

export interface BoardSwatch {
  /** The heading above the swatch: "ISLAND CABINETRY". */
  label: string;
  /** The finish: "Natural White Oak". */
  name: string;
  /** A second line: "Medium Shaker", "Waterfall edge". */
  detail?: string | null;
  /** Its colour, as #rrggbb. */
  color: string;
  texture: 'paint' | 'wood' | 'stone' | 'tile' | 'metal' | 'fabric';
}

export interface BoardSpecs {
  title: string;
  /** Only when the brief gave them — never invented. */
  width_label?: string | null;
  height_label?: string | null;
  sections: { heading: string; lines: string[] }[];
  swatches: BoardSwatch[];
  notes: string[];
}

const SPEC_SYSTEM = `You prepare the text for an interior designer's presentation board from a rendering brief.

Return JSON with exactly these fields:
{
  "title": short room title, e.g. "California Contemporary Kitchen",
  "width_label": the room's overall width as feet-inches, e.g. "20'-0\\"", ONLY if the brief states it, else null,
  "height_label": the ceiling height as feet-inches, e.g. "10'-0\\"", ONLY if the brief states it, else null,
  "sections": up to 8 of { "heading": UPPERCASE category (CABINETRY, ISLAND, COUNTERTOP, BACKSPLASH, HARDWARE, FLOORING, LIGHTING, APPLIANCES…), "lines": 1–3 short lines, each under 34 characters },
  "swatches": 4–6 of { "label": UPPERCASE short heading (under 22 chars), "name": the finish (under 26 chars), "detail": one line under 24 characters, or null, "color": realistic hex colour of that material, "texture": one of paint|wood|stone|tile|metal|fabric },
  "notes": up to 4 site notes, each under 55 characters, e.g. "Verify all dimensions in field."
}

Rules:
- Use only what the brief says. Never add a material, colour, finish, upholstery, frame, brand or size the brief does not name — a shorter line is better than an invented one.
- Where a detail a designer would need is missing, write "TBD — Confirm" rather than inventing a product, brand or size.
- Never include photography, camera, lens or rendering-style words — only the room, its materials and fixtures.
- Title Case for names, no markdown.`;

/** Shorten at a word boundary — a cut mid-word reads as a typo on a client board. */
function clip(value: unknown, max: number): string {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.5 ? cut.slice(0, space) : s.slice(0, max)).replace(/[,;:–—-]+$/, '').trim();
}

/** The board's text, from the brief. Null when Claude is unavailable or says nothing usable. */
export async function boardSpecs(brief: string, ctx: CallContext, timeoutMs: number): Promise<BoardSpecs | null> {
  const specs = await extractJson<BoardSpecs>(SPEC_SYSTEM, brief, ctx, timeoutMs);
  if (!specs || !Array.isArray(specs.sections) || !Array.isArray(specs.swatches)) return null;
  return {
    title: clip(specs.title, 60),
    width_label: specs.width_label ? clip(specs.width_label, 12) : null,
    height_label: specs.height_label ? clip(specs.height_label, 12) : null,
    sections: specs.sections.slice(0, 8).map((s) => ({
      heading: clip(s.heading, 28).toUpperCase(),
      lines: (Array.isArray(s.lines) ? s.lines : []).slice(0, 3).map((l) => clip(l, 40)).filter(Boolean),
    })),
    swatches: specs.swatches.slice(0, 6).map((s) => ({
      label: clip(s.label, 24).toUpperCase(),
      name: clip(s.name, 30),
      detail: s.detail ? clip(s.detail, 30) : null,
      color: /^#[0-9a-f]{6}$/i.test(String(s.color)) ? String(s.color) : '#d9d4cc',
      texture: (['paint', 'wood', 'stone', 'tile', 'metal', 'fabric'] as const).includes(s.texture) ? s.texture : 'paint',
    })),
    notes: (Array.isArray(specs.notes) ? specs.notes : []).slice(0, 4).map((n) => clip(n, 60)).filter(Boolean),
  };
}

/** The studio's name for the footer. */
export async function studioName(orgId: string): Promise<string> {
  try {
    const { data } = await supabaseAdmin!.from('organizations').select('name').eq('id', orgId).maybeSingle();
    return (data as { name?: string } | null)?.name || 'Janelle Interiors';
  } catch {
    return 'Janelle Interiors';
  }
}

// ── Layout ──────────────────────────────────────────────────

const W = 1600;
const H = 1130;
const SANS = "Helvetica, Arial, sans-serif";
const SERIF = "Georgia, 'Times New Roman', serif";
const INK = '#2b2b2b';
const SOFT = '#5a5a5a';
const RULE = '#bdbdbd';

const PHOTO = { x: 90, y: 50, w: 1040, h: 585 };
const COLUMN = { x: 1170, w: 390 };

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Break a line to fit, roughly, by character count. */
function wrap(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && (line + ' ' + word).length > maxChars) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v + amount * 255)));
  const r = ch((n >> 16) & 255);
  const g = ch((n >> 8) & 255);
  const b = ch(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

function text(x: number, y: number, s: string, opts: { size: number; weight?: number; fill?: string; anchor?: string; spacing?: number; family?: string }): string {
  return `<text x="${x}" y="${y}" font-family="${opts.family ?? SANS}" font-size="${opts.size}" font-weight="${opts.weight ?? 400}" fill="${opts.fill ?? INK}" text-anchor="${opts.anchor ?? 'start'}"${opts.spacing ? ` letter-spacing="${opts.spacing}"` : ''}>${esc(s)}</text>`;
}

/** A swatch with a hint of its material, so oak reads as oak and not as beige. */
function swatch(s: BoardSwatch, x: number, y: number, size: number, id: string): string {
  const dark = shade(s.color, -0.12);
  const clip = `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${size}" height="${size}"/></clipPath>`;
  const marks: string[] = [];
  if (s.texture === 'wood') {
    for (let i = 1; i < 12; i++) {
      const yy = y + (size / 12) * i;
      marks.push(`<path d="M${x} ${yy} Q ${x + size / 3} ${yy - 4} ${x + size / 2} ${yy + 2} T ${x + size} ${yy - 1}" stroke="${dark}" stroke-width="1.2" fill="none" opacity="0.5"/>`);
    }
  } else if (s.texture === 'stone') {
    marks.push(`<path d="M${x} ${y + size * 0.3} C ${x + size * 0.3} ${y + size * 0.2}, ${x + size * 0.5} ${y + size * 0.6}, ${x + size} ${y + size * 0.45}" stroke="#9a9a9a" stroke-width="1.4" fill="none" opacity="0.55"/>`);
    marks.push(`<path d="M${x + size * 0.2} ${y + size} C ${x + size * 0.35} ${y + size * 0.7}, ${x + size * 0.7} ${y + size * 0.8}, ${x + size} ${y + size * 0.65}" stroke="#a8a8a8" stroke-width="0.9" fill="none" opacity="0.5"/>`);
  } else if (s.texture === 'tile') {
    const n = 4;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const tone = shade(s.color, ((i * 7 + j * 3) % 5) * 0.012 - 0.02);
        marks.push(`<rect x="${x + (size / n) * j + 1.5}" y="${y + (size / n) * i + 1.5}" width="${size / n - 3}" height="${size / n - 3}" fill="${tone}"/>`);
      }
    }
  } else if (s.texture === 'metal') {
    marks.push(`<linearGradient id="${id}g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${shade(s.color, 0.18)}"/><stop offset="0.5" stop-color="${s.color}"/><stop offset="1" stop-color="${shade(s.color, -0.2)}"/></linearGradient>`);
    marks.push(`<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="url(#${id}g)"/>`);
  } else if (s.texture === 'fabric') {
    for (let i = 0; i < size; i += 6) {
      marks.push(`<line x1="${x + i}" y1="${y}" x2="${x + i}" y2="${y + size}" stroke="${dark}" stroke-width="0.6" opacity="0.35"/>`);
      marks.push(`<line x1="${x}" y1="${y + i}" x2="${x + size}" y2="${y + i}" stroke="${dark}" stroke-width="0.6" opacity="0.35"/>`);
    }
  }
  return `<defs>${clip}</defs><rect x="${x}" y="${y}" width="${size}" height="${size}" fill="${s.texture === 'tile' ? '#f4f1ea' : s.color}"/><g clip-path="url(#${id})">${marks.join('')}</g><rect x="${x}" y="${y}" width="${size}" height="${size}" fill="none" stroke="#d6d6d6"/>`;
}

/**
 * The board, as one SVG with the rendering embedded.
 *
 * SVG because every word must stay exact and there is no raster library on
 * the server; the picture travels inside it as a data URI, so the file is
 * self-contained and opens anywhere a browser does.
 */
export function composeBoard(input: {
  photo: { bytes: Buffer; mimeType: string };
  specs: BoardSpecs;
  studio: string;
}): Buffer {
  const { photo, specs } = input;
  const parts: string[] = [];
  parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);

  // The rendering, cropped to its frame.
  const href = `data:${photo.mimeType};base64,${photo.bytes.toString('base64')}`;
  parts.push(`<defs><clipPath id="photo"><rect x="${PHOTO.x}" y="${PHOTO.y}" width="${PHOTO.w}" height="${PHOTO.h}"/></clipPath></defs>`);
  parts.push(`<rect x="${PHOTO.x}" y="${PHOTO.y}" width="${PHOTO.w}" height="${PHOTO.h}" fill="#f1efea"/>`);
  parts.push(`<image href="${href}" xlink:href="${href}" x="${PHOTO.x}" y="${PHOTO.y}" width="${PHOTO.w}" height="${PHOTO.h}" preserveAspectRatio="xMidYMid slice" clip-path="url(#photo)"/>`);

  // Overall dimensions, only where the brief gave them.
  if (specs.height_label) {
    const x = 55;
    parts.push(`<line x1="${x}" y1="${PHOTO.y}" x2="${x}" y2="${PHOTO.y + PHOTO.h}" stroke="${SOFT}" stroke-width="1"/>`);
    parts.push(`<line x1="${x - 7}" y1="${PHOTO.y}" x2="${x + 7}" y2="${PHOTO.y}" stroke="${SOFT}"/><line x1="${x - 7}" y1="${PHOTO.y + PHOTO.h}" x2="${x + 7}" y2="${PHOTO.y + PHOTO.h}" stroke="${SOFT}"/>`);
    const cy = PHOTO.y + PHOTO.h / 2;
    parts.push(`<rect x="${x - 10}" y="${cy - 34}" width="20" height="68" fill="#ffffff"/>`);
    parts.push(`<text x="${x}" y="${cy}" font-family="${SANS}" font-size="15" fill="${INK}" text-anchor="middle" dominant-baseline="middle" transform="rotate(-90 ${x} ${cy})">${esc(specs.height_label)}</text>`);
  }
  if (specs.width_label) {
    const y = PHOTO.y + PHOTO.h + 28;
    parts.push(`<line x1="${PHOTO.x}" y1="${y}" x2="${PHOTO.x + PHOTO.w}" y2="${y}" stroke="${SOFT}"/>`);
    parts.push(`<line x1="${PHOTO.x}" y1="${y - 7}" x2="${PHOTO.x}" y2="${y + 7}" stroke="${SOFT}"/><line x1="${PHOTO.x + PHOTO.w}" y1="${y - 7}" x2="${PHOTO.x + PHOTO.w}" y2="${y + 7}" stroke="${SOFT}"/>`);
    const cx = PHOTO.x + PHOTO.w / 2;
    parts.push(`<rect x="${cx - 40}" y="${y - 12}" width="80" height="24" fill="#ffffff"/>`);
    parts.push(text(cx, y + 5, specs.width_label, { size: 15, anchor: 'middle' }));
  }

  // The specification column.
  let y = PHOTO.y;
  parts.push(`<line x1="${COLUMN.x}" y1="${y}" x2="${COLUMN.x + COLUMN.w}" y2="${y}" stroke="${RULE}"/>`);
  y += 26;
  const columnBottom = specs.notes.length ? 900 : 1040;
  for (const section of specs.sections) {
    const lines = section.lines.flatMap((l) => wrap(l, 44));
    const height = 20 + lines.length * 17 + 14;
    if (y + height > columnBottom) break;
    parts.push(text(COLUMN.x, y, section.heading, { size: 13.5, weight: 700, spacing: 1.6 }));
    y += 20;
    for (const line of lines) {
      parts.push(text(COLUMN.x, y, line, { size: 12.5, fill: SOFT }));
      y += 17;
    }
    y += 4;
    parts.push(`<line x1="${COLUMN.x}" y1="${y}" x2="${COLUMN.x + COLUMN.w}" y2="${y}" stroke="${RULE}" stroke-width="0.8"/>`);
    y += 24;
  }

  // Site notes, boxed at the foot of the column.
  if (specs.notes.length) {
    const lines = specs.notes.flatMap((n) => wrap(n, 46).map((l, i) => (i === 0 ? `•  ${l}` : `   ${l}`)));
    const top = Math.max(y, 920);
    const boxH = 30 + lines.length * 16;
    if (top + boxH < H - 20) {
      parts.push(`<rect x="${COLUMN.x}" y="${top}" width="${COLUMN.w}" height="${boxH}" fill="none" stroke="${RULE}"/>`);
      parts.push(text(COLUMN.x + 12, top + 20, 'NOTES', { size: 11.5, weight: 700, spacing: 1.4 }));
      lines.forEach((l, i) => parts.push(text(COLUMN.x + 12, top + 38 + i * 16, l, { size: 11, fill: SOFT })));
    }
  }

  // MATERIALS + FINISHES.
  const rowY = 715;
  const cx = PHOTO.x + PHOTO.w / 2;
  parts.push(`<line x1="${PHOTO.x}" y1="${rowY}" x2="${cx - 150}" y2="${rowY}" stroke="${RULE}"/><line x1="${cx + 150}" y1="${rowY}" x2="${PHOTO.x + PHOTO.w}" y2="${rowY}" stroke="${RULE}"/>`);
  parts.push(text(cx, rowY + 6, 'MATERIALS + FINISHES', { size: 16, spacing: 3, anchor: 'middle', family: SERIF }));

  const n = Math.max(1, specs.swatches.length);
  const slot = PHOTO.w / n;
  const size = Math.min(130, slot - 30);
  specs.swatches.forEach((s, i) => {
    const mid = PHOTO.x + slot * i + slot / 2;
    const top = rowY + 55;
    parts.push(text(mid, top - 14, s.label, { size: 11, spacing: 0.8, anchor: 'middle' }));
    parts.push(swatch(s, mid - size / 2, top, size, `sw${i}`));
    const under = [...wrap(s.name, 24), ...(s.detail ? wrap(s.detail, 24) : [])].slice(0, 4);
    under.forEach((l, j) => parts.push(text(mid, top + size + 22 + j * 16, l, { size: 12, fill: SOFT, anchor: 'middle' })));
  });

  // The studio.
  parts.push(`<line x1="${cx - 190}" y1="${H - 62}" x2="${cx + 190}" y2="${H - 62}" stroke="${RULE}" stroke-width="0.8"/>`);
  parts.push(text(cx, H - 36, input.studio.toUpperCase(), { size: 20, spacing: 6, anchor: 'middle', family: SERIF }));
  parts.push(text(cx, H - 16, 'INTERIOR DESIGN', { size: 11, spacing: 4, anchor: 'middle', family: SERIF, fill: SOFT }));

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${parts.join('')}</svg>`;
  return Buffer.from(svg, 'utf8');
}
