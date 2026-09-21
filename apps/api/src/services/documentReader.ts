import type Anthropic from '@anthropic-ai/sdk';
import { deleteDocument, extractJson, uploadDocument, type CallContext } from './anthropic.js';
import { INLINE_PDF_BYTES, MAX_PDF_BYTES } from './extract.js';
import { pdfPageCount, pdfSubset } from './files.js';
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
 * for the rest of the request. Only reached when an upload failed — a big
 * file normally goes by reference and never meets this.
 */
const INLINE_HARD_LIMIT = 22 * 1024 * 1024;

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
  let scope: string | undefined;
  /** Set when the PDF went up by reference; deleted once it has been read. */
  let uploadedId: string | null = null;

  if (isPdf) {
    let pdf = file.bytes;
    pageCount = await pdfPageCount(pdf);
    // Claude reads up to 100 pages and a request carries only so much; a long
    // or heavy deck is read from the front, and the answer says so.
    if ((pageCount ?? 0) > 100 || pdf.byteLength > MAX_PDF_BYTES) {
      const take = Math.min(pageCount ?? 30, pdf.byteLength > MAX_PDF_BYTES ? 30 : 100);
      try {
        pdf = await pdfSubset(pdf, Array.from({ length: take }, (_, i) => i + 1));
      } catch {
        return { read: false, note: 'This PDF could not be opened to read.' };
      }
      scope = `Only the first ${take} pages of ${pageCount ?? 'many'} were read.`;
      if (pdf.byteLength > MAX_PDF_BYTES) {
        return { read: false, note: 'This PDF is too large to read here, even in part. Offer the file itself instead.' };
      }
    }

    /**
     * Big PDFs go up by reference, not inside the request.
     *
     * This was the 413. `MAX_PDF_BYTES` is the largest file worth reading
     * at all (64MB) — it was being used here as the INLINE limit, when a
     * request carries at most 32MB and base64 makes a file a third larger.
     * So anything past ~24MB was sent anyway and refused outright as
     * "request_too_large", after it had been downloaded and encoded.
     *
     * The extraction path solved this already and is the pattern copied:
     * above the inline threshold the file is uploaded once, the request
     * carries only its id, and the upload is deleted after the read.
     */
    if (pdf.byteLength > INLINE_PDF_BYTES) {
      try {
        uploadedId = await uploadDocument(pdf, file.name, 'application/pdf', ctx.orgId);
      } catch (err) {
        console.warn(`[read] could not upload ${file.name}:`, (err as Error).message);
      }
      // An upload that failed can still go inline — but only below the
      // point where inline is certain to be refused. Sending it anyway
      // costs the download and the encoding to earn the same 413.
      if (!uploadedId && pdf.byteLength > INLINE_HARD_LIMIT) {
        return {
          read: false,
          note: `This PDF is ${(pdf.byteLength / (1024 * 1024)).toFixed(0)}MB — too large to send in one request, and it could not be uploaded for reading. Offer the file itself instead.`,
        };
      }
    }

    content = [
      uploadedId
        ? // Referencing an uploaded file is generally available on the wire,
          // but the installed SDK (0.68) types it only under `Beta`. Same
          // cast, for the same reason, as services/extract.ts.
          ({ type: 'document', source: { type: 'file', file_id: uploadedId } } as unknown as Anthropic.ContentBlockParam)
        : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } },
    ];
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

  let reading: { answer?: string; findings?: DocumentFinding[]; pages?: unknown[] } | null;
  try {
    reading = await extractJson<{ answer?: string; findings?: DocumentFinding[]; pages?: unknown[] }>(
      READ_DOCUMENT_SYSTEM,
      [...content, { type: 'text', text: `File: ${file.name}\nRequest: ${question}` }],
      ctx,
      timeoutMs,
    );
  } finally {
    // The upload was for this one read. Left behind it counts against the
    // studio's storage for ever, and nothing else refers to it — so it
    // goes whether the read succeeded, failed or timed out.
    if (uploadedId) await deleteDocument(uploadedId, ctx.orgId);
  }
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
    ...(scope ? { scope } : {}),
  };
}
