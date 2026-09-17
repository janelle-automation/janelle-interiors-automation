// ============================================================
//  The studio's prompt library, lifted from docs/reference/.
//
//  Source files (the written record of what Janelle asked for):
//    top-design-prompt.txt              → the 18 working prompts
//    tab2.txt, tab3.txt, tab4.txt       → the visual prompts
//    tab1.txt                           → snapshot clean-up
//    Brian Coleman Moodboard Prompt.txt → the 644 Adirondack board
//
//  Each entry is a row of `prompts`. `{{keys}}` are filled by the
//  runner in apps/api/src/routes/prompts.ts from the Studio's form,
//  so every key used in a template must also appear in `variables`
//  and must be \w+ — the runner's regex will not see anything else.
//
//  A note on the five visual prompts: the studio already has the
//  prompt text — what it wants back is the work. So these return the
//  finished deliverable: the board's own content, the specification
//  column, the shot direction. Claude cannot render an image, and a
//  prompt handed back for pasting elsewhere is not an answer, so each
//  one ends in the written artefact a designer can lay out.
// ============================================================

/** Shared closing rule: never invent what the studio did not supply. */
const NO_INVENTING =
  'Do not invent dimensions, products, manufacturers, SKUs or specifications. ' +
  'Where information has not been supplied, write TBD — DESIGN TEAM TO COMPLETE rather than guessing.';

/**
 * What a review prompt does when there is nothing to review.
 *
 * Someone types "Kitchen western style" into Kitchen design review, because
 * that is the kitchen prompt in the list and the kitchen is what they want.
 * Answering a page of TBD is technically correct and useless. A senior
 * designer handed a direction and no drawing designs the thing, then reviews
 * what they proposed — as long as it is unmistakably labelled a proposal.
 */
const DESIGN_IT_FIRST = (room, decisions, assumption) =>
  `IF THERE IS NOTHING TO REVIEW YET
When what you are given is a direction, a style or a brief rather than an actual ${room} — no plan, no elevation, no selections — design it, then review what you designed.

Do NOT ask for more information, and do not stop to request dimensions: the person asked for a ${room}, not a questionnaire. Assume a typical room of this kind — ${assumption} — state those assumptions in one short block at the top under ASSUMED, and design to them. Every figure that depends on the real room is written TBD — FIELD VERIFY beside your proposed number, so the assumption is visible rather than hidden.

Design: ${decisions}. State each as a proposal with the reasoning behind it, with real dimensions and clearances.

Then run the review below against your own proposal, so it arrives already checked, and end with the specific information that would let the studio firm it up.

Open with one line saying this is a proposed design rather than a review of an existing one, and mark every product-level choice PROPOSED — NOT YET APPROVED so it is never mistaken for a studio selection.`;

