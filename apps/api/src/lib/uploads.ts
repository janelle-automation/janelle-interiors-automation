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
  // Written by a model rather than uploaded by a person: a rendered board
  // comes back as vector when the studio has no image-model billing.
  'image/svg+xml',
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
