import type Anthropic from '@anthropic-ai/sdk';
import { extractJson, type CallContext } from './anthropic.js';
import { INLINE_PDF_BYTES } from './extract.js';
import { fitPages, pdfCutter, type PdfCutter } from './files.js';
import { pdfPageTexts } from '../lib/pdfText.js';
import { documentText, isDocument, isWorkbook, workbookText } from '../lib/xlsx.js';

/**
 * Reading a PDF or an image to answer one request about it.
 *
 * Page numbers matter as much as the words: they are what lets Jenny show
 * the living room board itself rather than describe it. Design decks carry
 * their answers in pictures — a rendering, a product photo, a finish swatch —
 * so a page counts when its image answers the request, not only its text.
 */
const READ_DOCUMENT_SYSTEM = `You are reading a document or image for an interior design studio, to answer one request about it.

Return JSON with exactly these keys:
- "answer": 2 to 5 sentences answering the request from the document itself, concretely — the pieces, products,
  finishes, fabrics, colours, dimensions, quantities, prices and suppliers where they are shown. If the document
  does not contain what was asked, say that plainly and say what it does contain instead.
- "findings": up to 12 objects { "title", "detail", "page" }, one per piece or element that answers the request —
  "title" is the item ("Banquette, 30in table"), "detail" what the document says about it, "page" where it is.
- "pages": the page numbers (1-based, of the document as given) that SHOW the answer, most relevant first, at most 6.
  Count a page whose images, renderings, mood boards or product photos show it, even when the words are elsewhere.
  [] when nothing answers the request.

Read images as carefully as text. Never invent a detail that is not in the document.`;

/**
 * The largest PDF that can still be sent inline.
 *
 * A request carries at most 32MB and base64 grows a file by a third, so a
 * 24MB PDF is already over before the prompt is added. 22MB leaves room
 * for the rest of the request.
 */
const INLINE_HARD_LIMIT = 22 * 1024 * 1024;

/**
 * Finding pages in a long document by their text.
 *
 * The model is shown one line per page — its title and first words, or that
 * it is a picture — and picks where the answer is. A plan set's drawings
 * carry their titles inside the picture, so the contents page matters: it
 * gives the order of sections, and a picture-only page sits where its
 * section falls.
 */
const PAGE_PICK_SYSTEM = `You are finding pages in a long document for an interior design studio, to answer one request.
You are given each page's own text, or "[picture only]" for a page with no text — a drawing, plan, elevation,
rendering or mood board whose title is part of the image.

Return JSON: {"pages": [page numbers most likely to SHOW what is asked for, most likely first, 1 to 6 of them]}.
- A page title or heading that names it is the strongest evidence.
- A contents or index page gives the ORDER of the sections. Its numbers ("3. WHOLE-HOUSE FLOORING") are SECTION
  numbers, never page numbers: section 3 is not page 3. Work out where each section starts from the page texts
  that follow, and place a picture-only page by the sections around it — a plan or drawing asked for by name is
  usually the picture-only page that falls where its section does.
- When the request is for a drawing, plan, elevation, rendering or image, prefer picture-only pages over tables
  that merely mention the same words.
- When unsure, list several candidates rather than one guess — they are all checked by eye afterwards.
- Do not pick the contents page itself unless the contents are what is asked for.
- [] only when no page could hold it.`;

/** A request for something seen rather than read — the page itself is the answer. */
const VISUAL_REQUEST = /\b(plan|drawing|elevation|render(ing)?|image|picture|photo|board|layout|sketch|diagram|mood ?board|page)s?\b/i;

/** Above this a PDF is not sent whole: its pages are picked first, or it is read in windows. */
const LARGE_PDF_BYTES = INLINE_PDF_BYTES;
/** The picked pages, cut, are held to this — a handful of picture pages. */
const PICKED_MAX_BYTES = 14 * 1024 * 1024;
/** A window of a PDF with no text to go by: about this heavy, at most this many pages. */
const WINDOW_TARGET_BYTES = 9 * 1024 * 1024;
const WINDOW_MAX_PAGES = 20;
/** Windows read side by side; past this the rest of the document is left, and the answer says so. */
const MAX_WINDOWS = 6;
/** Reading a picked set or a window: longer than an email, well inside the assistant's 40s. */
const PART_TIMEOUT_MS = 30_000;
const PICK_TIMEOUT_MS = 15_000;

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

