/**
 * Turning a library prompt into an instruction for an image model.
 *
 * The library prompts were written to be answered in words, and they still
 * are: the specification column of a board is text, and the studio wants it
 * whether or not a picture gets made. So a render reuses the same prompt,
 * drops its written-OUTPUT section, and substitutes an instruction that asks
 * for the page itself.
 *
 * Only these five produce a picture. The rest — schedules, audits, reviews —
 * are documents, and rendering one would be a photograph of a spreadsheet.
 */

/** The `OUTPUT` heading every library prompt ends with, as its own line. */
const OUTPUT_SECTION = /\nOUTPUT\n[\s\S]*$/;

const PRESENTATION_STANDARD = `Every word on the page must be legible and correctly spelled. Typeset it as a professional design studio would: a clear typographic hierarchy, generous margins, thin architectural rules, and restrained neutral styling. Where a value was not supplied, print TBD — CONFIRM rather than inventing one — a board full of honest TBDs is useful, and a board with invented product names is not.`;

export interface BoardPrompt {
  /** What the person is asking for, for the button and the file name. */
  label: string;
  /** What the image model is told to draw. Replaces the written OUTPUT. */
  instruction: string;
  /** The pictures this board wants, named so the person knows what to attach. */
  references: string[];
}

export const BOARD_PROMPTS: Record<string, BoardPrompt> = {
  'Elevation + moodboard board (house template)': {
    label: 'Elevation + moodboard board',
    instruction: `OUTPUT — RENDER THE BOARD
Produce ONE single-page landscape presentation board image, on a white or warm-white background.

Lay it out exactly as the approved house template does: large centred room title with the small uppercase subtitle ELEVATIONS + MOODBOARD beneath it; the architectural elevation occupying the upper-left main portion with its overall dimension lines; a vertical SPECIFICATIONS column down the right; a MATERIALS + FINISHES swatch row across the lower portion with HARDWARE, PLUMBING and APPLIANCES sections beside it; a NOTES box in the lower right; a thin footer rule with the project name.

If an approved template board is among the reference images, match its composition, margins, typography, rule weights, swatch treatment and graphic restraint exactly. Change only the room-specific content. The whole house must read as one drawing set.

Draw the elevation from the supplied plan and cabinetry images — same wall orientation, same door and window positions, same cabinet and appliance locations. Render the supplied material images as the swatches; do not substitute stock textures.

${PRESENTATION_STANDARD}`,
    references: [
      'The approved house template board',
      'Floor plan or layout plan',
      'Cabinetry or millwork rendering',
      'Material images',
      'Hardware images',
      'Plumbing fixture images',
    ],
  },

  'Presentation rendering brief': {
    label: 'Presentation rendering',
    instruction: `OUTPUT — RENDER THE ROOM
Produce ONE photorealistic interior photograph of this room as it will look built.

Follow the supplied elevation for room proportions, cabinet locations and widths, drawer and door configuration, appliance placement, window and door positions, hood size, niches and shelving. Apply the supplied material images to the surfaces they belong to, keeping their real colour, veining, grain and scale.

Light it as a leading architectural photographer would: soft directional daylight, subtle ambient interior light, soft shadows, realistic reflections, balanced exposure, refined neutral grading. Straight vertical lines, correct perspective, eye level, a 24–35mm lens look, a straight-on composition. Styling minimal — a few books, a ceramic vessel, some greenery — never covering the design.

Editorial, not CGI. Do not change the layout, add or remove windows, invent cabinetry, or substitute a material.`,
    references: ['Architectural elevation', 'Cabinetry rendering', 'Material images'],
  },

  'Primary bathroom moodboard': {
    label: 'Moodboard',
    instruction: `OUTPUT — RENDER THE MOODBOARD
Produce ONE landscape moodboard page on a warm ivory background with generous negative space.

Compose it as a luxury interior design presentation board: one large hero image establishing the room's character; a labelled material palette showing each material as an isolated swatch; isolated feature references for the vanity, tub, faucet, sconce, mirror and cabinet hardware; and a row of small detail moments. Put the board title and its subtitle at the top.

Where material images are supplied, use those exact materials as the swatches rather than generic substitutes.

${PRESENTATION_STANDARD}`,
    references: ['Inspiration images', 'Material images', 'Fixture and hardware images'],
  },

  'Materials presentation styling': {
    label: 'Materials page',
    instruction: `OUTPUT — RENDER THE MATERIALS PAGE
Produce ONE landscape editorial photograph of the supplied materials, styled and lit as a luxury design studio would photograph them for a client presentation.

A refined layered flat-lay, or a slightly angled 30–45° view: larger architectural materials as the base, smaller samples layered naturally, stone and tile overlapping, wood anchoring, fabric softly draped, hardware as small accents. Soft natural daylight, gentle shadows, accurate whites, generous negative space, the room name set quietly at the top.

Preserve the supplied materials exactly — their colour, veining, grain, pattern, finish and scale. Remove fingers, packaging, labels, clutter and phone-camera distortion. No flowers, candles, coffee cups or props that compete with the selections.`,
    references: ['Snapshots of the materials'],
  },

  'Snapshot to architectural photograph': {
    label: 'Retouched photograph',
    instruction: `OUTPUT — RENDER THE PHOTOGRAPH
Produce ONE corrected, editorial-quality architectural photograph of the supplied snapshot.

Correct the perspective and lens distortion, straighten the verticals, refine the light to soft natural daylight, recover the material texture, balance the contrast, and crop to a clean composition. Keep it the same room: do not move, add or remove anything architectural, and do not substitute a finish.

Ultra-realistic and sharp. Never CGI, never over-processed.`,
    references: ['The snapshot to correct'],
  },
};

