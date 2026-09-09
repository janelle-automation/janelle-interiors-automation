import { google, type gmail_v1 } from 'googleapis';
import { googleClientForUser } from '../lib/tokens.js';

export interface PdfAttachment {
  filename: string;
  attachmentId: string;
}

export interface ParsedEmail {
  gmailId: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  replyTo: string;
  subject: string;
  snippet: string;
  receivedAt: string | null;
  body: string;
  attachments: PdfAttachment[];
  /** RFC Message-ID header of this email, for threading a reply. */
  messageIdHeader: string;
}

/** Extract the bare address from a "Name <a@b.com>" header value. */
export function addressOf(header: string): string {
  const m = header.match(/<([^>]+)>/);
  return (m ? m[1] : header).trim().toLowerCase();
}

/** Split a header of comma-separated recipients into bare addresses. */
export function addressesOf(header: string): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((h) => addressOf(h))
    .filter((a) => a.includes('@'));
}

/** Gmail client acting as the given user, or null if not connected. */
export async function gmailFor(userId: string): Promise<gmail_v1.Gmail | null> {
  const auth = await googleClientForUser(userId, 'gmail');
  if (!auth) return null;
  return google.gmail({ version: 'v1', auth });
}

/** The connected account's own email address (to detect self / forwards). */
export async function getProfileEmail(gmail: gmail_v1.Gmail): Promise<string> {
  const res = await gmail.users.getProfile({ userId: 'me' });
  return (res.data.emailAddress ?? '').toLowerCase();
}

function header(payload: gmail_v1.Schema$MessagePart | undefined, name: string): string {
  const h = payload?.headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? '';
}

function decodeBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return '';
  // Prefer text/plain; fall back to any part with data.
  const stack: gmail_v1.Schema$MessagePart[] = [payload];
  let plain = '';
  let html = '';
  while (stack.length) {
    const part = stack.shift()!;
    const data = part.body?.data;
    if (data) {
      const text = Buffer.from(data, 'base64').toString('utf8');
      if (part.mimeType === 'text/plain' && !plain) plain = text;
      if (part.mimeType === 'text/html' && !html) html = text;
    }
    if (part.parts) stack.push(...part.parts);
  }
  if (plain) return plain;
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Collect PDF attachments (filename + attachmentId) from a payload. */
function collectPdfAttachments(payload: gmail_v1.Schema$MessagePart | undefined): PdfAttachment[] {
  const out: PdfAttachment[] = [];
  const stack: gmail_v1.Schema$MessagePart[] = payload ? [payload] : [];
  while (stack.length) {
    const part = stack.shift()!;
    const isPdf =
      part.mimeType === 'application/pdf' ||
      (part.filename ?? '').toLowerCase().endsWith('.pdf');
    if (isPdf && part.body?.attachmentId) {
      out.push({ filename: part.filename || 'attachment.pdf', attachmentId: part.body.attachmentId });
    }
    if (part.parts) stack.push(...part.parts);
  }
  return out;
}

/** List message ids matching a Gmail search query (e.g. "newer_than:2d"). */
export async function listMessageIds(
  gmail: gmail_v1.Gmail,
  query: string,
  max = 25,
): Promise<string[]> {
  const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: max });
  return (res.data.messages ?? []).map((m) => m.id!).filter(Boolean);
}

export async function getEmail(gmail: gmail_v1.Gmail, id: string): Promise<ParsedEmail> {
  const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
  const msg = res.data;
  const payload = msg.payload;
  const dateMs = msg.internalDate ? Number(msg.internalDate) : null;
  return {
    gmailId: msg.id!,
    threadId: msg.threadId ?? '',
    from: header(payload, 'From'),
    to: header(payload, 'To'),
    cc: header(payload, 'Cc'),
    replyTo: header(payload, 'Reply-To'),
    subject: header(payload, 'Subject'),
    snippet: msg.snippet ?? '',
    receivedAt: dateMs ? new Date(dateMs).toISOString() : null,
    body: decodeBody(payload).slice(0, 12000),
    attachments: collectPdfAttachments(payload),
    messageIdHeader: header(payload, 'Message-ID') || header(payload, 'Message-Id'),
  };
}

/** Download a single PDF attachment's bytes. */
export async function downloadAttachment(
  gmail: gmail_v1.Gmail,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const res = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId });
  const data = res.data.data ?? '';
  return Buffer.from(data, 'base64');
}

/**
 * Create a Gmail draft (never sent). Returns the draft id. Pass
 * `threadId` + `inReplyTo` to make it a proper reply in the thread.
 */
export async function createDraft(
  gmail: gmail_v1.Gmail,
  opts: { to: string; cc?: string; subject: string; body: string; threadId?: string; inReplyTo?: string },
): Promise<string> {
  const headers = [`To: ${opts.to}`];
  if (opts.cc) headers.push(`Cc: ${opts.cc}`);
  headers.push(`Subject: ${opts.subject}`, 'Content-Type: text/plain; charset="UTF-8"');
  if (opts.inReplyTo) {
    headers.push(`In-Reply-To: ${opts.inReplyTo}`);
    headers.push(`References: ${opts.inReplyTo}`);
  }

  const raw = Buffer.from([...headers, '', opts.body].join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: opts.threadId ? { raw, threadId: opts.threadId } : { raw } },
  });
  return res.data.id ?? '';
}