/** Claude refuses larger images; the same limit, said here in words. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface DocumentFinding {
  title?: string;
  detail?: string;
  page?: number;
}

export type DocumentReading =
  | {
      read: true;
      kind: 'pdf' | 'image' | 'sheet';
      answer: string;
      findings: DocumentFinding[];
      /** Pages of the original that show the answer — empty for an image. */
      pages: number[];
      /** Set when only part of a long document was read. */
      scope?: string;
    }
  | { read: false; note: string };

export async function readDocument(
  file: { bytes: Buffer; mimeType: string; name: string },
  question: string,
  ctx: CallContext,
): Promise<DocumentReading> {
  const isPdf = file.mimeType === 'application/pdf' || /\.pdf$/i.test(file.name);
  const imageType = IMAGE_TYPES.find((t) => t === file.mimeType) as ImageType | undefined;

  let content: Anthropic.ContentBlockParam[];
  let pageCount: number | null = null;

  if (isPdf) {
    const cutter = await pdfCutter(file.bytes);
    if (!cutter) return { read: false, note: 'This PDF could not be opened to read.' };
    pageCount = cutter.pageCount;

    // A big or long PDF is never sent whole. It used to be uploaded entire —
    // 45MB of plan set, to find the one page that was the flooring plan —
    // and the upload timed out into "too large to read". Its pages are
    // picked first instead, and only those are read.
    if (file.bytes.byteLength > LARGE_PDF_BYTES || pageCount > 100) {
      return readLargePdf(file, cutter, question, ctx);
    }
    content = [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.bytes.toString('base64') } }];
  } else if (imageType) {
    if (file.bytes.byteLength > MAX_IMAGE_BYTES) {
      return { read: false, note: 'This image is too large to read here. Offer the file itself instead.' };
    }
    content = [{ type: 'image', source: { type: 'base64', media_type: imageType, data: file.bytes.toString('base64') } }];
  } else if (isWorkbook(file.mimeType, file.name)) {
    // A schedule is the studio's most answerable document — the flooring
    // schedule, the FF&E list, a vendor's quote — and until this existed
    // the honest answer was "I cannot open it", which came out sounding
    // like "the finishes are listed in the Finish Schedule" while holding
    // the Finish Schedule.
    const sheet = workbookText(file.bytes);
    if (!sheet) {
      return { read: false, note: 'That workbook could not be opened. Offer the file itself instead.' };
    }
    content = [{ type: 'text', text: sheet }];
  } else if (isDocument(file.mimeType, file.name)) {
    const words = documentText(file.bytes);
    if (!words) {
      return { read: false, note: 'That document could not be opened. Offer the file itself instead.' };
    }
    content = [{ type: 'text', text: words }];
  } else if (file.mimeType.startsWith('text/') || /\.(txt|csv|md|tsv)$/i.test(file.name)) {
    const words = file.bytes.toString('utf8').slice(0, 12_000);
    if (!words.trim()) return { read: false, note: 'That file is empty.' };
    content = [{ type: 'text', text: words }];
  } else {
    return {
      read: false,
      note: 'Only PDFs, images, spreadsheets, Word documents and text can be read this way. For a Google Doc use drive_read; otherwise offer the file itself.',
    };
  }

  /**
   * A plan set needs longer than a quote does.
   *
   * The default reading bound is 25 seconds, which is right for a two-page
   * confirmation and marginal for a 65-page drawing set — and a set is
   * exactly what gets read when someone asks which page the flooring plan
   * is on. Timing out there does not produce a late answer; it produces a
   * fallback, and the fallback has been Jenny drawing her own version of a
   * drawing the studio had already issued.
   *
   * Bounded at 35s rather than higher because of what sits around it: the
   * assistant's own budget is 40s and the function is killed at 60s, so a
   * longer read would leave no room for the answer that follows it. Raise
   * ASSISTANT_BUDGET_MS and the host's maxDuration together if the studio's
   * plan sets need more.
   */
  const timeoutMs = pageCount && pageCount > 20 ? 35_000 : undefined;

  const reading = await extractJson<RawReading>(
    READ_DOCUMENT_SYSTEM,
    [...content, { type: 'text', text: `File: ${file.name}\nRequest: ${question}` }],
    ctx,
    timeoutMs,
  );
  if (!reading?.answer) return { read: false, note: 'The document could not be read.' };

  const maxPage = pageCount ?? Number.MAX_SAFE_INTEGER;
  const pages = isPdf
    ? [...new Set((reading.pages ?? []).map(Number))].filter((n) => Number.isInteger(n) && n >= 1 && n <= maxPage).slice(0, 6)
    : [];

  return {
    read: true,
    kind: isPdf ? 'pdf' : imageType ? 'image' : 'sheet',
    answer: reading.answer,
    findings: (reading.findings ?? []).slice(0, 12),
    pages,
  };
}