/**
 * A board nobody wrote a prompt for.
 *
 * The library covers the boards a studio makes every week. It was never
 * meant to be the limit of what can be drawn — asked for a flooring-plan
 * board, the honest answer is to draw one to the same standard, not to
 * report that the library has no entry for it. The house rules still apply:
 * only what was supplied, TBD — CONFIRM for the rest.
 */
export function freeformBoard(brief: string): string {
  return `Act as the lead interior designer and architectural presentation designer for this studio.

Produce a single-page landscape presentation board for the following request.

THE REQUEST
${brief.trim()}

HOW THIS STUDIO'S BOARDS ARE BUILT
Landscape page on a white or warm-white background. A large centred title with a small uppercase subtitle beneath it. Thin architectural rules dividing the page. The main drawing or plan occupying the upper-left main portion, with its dimension lines. A vertical SPECIFICATIONS column down the right, set as label-and-value pairs. A MATERIALS + FINISHES swatch row across the lower portion, each swatch named. A NOTES box in the lower right for construction-facing notes. A thin footer rule carrying the project name.

If an approved board from this house is among the reference images, match its composition, margins, typography, rule weights, swatch treatment and graphic restraint exactly, and change only the content. Every board in a house should read as one drawing set.

Use only what was supplied. Do not invent a manufacturer, product name, colour, finish, size, SKU, grout, hardware dimension or installation pattern, and do not put a figure on a dimension that was not given — write TBD — CONFIRM instead. A board full of honest TBDs is useful; a board with invented specifications is worse than none.

${PRESENTATION_STANDARD}`;
}

export function isRenderable(title: string): boolean {
  return Object.hasOwn(BOARD_PROMPTS, title);
}

/**
 * The prompt an image model receives: the studio's own prompt, minus the
 * instruction to answer in words, plus the instruction to draw the page.
 */
export function boardPrompt(title: string, filledTemplate: string): string | null {
  const board = BOARD_PROMPTS[title];
  if (!board) return null;
  return `${filledTemplate.replace(OUTPUT_SECTION, '').trimEnd()}\n\n${board.instruction}`;
}
