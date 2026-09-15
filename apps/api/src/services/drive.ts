import { google, type drive_v3 } from 'googleapis';
import { googleClientForUser } from '../lib/tokens.js';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  /** Bytes, as Drive reports them; 0 when the file did not say. */
  size: number;
}

/** Drive client acting as the given user, or null if not connected. */
export async function driveFor(userId: string): Promise<drive_v3.Drive | null> {
  const auth = await googleClientForUser(userId, 'drive');
  if (!auth) return null;
  return google.drive({ version: 'v3', auth });
}

/**
 * List PDF files, optionally within a folder, most-recently-modified
 * first. Used to find new quotes and order confirmations.
 */
export async function listPdfs(
  drive: drive_v3.Drive,
  opts: { folderId?: string; max?: number } = {},
): Promise<DriveFile[]> {
  const clauses = ["mimeType = 'application/pdf'", 'trashed = false'];
  if (opts.folderId) clauses.push(`'${opts.folderId}' in parents`);
  const res = await drive.files.list({
    q: clauses.join(' and '),
    orderBy: 'modifiedTime desc',
    pageSize: opts.max ?? 25,
    fields: 'files(id,name,mimeType,modifiedTime,size)',
    // Include shared drives, where studios usually keep quote PDFs.
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: 'allDrives',
  });
  return (res.data.files ?? []).map((f) => ({
    id: f.id!,
    name: f.name ?? 'untitled.pdf',
    mimeType: f.mimeType ?? 'application/pdf',
    modifiedTime: f.modifiedTime ?? '',
    // Drive sends this as a string; 0 for anything that did not report one.
    size: Number(f.size ?? 0) || 0,
  }));
}

/** Download a Drive file's raw bytes. */
export async function downloadFile(drive: drive_v3.Drive, fileId: string): Promise<Buffer> {
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' },
  );
  return Buffer.from(res.data as ArrayBuffer);
}