// ── Large PDFs ─────────────────────────────────────────────

interface RawReading {
  answer?: string;
  findings?: DocumentFinding[];
  pages?: unknown[];
}

type FileIn = { bytes: Buffer; mimeType: string; name: string };

const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(0)}MB`;

/**
 * A big PDF, read by the pages that matter.
 *
 * With a text layer — nearly every exported deck and schedule — the model
 * is shown one line per page and picks where the answer is, and only those
 * pages are cut out and read: one small request instead of a 45MB one.
 * Without one (a scan, a deck of flattened pictures) the document is read
 * in windows of a few MB side by side, as far as the clock allows.
 */
async function readLargePdf(file: FileIn, cutter: PdfCutter, question: string, ctx: CallContext): Promise<DocumentReading> {
  const total = cutter.pageCount;
  const texts = await pdfPageTexts(file.bytes);
  const withText = texts?.filter(Boolean).length ?? 0;

  if (texts && texts.length === total && withText >= Math.ceil(total * 0.4)) {
    const picked = await pickPages(texts, file.name, question, ctx);

    // Asked for a plan or a drawing, the pages that are only a picture are
    // candidates whatever the pick said: their titles are inside the image,
    // so the text cannot vouch for them, and there are rarely many. The
    // model's picks go first, so they survive the size limit.
    const pictures = VISUAL_REQUEST.test(question)
      ? texts.flatMap((t, i) => (t ? [] : [i + 1]))
      : [];
    const candidates = [...new Set([...picked, ...pictures])].slice(0, 10);

    if (candidates.length) {
      const { pages, bytes } = await fitPages(cutter, candidates, PICKED_MAX_BYTES);
      const reading = await readPart(bytes, pages, file.name, question, ctx);
      // Found it: done. Read and found nothing: the pick was wrong, and the
      // whole document is read before anyone is told it is not there.
      if (reading && (reading.pages.length || reading.findings.length)) {
        return {
          ...reading,
          scope: `Read ${pages.length === 1 ? 'page' : 'pages'} ${pages.join(', ')} of ${total}, chosen from the document's own page titles.`,
        };
      }
    }
  }

  return readInWindows(file, cutter, question, ctx);
}

/** The pages most likely to show the answer, judged from their text alone. */
async function pickPages(texts: string[], name: string, question: string, ctx: CallContext): Promise<number[]> {
  // Room for a contents page to be read whole, within a prompt that stays
  // small however long the document is.
  const each = Math.max(120, Math.min(600, Math.floor(40_000 / texts.length)));
  const lines = texts.map((t, i) => `p${i + 1}: ${t ? t.slice(0, each) : '[picture only]'}`);
  try {
    const picked = await extractJson<{ pages?: unknown[] }>(
      PAGE_PICK_SYSTEM,
      `File: ${name} (${texts.length} pages)\nRequest: ${question}\n\n${lines.join('\n')}`,
      ctx,
      PICK_TIMEOUT_MS,
    );
    return [...new Set((picked?.pages ?? []).map(Number))]
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= texts.length)
      .slice(0, 6);
  } catch (err) {
    console.warn('[read] picking pages failed:', (err as Error).message);
    return [];
  }
}

