import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from './supabase.js';
import { MAX_RELAY_BYTES } from './fileTokens.js';

/**
 * Files people attach to a question for Jenny — a floor plan, a vendor's
 * quote, a photo of a damaged delivery.
 *
 * Kept in a private storage bucket rather than passed along with each
 * question: a conversation refers back to "that PDF" several questions
 * later, and the file has to still be there, and small enough requests to
 * pass through a serverless function. Only the server reads the bucket; the
 * browser holds a sealed grant for each file and nothing else.
 */

export const UPLOAD_BUCKET = 'assistant-uploads';

/** What Jenny can read: PDFs and the image types Claude accepts. */
export const UPLOAD_TYPES = [
  'application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  // Sniffed so they can be NAMED when refused, not so they can be read:
  // a phone photo and an AI export commonly arrive in these, and "that
  // file is not a PDF or an image" is a lie when it plainly is one.
  'image/avif', 'image/heic',
  // The studio's real paperwork: a flooring schedule, an FF&E list, a
  // vendor's spec. All readable, so all attachable.
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  // Written by a model rather than uploaded by a person: a rendered board
  // comes back as vector when the studio has no image-model billing.
  'image/svg+xml',
  // Likewise never uploaded by a person — a clip Grok drew, fetched off
  // the provider's temporary URL and kept here so it stays playable.
  'video/mp4',
] as const;
export type UploadType = (typeof UPLOAD_TYPES)[number];

/** A request body on Vercel caps near 4.5 MB; elsewhere, what a document reader can take. */
export const MAX_UPLOAD_BYTES = Math.min(MAX_RELAY_BYTES, 20 * 1024 * 1024);

/**
 * The type a file really is, from its first bytes.
 *
 * Never from the name or the Content-Type the browser sent: both are the
 * sender's to choose, and an HTML file called plan.pdf must not be stored,
 * served or read as a PDF.
 */
export function sniffType(bytes: Buffer): UploadType | null {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  // An `ftyp` box at offset 4 is the ISO base media container, which is NOT
  // only video: AVIF and HEIC photographs use the same wrapper. The four
  // bytes after it say which, and reading them is the difference between
  // storing a clip and refusing someone's photo as though it were one.
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return 'image/heic';
    return 'video/mp4';
  }

  /**
   * Office formats are zips, and which one is told by the entry names.
   *
   * A zip stores those names uncompressed, but mostly in the CENTRAL
   * DIRECTORY at the END of the file — in a real workbook the first
   * mention of `xl/workbook.xml` was 62KB in. So both ends are read: the
   * head catches a small file, the tail catches the directory, and neither
   * costs unpacking anything.
   */
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    const names =
      bytes.subarray(0, 8192).toString('latin1') +
      bytes.subarray(Math.max(0, bytes.length - 65_536)).toString('latin1');
    if (names.includes('xl/workbook.xml') || names.includes('xl/worksheets/')) {
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    }
    if (names.includes('word/document.xml')) {
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    }
    return null;
  }

  const head = bytes.subarray(0, 512).toString('utf8').trimStart();

  // SVG is markup, so it has no magic number — but it is a picture this app
  // produces itself (a board rendered by a text model comes back as vector),
  // and one it could not previously take back.
  if (/^(<\?xml[\s\S]*?\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return 'image/svg+xml';

  /**
   * Plain text, and deliberately not by guessing.
   *
   * HTML is text too, and an HTML file accepted here would be stored and
   * served from this app's own origin. So anything starting with a tag is
   * refused outright, and what remains has to be free of the control bytes
   * a binary file is full of.
   */
  if (!head.startsWith('<') && bytes.length) {
    const sample = bytes.subarray(0, 2048);
    const binary = sample.some((b) => b === 0 || (b < 9) || (b > 13 && b < 32 && b !== 27));
    if (!binary) return 'text/plain';
  }

  return null;
}

/** A file name safe as a storage key, keeping what a person would recognise. */
export function safeFileName(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^\w.\- ()]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-120);
  return cleaned || 'file';
}

let bucketReady: Promise<void> | null = null;

/** The bucket, made on first use — a studio that never attaches a file never has one. */
function ensureBucket(): Promise<void> {
  bucketReady ??= (async () => {
    if (!supabaseAdmin) throw new Error('Storage is not configured');
    const { data } = await supabaseAdmin.storage.getBucket(UPLOAD_BUCKET);
    if (data) return;
    const { error } = await supabaseAdmin.storage.createBucket(UPLOAD_BUCKET, { public: false });
    if (error && !/already exists|duplicate/i.test(error.message)) throw new Error(error.message);
  })().catch((err) => {
    bucketReady = null; // try again on the next upload
    throw err;
  });
  return bucketReady;
}

/** Store one upload; returns where it went. Keyed by studio and person, so each can be cleared. */
export async function storeUpload(input: {
  orgId: string;
  userId: string;
  name: string;
  mimeType: UploadType;
  bytes: Buffer;
}): Promise<{ path: string }> {
  if (!supabaseAdmin) throw new Error('Storage is not configured');
  await ensureBucket();
  const path = `${input.orgId}/${input.userId}/${randomUUID()}/${safeFileName(input.name)}`;
  const { error } = await supabaseAdmin.storage
    .from(UPLOAD_BUCKET)
    .upload(path, input.bytes, { contentType: input.mimeType, upsert: false });
  if (error) throw new Error(`Could not store the file: ${error.message}`);
  return { path };
}

export async function readUpload(path: string): Promise<Buffer | null> {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin.storage.from(UPLOAD_BUCKET).download(path);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}

/** Remove uploads; only paths under this person's own folder are touched. */
export async function removeUploads(orgId: string, userId: string, paths: string[]): Promise<number> {
  if (!supabaseAdmin) return 0;
  const own = [...new Set(paths)].filter((p) => p.startsWith(`${orgId}/${userId}/`) && !p.includes('..'));
  if (!own.length) return 0;
  const { data, error } = await supabaseAdmin.storage.from(UPLOAD_BUCKET).remove(own);
  if (error) throw new Error(error.message);
  return data?.length ?? 0;
}
