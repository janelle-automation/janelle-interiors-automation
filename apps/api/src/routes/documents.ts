import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { orgSourceUserId } from '../lib/tokens.js';
import { gmailFor, downloadAttachment } from '../services/gmail.js';
import { driveFor, downloadFile } from '../services/drive.js';

export const documentsRouter = Router();
documentsRouter.use(requireAuth);

interface EmailSource { gmail_id: string; from_addr: string | null; subject: string | null; received_at: string | null }

/** Extract the Gmail message id from a "gmail:<messageId>:<attachmentId>" reference. */
function gmailMessageId(ref: string | null): string | null {
  if (!ref || !ref.startsWith('gmail:')) return null;
  const rest = ref.slice('gmail:'.length);
  const sep = rest.indexOf(':');
  return sep > 0 ? rest.slice(0, sep) : rest;
}

// Document Intelligence — parsed PDF quotes and order confirmations.
documentsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { db } = req.auth!;
    const { data, error } = await db
      .from('documents')
      .select('id, type, parsed_json, confidence, created_at, drive_file_id, projects(name)')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);

    // Documents that arrived as Gmail attachments reference their message as
    // "gmail:<messageId>:<attachmentId>". Join the stored email so the UI can
    // show who shared the file and when.
    const gmailIds = [...new Set(
      (data ?? [])
        .map((d) => gmailMessageId(d.drive_file_id as string | null))
        .filter((id): id is string => Boolean(id)),
    )];
    const emailsById = new Map<string, EmailSource>();
    if (gmailIds.length) {
      const { data: emails } = await db
        .from('emails')
        .select('gmail_id, from_addr, subject, received_at')
        .in('gmail_id', gmailIds);
      for (const e of emails ?? []) {
        if (e.gmail_id) emailsById.set(e.gmail_id, e as EmailSource);
      }
    }

    const rows = (data ?? []).map((d) => {
      const ref = d.drive_file_id as string | null;
      const msgId = gmailMessageId(ref);
      const email = msgId ? emailsById.get(msgId) : undefined;
      const source = msgId
        ? {
            kind: 'gmail' as const,
            from: email?.from_addr ?? null,
            subject: email?.subject ?? null,
            shared_at: email?.received_at ?? null,
          }
        : ref
          ? { kind: 'drive' as const, from: null, subject: null, shared_at: null }
          : null;
      return { ...d, source };
    });
    res.json({ data: rows });
  }),
);

// Stream the original PDF — from the Gmail attachment or the Drive file
// it was parsed from — so it can be viewed in the app.
documentsRouter.get(
  '/:id/file',
  asyncHandler(async (req, res) => {
    const { db, orgId } = req.auth!;
    const { data: doc } = await db
      .from('documents')
      .select('id, drive_file_id')
      .eq('id', req.params.id)
      .maybeSingle();

    const ref = doc?.drive_file_id as string | undefined;
    if (!ref) return res.status(404).json({ error: 'No source file for this document' });

    const userId = orgId ? await orgSourceUserId(orgId) : null;
    if (!userId) return res.status(400).json({ error: 'No source account connected' });

    let bytes: Buffer;
    if (ref.startsWith('gmail:')) {
      const rest = ref.slice('gmail:'.length);
      const sep = rest.indexOf(':');
      const messageId = rest.slice(0, sep);
      const attachmentId = rest.slice(sep + 1);
      const gmail = await gmailFor(userId);
      if (!gmail) return res.status(400).json({ error: 'Google not connected' });
      bytes = await downloadAttachment(gmail, messageId, attachmentId);
    } else {
      const drive = await driveFor(userId);
      if (!drive) return res.status(400).json({ error: 'Google not connected' });
      bytes = await downloadFile(drive, ref);
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="document.pdf"');
    res.send(bytes);
  }),
);