/**
 * Read a cut of the document whose pages are `original`, in that order.
 *
 * The model numbers the cut 1..k; the numbers are mapped back here rather
 * than trusting it to count from an offset, so a preview always opens on
 * the page it describes.
 */
async function readPart(
  bytes: Buffer,
  original: number[],
  name: string,
  question: string,
  ctx: CallContext,
): Promise<Extract<DocumentReading, { read: true }> | null> {
  if (!original.length || bytes.byteLength > INLINE_HARD_LIMIT) return null;
  let reading: RawReading | null;
  try {
    reading = await extractJson<RawReading>(
      READ_DOCUMENT_SYSTEM,
      [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') } },
        {
          type: 'text',
          // Its page numbers are the cut's, not the document's — so they go
          // in "pages", where they are mapped back, and never into the prose,
          // where "shown on page 1" would send someone to the cover.
          text: `File: ${name} — ${original.length === 1 ? 'one page' : `${original.length} pages`} of it, numbered 1 to ${original.length} here. Give page numbers only in "pages" and each finding's "page"; never mention a page number in "answer" or "detail".\nRequest: ${question}`,
        },
      ],
      ctx,
      PART_TIMEOUT_MS,
    );
  } catch (err) {
    console.warn(`[read] reading part of ${name} failed:`, (err as Error).message);
    return null;
  }
  if (!reading?.answer) return null;

  const toOriginal = (n: unknown): number | null => {
    const k = Number(n);
    return Number.isInteger(k) && k >= 1 && k <= original.length ? original[k - 1] : null;
  };
  return {
    read: true,
    kind: 'pdf',
    answer: reading.answer,
    findings: (reading.findings ?? []).slice(0, 12).map((f) => ({ ...f, page: toOriginal(f.page) ?? undefined })),
    pages: [...new Set((reading.pages ?? []).map(toOriginal).filter((n): n is number => n !== null))].slice(0, 6),
  };
}

/**
 * No text to go by: read consecutive windows of a few MB, side by side.
 *
 * Side by side because one after another would not fit the clock; windows
 * rather than the whole file because a request carries 32MB at most and a
 * plan set is larger than that. Past MAX_WINDOWS the rest is left unread,
 * and the answer says which pages were covered.
 */
async function readInWindows(file: FileIn, cutter: PdfCutter, question: string, ctx: CallContext): Promise<DocumentReading> {
  const total = cutter.pageCount;
  const perPage = file.bytes.byteLength / Math.max(1, total);
  const size = Math.max(1, Math.min(WINDOW_MAX_PAGES, Math.floor(WINDOW_TARGET_BYTES / perPage)));

  const windows: number[][] = [];
  for (let start = 1; start <= total && windows.length < MAX_WINDOWS; start += size) {
    windows.push(Array.from({ length: Math.min(size, total - start + 1) }, (_, i) => start + i));
  }
  const covered = windows.at(-1)?.at(-1) ?? 0;

  const readings = await Promise.all(
    windows.map(async (pages) => {
      // One page heavier than a request can carry is left out of its
      // window rather than sinking the rest of it.
      const { pages: fitted, bytes } = await fitPages(cutter, pages, INLINE_HARD_LIMIT);
      return readPart(bytes, fitted, file.name, question, ctx);
    }),
  );

  const read = readings.filter((r): r is NonNullable<typeof r> => !!r);
  if (!read.length) {
    return {
      read: false,
      note: `This PDF is ${mb(file.bytes.byteLength)} across ${total} pages and could not be read in time. Offer the file itself instead.`,
    };
  }

  // The windows that found something lead; the rest only say where it is not.
  const found = read.filter((r) => r.pages.length || r.findings.length);
  const lead = found.length ? found : read.slice(0, 1);
  return {
    read: true,
    kind: 'pdf',
    answer: lead.map((r) => r.answer).join(' '),
    findings: lead.flatMap((r) => r.findings).slice(0, 12),
    pages: [...new Set(lead.flatMap((r) => r.pages))].slice(0, 6),
    ...(covered < total ? { scope: `Only pages 1–${covered} of ${total} were read.` } : {}),
  };
}
