import type Anthropic from '@anthropic-ai/sdk';
import { extractJson, type CallContext } from './anthropic.js';
import { MAX_PDF_BYTES } from './extract.js';
import { pdfPageCount, pdfSubset } from './files.js';

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
      kind: 'pdf' | 'image';
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
    content = [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } }];
  } else if (imageType) {
    if (file.bytes.byteLength > MAX_IMAGE_BYTES) {
      return { read: false, note: 'This image is too large to read here. Offer the file itself instead.' };
    }
    content = [{ type: 'image', source: { type: 'base64', media_type: imageType, data: file.bytes.toString('base64') } }];
  } else {
    return {
      read: false,
      note: 'Only PDFs and images can be read this way. For a Google Doc or Sheet use drive_read; otherwise offer the file itself.',
    };
  }

  const reading = await extractJson<{ answer?: string; findings?: DocumentFinding[]; pages?: unknown[] }>(
    READ_DOCUMENT_SYSTEM,
    [...content, { type: 'text', text: `File: ${file.name}\nRequest: ${question}` }],
    ctx,
  );
  if (!reading?.answer) return { read: false, note: 'The document could not be read.' };

  const maxPage = pageCount ?? Number.MAX_SAFE_INTEGER;
  const pages = isPdf
    ? [...new Set((reading.pages ?? []).map(Number))].filter((n) => Number.isInteger(n) && n >= 1 && n <= maxPage).slice(0, 6)
    : [];

  return {
    read: true,
    kind: isPdf ? 'pdf' : 'image',
    answer: reading.answer,
    findings: (reading.findings ?? []).slice(0, 12),
    pages,
    ...(scope ? { scope } : {}),
  };
}