export const PROMPT_LIBRARY = [
  // ── Design direction ───────────────────────────────────────
  {
    title: 'Full project design direction',
    category: 'design',
    description: 'A cohesive room-by-room direction for a whole project, with everything unresolved marked TBD.',
    variables: [
      { key: 'project', label: 'Project', required: true },
      { key: 'brief', label: 'Client brief, plans, existing conditions', required: true },
      { key: 'budget', label: 'Budget & constraints', required: false },
      { key: 'inspiration', label: 'Inspiration / direction so far', required: false },
    ],
    template: `Act as a senior interior designer at a luxury residential and hospitality design firm.

Review the client brief, architectural plans, inspiration, existing conditions, budget and project constraints below, and develop a cohesive design direction for the entire project.

For each room, provide:
- Overall design concept
- Color palette
- Material direction
- Flooring
- Wall finishes
- Cabinetry / millwork direction
- Countertop and stone direction
- Plumbing finish
- Lighting direction
- Furniture style
- Textile direction
- Key architectural details
- Connections to adjacent rooms
- Items requiring client approval
- Information still missing

Maintain one cohesive design language throughout the project while allowing each room to have its own identity.

${NO_INVENTING}

PROJECT
{{project}}

BRIEF, PLANS AND EXISTING CONDITIONS
{{brief}}

BUDGET AND CONSTRAINTS
{{budget}}

INSPIRATION AND DIRECTION SO FAR
{{inspiration}}`,
  },

  {
    title: 'Room-by-room moodboard direction',
    category: 'design',
    description: 'Concept, palette and material direction for one room — direction only, not product selections.',
    variables: [
      { key: 'client', label: 'Client', required: true },
      { key: 'room', label: 'Room', required: true },
      { key: 'style', label: 'Project style', required: true },
      { key: 'budget', label: 'Budget level', required: false },
      { key: 'conditions', label: 'Existing conditions', required: false },
      { key: 'requests', label: 'Client requests', required: false },
    ],
    template: `Act as a senior interior designer.

Develop a moodboard direction for:

CLIENT: {{client}}
ROOM: {{room}}
PROJECT STYLE: {{style}}
BUDGET LEVEL: {{budget}}
EXISTING CONDITIONS: {{conditions}}
CLIENT REQUESTS: {{requests}}

Create a clear design concept including:
- 5–8 inspiration directions
- Overall color palette
- Tile / stone direction
- Wood tone
- Metal finish
- Cabinetry direction
- Wall finish
- Lighting style
- Furniture direction
- Textile direction
- Architectural details

Explain how the selections work together.

The moodboard should establish design direction only. Do not treat inspiration images as actual product selections.`,
  },

  {
    title: 'Pinterest research list',
    category: 'design',
    description: 'Designer-level Pinterest search phrases for a room, specific enough to skip the generic results.',
    variables: [
      { key: 'room', label: 'Room', required: true },
      { key: 'direction', label: 'Design description', required: true },
    ],
    template: `Act as an interior design research assistant.

I am designing a {{room}} with the following direction:

{{direction}}

Create a targeted Pinterest research list. Give me specific search phrases for:
- Overall room inspiration
- Tile layouts
- Tile patterns
- Cabinetry
- Millwork
- Stone
- Lighting
- Plumbing
- Furniture
- Architectural details
- Color palette

Avoid generic search terms. Give me highly specific Pinterest searches that will produce professional designer-level inspiration.`,
  },

  {
    title: 'Material selection package',
    category: 'design',
    description: 'Turns an approved direction into a per-surface material package, flagging finishes that compete.',
    variables: [
      { key: 'room', label: 'Room', required: true },
      { key: 'style', label: 'Style', required: true },
      { key: 'budget', label: 'Budget', required: false },
      { key: 'conditions', label: 'Architectural conditions', required: false },
      { key: 'direction', label: 'Approved design direction', required: true },
    ],
    template: `Act as a senior interior designer and materials specialist.

Using the approved moodboard and design direction, develop an actual material-selection package for this room.

ROOM: {{room}}
STYLE: {{style}}
BUDGET: {{budget}}
ARCHITECTURAL CONDITIONS: {{conditions}}

APPROVED DESIGN DIRECTION
{{direction}}

Select or define the requirements for: flooring, wall tile, shower tile, shower flooring, stone, countertop, backsplash, cabinet finish, cabinet hardware, paint, wallpaper, plumbing finish and decorative lighting.

For each selection provide:
- Material category
- Recommended material
- Color
- Finish
- Size
- Application
- Design rationale
- Sample required: Yes / No
- Information still needed

Flag any material combinations that may compete visually.

${NO_INVENTING}`,
  },

  {
    title: 'Finish schedule',
    category: 'design',
    description: 'A professional room-by-room finish schedule built from the approved selections.',
    variables: [
      { key: 'project', label: 'Project', required: true },
      { key: 'selections', label: 'Approved selections', required: true },
    ],
    template: `Act as a senior interior designer and specifications coordinator.

Create a professional Finish Schedule from the approved project selections below. Organize it room by room.

For each finish include: Room, Category, Location, Manufacturer, Product, SKU, Color, Finish, Size, Installation direction, Grout if applicable, Edge / trim detail, Vendor, Product link, Status, Notes, Client approval status, GC quantity confirmation status.

Categories should include flooring, wall finish, tile, stone, countertops, backsplash, cabinetry, millwork, hardware, paint, wallpaper, plumbing and decorative lighting.

Do not invent missing information. Use TBD — DESIGN TEAM TO COMPLETE when information is unavailable.

PROJECT
{{project}}

APPROVED SELECTIONS
{{selections}}`,
  },

  {
    title: 'Interior elevation brief',
    category: 'design',
    description: 'What an elevation has to document, and which dimensions are missing before drafting starts.',
    variables: [
      { key: 'room', label: 'Room', required: true },
      { key: 'plans', label: 'Architectural plans & approved finishes', required: true },
    ],
    template: `Act as a senior interior designer and interior architectural designer.

Review the architectural plans and approved finish selections for this room, then create an interior elevation planning brief showing exactly what needs to be documented.

Include: overall wall dimensions, ceiling height, cabinetry, millwork, countertops, backsplashes, tile extents, tile direction, plumbing fixtures, mirrors, decorative lighting, niches, shelving, hardware, artwork, furniture if applicable, electrical coordination, mounting heights and key dimensions.

Identify any dimensions or architectural information missing before drafting begins.

The finished elevation should answer: WHAT GOES WHERE?

ROOM
{{room}}

PLANS AND APPROVED FINISHES
{{plans}}`,
  },

  {
    title: 'Elevation quality control',
    category: 'design',
    description: 'A senior review of a junior designer’s elevation — errors, gaps, and what needs GC confirmation.',
    variables: [
      { key: 'room', label: 'Room', required: true },
      { key: 'elevation', label: 'Elevation description & callouts', required: true },
      { key: 'plans', label: 'Architectural plans, to cross-check', required: false },
    ],
    template: `Act as a senior interior designer reviewing a junior designer's interior elevation.

Review the elevation for: accuracy, proportion, missing dimensions, tile placement, tile termination, centerlines, plumbing alignment, lighting alignment, mirror placement, cabinetry proportions, countertop thickness, hardware, niches, trim, material callouts, constructability and coordination with the architectural plans.

Identify, in this order:
1. Errors
2. Missing information
3. Items requiring GC confirmation
4. Items requiring Lead Designer approval
5. Recommended corrections

Do not approve the drawing if critical construction information is missing — say so plainly.

ROOM
{{room}}

ELEVATION
{{elevation}}

ARCHITECTURAL PLANS
{{plans}}`,
  },

  {
    title: 'Kitchen design review',
    category: 'design',
    description: 'Aesthetics and function on a kitchen — or, given only a direction, the designed kitchen and its review.',
    variables: [
      { key: 'project', label: 'Project', required: true },
      { key: 'design', label: 'Kitchen plan, elevation & selections', required: true },
    ],
    template: `Act as a senior kitchen designer.

${DESIGN_IT_FIRST(
      'kitchen',
      'the layout and work triangle, appliance placement, cabinetry and storage, drawer and pantry strategy, island size and seating, ventilation, lighting and electrical, countertop, backsplash, cabinet finish and hardware',
      'a 12 by 16 foot room with a 9 foot ceiling, one window over the sink, a single entry and a standard 36 inch range wall',
    )}

Review this kitchen design for both aesthetics and functionality.

Evaluate: appliance locations, work triangle, aisle clearances, landing areas, cabinet storage, drawer placement, trash location, pantry storage, island size, island seating, lighting, electrical, plumbing, ventilation, countertop material, backsplash, cabinet finishes, hardware, symmetry and sightlines.

Identify anything that may cause a construction, usability or aesthetic problem.

PROJECT
{{project}}

KITCHEN
{{design}}`,
  },

  {
    title: 'Bathroom design review',
    category: 'design',
    description: 'The details that come back as change orders — or, given only a direction, the designed bathroom and its review.',
    variables: [
      { key: 'project', label: 'Project', required: true },
      { key: 'design', label: 'Bathroom plan, elevation & finish package', required: true },
    ],
    template: `Act as a senior bathroom designer.

${DESIGN_IT_FIRST(
      'bathroom',
      'the vanity layout and sink placement, shower or tub configuration, controls and showerhead positions, niches and bench, mirror and sconce placement, tile layout and transitions, waterproofing, flooring, toilet clearances and lighting',
      'a 9 by 12 foot primary bath with a 9 foot ceiling, one window, a wet wall along the plumbing side and a single entry',
    )}

Review this bathroom plan, elevation and finish package.

Check: vanity layout, sink placement, faucet compatibility, mirror placement, sconce placement, shower controls, showerhead location, hand shower, niches, bench, grab bars if required, drain, tile layout, tile transitions, waterproof areas, flooring transitions, toilet clearances, accessories, electrical and lighting.

Identify missing information and anything requiring GC or plumber confirmation.

PROJECT
{{project}}

BATHROOM
{{design}}`,
  },

  // ── Procurement ────────────────────────────────────────────
  {
    title: 'FF&E schedule',
    category: 'procurement',
    description: 'Room-by-room FF&E schedule, plus the lead-time, pricing and sourcing risks hiding inside it.',
    variables: [
      { key: 'project', label: 'Project', required: true },
      { key: 'selections', label: 'Approved direction & product selections', required: true },
    ],
    template: `Act as a senior FF&E designer and procurement specialist.

Create a room-by-room FF&E schedule using the approved design direction and product selections below.

Track: Room, Item, Category, Manufacturer, Product, SKU, Finish, Dimensions, Quantity, Vendor, Product link, Retail price, Trade price, Client price, Lead time, Availability, Status, Client approval, Notes.

Then identify:
- Missing selections
- Missing pricing
- Missing dimensions
- Lead-time risks
- Products requiring samples
- Products requiring custom quotes
- Items that should be sourced immediately

${NO_INVENTING}

PROJECT
{{project}}

SELECTIONS
{{selections}}`,
  },

  {
    title: 'Procurement readiness audit',
    category: 'procurement',
    description: 'Every approved item sorted into ready to order, or exactly what it is waiting on.',
    variables: [
      { key: 'project', label: 'Project', required: true },
      { key: 'selections', label: 'Approved selections & quote status', required: true },
    ],
    template: `Act as a senior FF&E procurement manager.

Review all approved design selections and determine whether each item is ready for procurement.

Check: manufacturer, product, SKU, finish, dimensions, quantity, vendor, quote, availability, lead time, freight, client approval, Lead Designer approval, GC quantity approval and delivery location.

Classify every item as exactly one of:
READY TO ORDER
MISSING INFORMATION
WAITING ON CLIENT
WAITING ON GC
WAITING ON VENDOR
RESELECT REQUIRED

For every item that is not READY TO ORDER, state the single next action and who owns it.

PROJECT
{{project}}

SELECTIONS AND QUOTE STATUS
{{selections}}`,
  },

  // ── Client-facing ──────────────────────────────────────────
  {
    title: 'Design presentation review',
    category: 'client',
    description: 'A creative-director pass over a client presentation before it goes out, with a go / no-go verdict.',
    variables: [
      { key: 'project', label: 'Project', required: true },
      { key: 'presentation', label: 'Presentation contents, page by page', required: true },
    ],
    template: `Act as the Creative Director of a luxury interior design firm.

Review this client presentation before it goes to the client.

Evaluate: visual hierarchy, consistency, image quality, page layouts, typography, spacing, moodboard clarity, material presentation, elevation clarity, finish schedule, FF&E schedule, missing selections, TBD items and client decisions required.

Identify anything that looks unfinished, confusing, inconsistent or unprofessional.

Finish with three headed lists, in this order:
MUST FIX BEFORE CLIENT
SHOULD IMPROVE
READY TO PRESENT

PROJECT
{{project}}

PRESENTATION
{{presentation}}`,
  },

  {
    title: 'Client meeting preparation',
    category: 'client',
    description: 'A meeting agenda with the decisions that actually need the client, ordered by what matters.',
    variables: [
      { key: 'project', label: 'Project', required: true },
      { key: 'presentation', label: 'Presentation & current project state', required: true },
    ],
    template: `Act as the Lead Interior Designer preparing for a client presentation.

Review the project presentation and create a meeting agenda.

Separate everything into:
- Decisions already made
- Items to present
- Items requiring client approval
- Alternatives to discuss
- Budget concerns
- Lead-time concerns
- Design questions
- Missing information
- GC questions
- Architect questions

Put the most important client decisions first.

PROJECT
{{project}}

PRESENTATION AND CURRENT STATE
{{presentation}}`,
  },

  {
    title: 'Client approval audit',
    category: 'client',
    description: 'The approval status of every selection, and the one next action on each unresolved item.',
    variables: [
      { key: 'project', label: 'Project', required: true },
      { key: 'selections', label: 'Selections & approval history', required: true },
    ],
    template: `Review the project and identify the approval status of every material and FF&E selection.

Sort into:
APPROVED
WAITING FOR CLIENT
WAITING FOR LEAD DESIGNER
RESELECT
TBD
NOT YET PRESENTED

For each unresolved item, state exactly what action needs to happen next and who owns it.

PROJECT
{{project}}

SELECTIONS AND APPROVAL HISTORY
{{selections}}`,
  },

  // ── Admin & oversight ──────────────────────────────────────
  {
    title: 'Meeting notes to design tasks',
    category: 'admin',
    description: 'Raw notes converted into owned, dated tasks — with nothing invented where the notes are silent.',
    variables: [
      { key: 'notes', label: 'Meeting notes', required: true },
      { key: 'project', label: 'Project', required: false },
    ],
    template: `Act as a senior interior design project manager.

Convert these meeting notes into actionable tasks, organized by: Design, Drawings, Materials, FF&E, Procurement, GC, Architect, Vendor, Client, Lead Designer.

For every task provide: Task, Room, Owner, Due date if known, Dependency, Status, Priority.

Do not invent responsibilities or deadlines. If unknown, use OWNER TO BE ASSIGNED or DATE TBD.

PROJECT
{{project}}

MEETING NOTES
{{notes}}`,
  },

  {
    title: 'Missing-information audit',
    category: 'admin',
    description: 'A red / yellow / green punch list of everything still missing, room by room.',
    variables: [
      { key: 'project', label: 'Project', required: true },
      { key: 'state', label: 'Current project state, room by room', required: true },
    ],
    template: `Act as a senior interior designer performing a completeness audit.

Review the entire project. For every room, identify missing: moodboards, material selections, finish selections, plumbing, lighting, flooring, paint, wallpaper, cabinet finishes, hardware, elevations, dimensions, FF&E, client approvals, samples, vendor quotes, GC information and architect information.

Create a punch list organized as:
RED — Blocking progress
YELLOW — Needed soon
GREEN — Can wait

PROJECT
{{project}}

CURRENT STATE
{{state}}`,
  },

  {
    title: 'Designer hours review',
    category: 'admin',
    description: 'Actual hours against target, what should have been delegated, and hours left to finish.',
    variables: [
      { key: 'designer', label: 'Designer', required: true },
      { key: 'project', label: 'Project', required: true },
      { key: 'hours', label: 'Time logged, by activity', required: true },
    ],
    template: `Act as the COO of an interior design firm.

Review the designer's time spent on this project and compare actual hours against standard target hours for: project setup, moodboards, material sourcing, plumbing, lighting, elevations, finish schedule, FF&E sourcing, FF&E schedule, presentation updates, client revisions and coordination.

Identify: appropriate hours, excessive hours, work that should have been delegated, rework, client-driven revisions, scope creep and opportunities to improve efficiency.

Finish with the recommended hours remaining to complete the project.

DESIGNER
{{designer}}

PROJECT
{{project}}

TIME LOGGED
{{hours}}`,
  },

  {
    title: 'Weekly lead designer review',
    category: 'admin',
    description: 'Where the project actually stands, ending in the team’s top ten priorities for the week.',
    variables: [
      { key: 'project', label: 'Project', required: true },
      { key: 'state', label: 'Current project state', required: true },
    ],
    template: `Act as the Lead Designer and COO.

Review the entire project and report: current design phase, percent design complete, rooms complete, rooms incomplete, client approvals outstanding, Lead Designer approvals outstanding, missing elevations, missing materials, missing FF&E, missing finish schedule information, missing vendor quotes, GC decisions needed, long-lead risks, designer tasks overdue and procurement tasks overdue.

Then create the top 10 priorities for the design team this week, most important first.

PROJECT
{{project}}

CURRENT STATE
{{state}}`,
  },

  // ── Visual work (these return the deliverable, not a prompt) ───
  {
    title: 'Presentation rendering brief',
    renamedFrom: 'Presentation rendering prompt',
    category: 'design',
    description: 'The rendering package for a room: what the visualization must show, surface by surface, and what it must not change.',
    variables: [
      { key: 'room', label: 'Room name', required: true },
      { key: 'cabinetry', label: 'Cabinetry — style / color / wood', required: false },
      { key: 'countertop', label: 'Countertop material', required: false },
      { key: 'backsplash', label: 'Backsplash — tile / stone', required: false },
      { key: 'walls', label: 'Wall finish', required: false },
      { key: 'flooring', label: 'Flooring', required: false },
      { key: 'hardware', label: 'Hardware — finish / style', required: false },
      { key: 'lighting', label: 'Lighting — fixtures / color temperature', required: false },
      { key: 'plumbing', label: 'Appliances & plumbing', required: false },
      { key: 'details', label: 'Special architectural details', required: false },
      { key: 'notes', label: 'Additional instructions', required: false },
    ],
    template: `Act as a senior interior designer, architectural visualization artist and luxury hospitality photographer.

Produce the rendering package for this room — the document the visualizer works from to turn the supplied architectural elevation and the studio's material selections into one photorealistic client-presentation image. Hold it to every standard below.

PRIORITY #1 — FOLLOW THE ELEVATION
The architectural elevation is the primary guide. Preserve room proportions, cabinet locations, cabinet widths and heights, drawer and door configurations, appliance locations, window and door locations and proportions, hood size and shape, millwork details, countertop heights, backsplash locations, niches, shelving, architectural openings, symmetry and spacing. Do not redesign the cabinetry or architecture. Where the elevation and the inspiration photographs conflict, the elevation wins.

MATERIAL APPLICATION
Apply the supplied material references realistically. Cabinetry: the exact door style, wood tone, paint color, grain direction, panel detailing, fluting, molding and finish shown. Countertops and stone: preserve color, veining character, movement and scale, with believable slab placement and bookmatching that never becomes busy. Backsplash and tile: tile size, color, finish, variation, grout and handmade texture, applied only where the elevation indicates. Hardware: matching finish and style at realistic scale and placement. Walls: accurate plaster, limewash, paint, stone, wood or specialty finish with subtle natural variation.

VISUAL STYLE
A photorealistic luxury interior editorial photograph, not a computer rendering — as though the completed space were shot for Architectural Digest, Veranda, House Beautiful, Elle Decor, Hospitality Design or a luxury hotel portfolio. Sophisticated natural lighting, soft directional daylight, subtle ambient interior light, soft shadows, realistic reflections, accurate textures, natural depth, balanced exposure, refined neutral color grading, crisp architectural detail.

CAMERA AND COMPOSITION
Straight vertical architectural lines, correct perspective, eye-level camera, a 24–35mm architectural lens look, balanced composition, minimal distortion, natural depth of field, full visibility of the important design features. Favor a straight-on composition. No dramatic wide-angle distortion.

STYLING
Minimal and presentation-ready: a few books, ceramic vessels, branches or greenery, small decorative objects. Styling supports the architecture; it never hides the design. Do not clutter countertops.

RESTRICTIONS
Do not change the architectural layout, add or remove windows, add cabinets that are not shown, change cabinet configurations, invent architectural details, place artwork where windows are shown, change or substitute selected materials, change tile color, change appliances, over-style the room, or make surfaces unnaturally perfect. If a detail is unclear, take the simplest reading of the elevation rather than inventing something.

PROJECT-SPECIFIC NOTES
Room: {{room}}
Cabinetry: {{cabinetry}}
Countertop: {{countertop}}
Backsplash: {{backsplash}}
Wall finish: {{walls}}
Flooring: {{flooring}}
Hardware: {{hardware}}
Lighting: {{lighting}}
Appliances / plumbing: {{plumbing}}
Special architectural details: {{details}}
Additional instructions: {{notes}}

OUTPUT
Return the finished brief under these headings, and nothing else:

SCENE — the room, the view the image takes, and what it has to communicate.
SURFACE BY SURFACE — each surface in turn (cabinetry, countertop, backsplash, walls, flooring, hardware, lighting, plumbing and appliances, architectural details): exactly how the selected material is applied, where it stops, and how it should read.
LIGHT AND CAMERA — the lighting condition, time of day, camera position and lens character for this specific room.
STYLING — the few objects that appear, and where.
DO NOT — the specific things that must not change in this room.
OPEN QUESTIONS — every detail not supplied above, as TBD — CONFIRM with the question that needs answering.

Be specific to this room. Do not restate the general standards as a checklist, and do not invent a material, dimension or product that was not given.`,
  },

  {
    title: 'Primary bathroom moodboard',
    renamedFrom: 'Primary bathroom moodboard prompt',
    category: 'design',
    description: 'The finished board content — palette, per-element selections, layout and titles — ready to lay out in Canva.',
    variables: [
      { key: 'project', label: 'Project', required: true },
      { key: 'room', label: 'Room', required: false },
      { key: 'inspiration', label: 'What the inspiration images show', required: false },
      { key: 'adjust', label: 'Anything to change from the house direction', required: false },
    ],
    template: `Act as my Senior Interior Designer and Luxury Residential Design Director.

Produce the finished moodboard content for this bathroom — the written board a designer lays out, not a description of how to make one. It must match the visual language, material palette, warmth and architectural character of the supplied inspiration, and must not read as a generic luxury bathroom.

OVERALL DESIGN STYLE
Warm, European, quiet luxury, organic, refined, textural, architectural, sophisticated, slightly Mediterranean, contemporary with traditional detailing, custom rather than trendy. The palette stays soft and tonal, with contrast coming from natural stone veining, warm wood, aged metal and subtle architectural detail. Avoid bright white, cool gray, stark black-and-white contrast, overly modern cabinetry and anything commercial.

PALETTE
Warm ivory, cream, putty, sand, soft taupe, pale natural oak, warm marble white, muted plum or burgundy veining, aged brass and brushed bronze. Sun-washed and soft overall.

KEY ELEMENTS
1. Vanity and millwork — light natural oak as a major element: rift-cut or straight grain, soft natural matte finish, warm blonde tone, thin furniture-style reveals, inset or refined framed cabinetry, large drawers, minimal ornamentation, with select fluted or reeded drawer fronts. Custom, European, handcrafted. Avoid orange oak, rustic grain, shaker-heavy cabinetry and dark stains.
2. Vanity stone — a dramatic but sophisticated marble: cream or warm white ground, gray veining, plum, burgundy, mauve or charcoal movement, strong organic patterning, in the spirit of Calacatta Viola, Arabescato Corchia, Breccia Capraia or Paonazzo. Used on countertop, sink area, backsplash, shelf ledges and select niche details as the signature decorative element.
3. Checkerboard stone floor — refined and muted, blending warm beige or limestone, white marble, gray-veined marble and occasional plum or dark veining. Honed, collected and European, never retro.
4. Shower walls — seamless warm plaster or plaster-look waterproof finish (tadelakt, lime plaster, microcement, mineral plaster) in soft ivory, warm beige, pale putty or creamy stone. Almost monolithic, calm and architectural rather than tile-heavy.
5. Shower niche — arched or softened shape, marble ledge, vertical handmade or slim-format tile inside for texture against the plaster, warm stone detailing, refined trim. Intentional and custom.
6. Shower floor — quiet and slip-resistant: warm honed limestone, small-format marble mosaic, cream stone mosaic or pale microcement-look, tonal with the plaster.
7. Freestanding tub — sculptural, soft oval, matte white, minimal profile, rounded edges, surrounded by warm architecture.
8. Plumbing — brushed brass, aged brass, satin bronze or soft champagne bronze, wall-mounted where appropriate. Avoid very yellow polished brass.
9. Hardware — slim brass T-bars, simple cylindrical pulls, small round knobs, select pieces with subtle stone or jewel-like inserts. Refined, never ornate.
10. Lighting — sculptural sconces with warm brass backplates, soft white glass, alabaster, ribbed or organic forms. Artisanal and European; no generic vanity bars or contemporary black fixtures.
11. Mirrors — softly rounded corners, subtle irregular or scalloped forms, thin aged-brass or bronze frames, vintage European influence.

BOARD LAYOUT
A polished presentation board on a warm ivory background with generous negative space: one hero inspiration image; a material palette showing natural oak, the dramatic marble, the checkerboard floor, warm plaster, niche tile, shower floor and brass finish; isolated feature references for the tub, vanity, wall-mounted faucet, sconce, mirror and cabinet hardware; and small detail moments for reeded cabinetry, marble edge detail, the arched niche, plaster texture, brass plumbing and stone veining.

TITLE
PRIMARY BATHROOM — DESIGN INSPIRATION
Subtitle: Natural Oak • Honed Marble • Warm Plaster • Aged Brass

The finished board should communicate warm European architecture, natural oak cabinetry, expressive Italian marble, plaster shower walls, sculptural forms and restrained aged brass — layered and luxurious, never flashy.

PROJECT
{{project}}
Room: {{room}}
What the inspiration images show: {{inspiration}}
Changes from the house direction: {{adjust}}

OUTPUT
Return the board itself, under these headings and nothing else:

TITLE — the board title and subtitle.
CONCEPT — two or three sentences on what this bathroom is, in the studio's voice, ready to read to the client.
MATERIAL PALETTE — one line per material (oak, vanity stone, floor, plaster, niche tile, shower floor, metal finish): what it is, its color and finish, and where it goes.
FEATURE ELEMENTS — vanity, tub, faucet, sconce, mirror and cabinet hardware, each with the specific character to source for.
DETAIL MOMENTS — the close-up moments the board should show, and why each earns its place.
HOW IT HOLDS TOGETHER — a short paragraph on why these selections work as one room.
STILL TO CONFIRM — anything the client or the studio has not settled, as TBD.

Name materials by character and type, never by invented SKU. Where the client's stated changes conflict with the house direction, follow the client and say so under STILL TO CONFIRM.`,
  },

  {
    title: 'Materials presentation styling',
    renamedFrom: 'Materials editorial photograph prompt',
    category: 'design',
    description: 'The shot direction for a materials page: what is in the flat-lay, how it is layered, lit and cleaned up.',
    variables: [
      { key: 'room', label: 'Room or board title', required: true },
      { key: 'materials', label: 'Materials in the snapshots', required: true },
      { key: 'palette', label: 'Palette notes / background preference', required: false },
    ],
    template: `Act as my Senior Interior Designer, Creative Director, Interior Stylist and Luxury Architectural Photographer.

Produce the shot direction that turns casual snapshots of these project materials into a sophisticated editorial materials page for a high-end presentation. Hold it to every standard below.

PRIMARY GOAL
An image that reads as professionally styled and photographed for Architectural Digest, Elle Decor, Luxe Interiors + Design, House Beautiful or a luxury residential studio presentation. Not a phone photo, sample-board snapshot, retail display or AI collage.

PRESERVE THE ACTUAL MATERIALS
The supplied samples are the approved or proposed materials. Preserve actual colors, veining, grain, texture, pattern, finish, scale, material character, hardware shape, tile shape and fabric pattern. Do not redesign or substitute.

COMPOSITION
A refined, layered designer flat-lay or editorial vignette with intentional overlap and visual hierarchy: larger architectural materials as the base, smaller samples layered naturally, stone and tile partially overlapping, wood anchoring the composition, fabric folded or softly draped, hardware and metal finishes as small accents, paint integrated subtly. Avoid perfectly straight rows and catalog grids. Curated, effortless, dimensional, expensive.

PHOTOGRAPHY
Soft natural daylight, warm diffused directional light, gentle architectural shadows, realistic texture, natural depth of field, crisp but not oversharpened detail, accurate whites, sophisticated neutral balance, subtle contrast. Overhead flat-lay or a slightly angled 30–45° editorial view.

BACKGROUND
Warm ivory plaster, soft limestone, pale natural oak, cream linen, light travertine, warm neutral microcement or off-white textured paper — whichever complements the materials without competing with the palette.

STYLING
Restrained only: a small architectural sketch, linen swatch, pencil, subtle drawing, stone fragment, minimal brass ruler or specification card. The materials stay the hero. No flowers, coffee cups, candles, books or jewelry.

REALISM
Stone shows authentic depth and veining; wood shows natural grain; fabric shows weave and softness; tile shows realistic surface irregularity; metal reflects without excessive shine; matte stays matte; polished reflects light naturally.

CLEAN UP THE SNAPSHOTS
Remove fingers, messy desks, packaging, stickers, barcodes, retail labels, background clutter, plastic wrapping, harsh overhead shadows, phone distortion, glare, poor white balance and distracting sample edges. Keep a manufacturer label only where it identifies the material, and integrate it subtly.

RESTRICTIONS
Do not invent major new materials, significantly change approved colors, make samples look computer-generated, add text that is not already on a sample, or turn the image into a cutout moodboard. The goal is a realistic, professionally styled photograph of the physical selections. Use a clean landscape composition with generous negative space, suitable for a presentation page, and title the board with the room name.

PROJECT SPECIFICS
Room / board title: {{room}}
Materials in the snapshots: {{materials}}
Palette and background notes: {{palette}}

OUTPUT
Return the direction for this specific page, under these headings and nothing else:

BOARD TITLE — the title as it appears on the page.
THE ARRANGEMENT — each supplied material in turn: where it sits, what it overlaps, how it is presented (slab, folded, propped, laid flat) and why.
BACKGROUND AND LIGHT — the background chosen for these materials, and the light that flatters them.
STYLING — the two or three restrained props, if any, and where they sit.
CLEAN-UP — the specific problems in these snapshots to remove.
WATCH FOR — any selection that will photograph badly beside another, and what to do about it.

Speak about the materials actually supplied. Do not add materials that were not listed.`,
  },

  {
    title: 'Snapshot to architectural photograph',
    category: 'design',
    description: 'The retouch direction for a site photo: perspective, light, texture and composition, to editorial standard.',
    variables: [
      { key: 'space', label: 'What the photo shows', required: true },
      { key: 'look', label: 'Style target', required: false },
      { key: 'fix', label: 'Problems to correct', required: false },
    ],
    template: `Act as a professional architectural photographer and retoucher.

Produce the retouch direction that takes this casual site snapshot to a high-end editorial architectural photograph suitable for design-magazine publication.

The finished prompt must ask for: corrected perspective and lens distortion, corrected vertical lines, an architectural lens perspective, lighting refined to soft natural daylight, enhanced material texture, balanced contrast and shadows, a refined neutral color palette, and a clean, sophisticated, editorial composition — ultra-realistic, sharp, professional photography in the register of Architectural Digest, Dezeen or a luxury hospitality portfolio. Cinematic but believable; never CGI, never over-processed, never a different room.

Where the space calls for it, choose the closest of these registers and say so in the prompt: luxury interior editorial, minimal Scandinavian architectural, hospitality design publication, or product photography of a material board.

PHOTO
What it shows: {{space}}
Style target: {{look}}
Problems to correct: {{fix}}

OUTPUT
Return the direction for this photograph, under these headings and nothing else:

REGISTER — which treatment this space calls for (luxury interior editorial, minimal Scandinavian architectural, hospitality publication, or material-board product photography) and why.
CORRECTIONS — the geometry and exposure work this photo needs, in the order it should be done.
LIGHT — what the light should become, and what to protect while getting there.
MATERIALS — the surfaces here whose texture has to survive the retouch.
COMPOSITION — the crop, and what it puts at the centre.
LEAVE ALONE — what must not be altered, invented or removed from this room.`,
  },

  {
    title: 'Elevation + moodboard board (house template)',
    category: 'design',
    description: 'The board’s written content for one room — specification column, materials row and notes box, in the locked house format.',
    variables: [
      { key: 'project', label: 'Project & address', required: true },
      { key: 'room', label: 'Room name', required: true },
      { key: 'location', label: 'Room location', required: false },
      { key: 'supplied', label: 'Files supplied — plans, renderings, material images', required: true },
      { key: 'specs', label: 'Material, hardware, plumbing & appliance specifications', required: false },
      { key: 'notes', label: 'Special installation notes', required: false },
    ],
    template: `Act as my lead interior designer and architectural presentation designer for the {{project}} project.

Produce the written content for one room's single-page Elevation + Moodboard, in the locked house format below.

TEMPLATE — LOCKED
Treat the approved Laundry Room board as the permanent house template. Do not redesign the presentation. Maintain the same landscape page proportion, white / warm-white background, thin architectural border and divider lines, large centered room title, small uppercase subtitle ELEVATIONS + MOODBOARD, elegant black serif title typography, clean architectural sans-serif specification typography, large architectural elevation in the upper-left / main portion, vertical specification column on the right, materials and finishes swatches across the lower portion, notes box in the lower-right when needed, restrained neutral style, image scale and spacing, swatch treatment, dimension-line styling, visual hierarchy and footer. The page architecture does not change from room to room — the whole house should read as one drawing set.

HEADER
{{project}} — {{room}}
Subtitle: ELEVATIONS + MOODBOARD

ARCHITECTURAL ELEVATION
Build the elevation from the supplied floor plan and layout. The plan is the source of truth: wall orientation, door and window locations, cabinet, appliance and plumbing locations, openings and room proportions. Do not move architectural elements to make the elevation prettier. Preserve any supplied cabinetry configuration. Draw cabinetry in a clean, realistic architectural elevation style, not a loose inspiration rendering. Add key dimensions only where the plan supports them, and never invent one.

MATERIALS + FINISHES
Use only the supplied product images and specifications — no generic substitutes, no similar products. Never invent manufacturer, product name, color, finish, size, SKU, grout, hardware size or installation pattern; write TBD — CONFIRM instead. Present samples in the same clean isolated swatch style as the template, covering cabinetry, countertop, backsplash / wall tile and flooring, plus shower wall tile, shower floor, niche tile, paint, wallcovering, wood flooring, stone or slab where they apply.

HARDWARE
Show the supplied hardware image and list manufacturer, collection / model, type, finish, size and center-to-center where applicable. Apply it to the elevation exactly as specified: one knob per cabinet door and a centered pull per drawer unless directed otherwise. Add no extra decorative hardware.

PLUMBING
Where the room has plumbing, give it a dedicated specification section using only the selected fixtures: manufacturer, type, model, finish and mounting. Place fixtures per the plan or supplied cabinetry drawing. Invent nothing.

APPLIANCES
If appliances are owner-, client- or renter-supplied, state N/A — OWNER / RENTER TO PROVIDE and show allowable dimensions only where supplied. Do not select a model that has not been approved.

NOTES
Use the lower-right notes box for construction-facing information — tile orientation, grout, countertop edge, slab use, hardware placement, field verification, special installation requirements. Concise and technical.

IMAGE RULES
The supplied project images are the source of truth. Crop product photos cleanly and remove showroom backgrounds where possible. Introduce no unrelated furniture, décor, plumbing, lighting, appliances, accessories, plants or styling objects. The board reads as an architectural specification sheet, not a Pinterest moodboard.

ACCURACY CHECK
Before the final image: compare the elevation against the supplied plan; verify doors and windows are on the correct sides; verify cabinetry and appliances have not moved; verify each material image matches its specification; verify hardware placement and tile orientation; verify every product name and finish. Remove anything that was not supplied, and use TBD — CONFIRM rather than guessing.

ROOM INPUT
Room: {{room}}
Location: {{location}}
Files supplied: {{supplied}}
Specifications: {{specs}}
Special installation notes: {{notes}}

OUTPUT
Return the board's content, under these headings and nothing else:

HEADER — the room title line and subtitle exactly as they appear.
ELEVATION NOTES — what the elevation must show, read off the supplied plan: what sits on which wall, what is preserved from the supplied cabinetry, and which dimensions the plan supports.
SPECIFICATION COLUMN — the right-hand column entry by entry (cabinetry, countertop, backsplash / wall tile, flooring, plus any shower tile, shower floor, niche tile, paint, wallcovering, wood, stone or slab that applies), each with manufacturer, product, color, finish, size and layout as supplied.
HARDWARE — manufacturer, collection or model, type, finish, size and centre-to-centre, and where it lands on the elevation.
PLUMBING — manufacturer, fixture type, model, finish and mounting for each selected fixture, and where the plan puts it.
APPLIANCES — the status line for this room.
MATERIALS ROW — the swatches across the lower portion, in order.
NOTES BOX — the construction-facing notes: tile orientation, grout, countertop edge, slab use, hardware placement, field verification, special installation.
TBD — CONFIRM — every gap, as a list the designer can take to the client or the GC.

Use TBD — CONFIRM rather than guessing, anywhere at all.`,
  },
];

/** Every {{key}} a template uses must be declared — caught before a run fails. */
export function validateLibrary(entries = PROMPT_LIBRARY) {
  const problems = [];
  for (const p of entries) {
    const declared = new Set(p.variables.map((v) => v.key));
    const used = new Set([...p.template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));
    for (const key of used) if (!declared.has(key)) problems.push(`${p.title}: {{${key}}} is not declared`);
    for (const key of declared) if (!used.has(key)) problems.push(`${p.title}: "${key}" is declared but never used`);
  }
  return problems;
}
