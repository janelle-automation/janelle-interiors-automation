import { google, type gmail_v1 } from 'googleapis';
import { googleClientForUser } from '../lib/tokens.js';

export interface PdfAttachment {
  filename: string;
  attachmentId: string;
  /** Bytes, as Gmail reports them; 0 when the part did not say. */
  size: number;
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
  /**
   * Every real attachment, of any type — for their names as much as their
   * contents: "Lemon Residence - Elevations.pdf" says which job an email is
   * about even when nothing reads the file.
   */
  files?: MessageAttachment[];
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
      out.push({
        filename: part.filename || 'attachment.pdf',
        attachmentId: part.body.attachmentId,
        // Gmail reports the size on the part, so an oversized attachment is
        // skipped without spending the download on it.
        size: part.body.size ?? 0,
      });
    }
    if (part.parts) stack.push(...part.parts);
  }
  return out;
}

/**
 * Senders that are machinery rather than correspondence.
 *
 * The studio's own tools mail constantly — Slack telling it someone joined
 * the workspace, GitHub relaying a bot's comment on a pull request. None of
 * it is studio work, and every one of them used to cost three Claude calls
 * (classify, raise a task, draft a reply) and land in the Inbox next to
 * real vendor mail.
 *
 * Matched on the sending DOMAIN, deliberately, rather than on a "no-reply"
 * local part: a great many vendors send their order confirmations from
 * no-reply@, and that is exactly the mail the studio cannot afford to miss.
 *
 * NOT here, on purpose: Dropbox, Drive, Box and WeTransfer. Their mail runs
 * both ways — a sign-in notice is noise, but "Carlos shared Lemon Residence
 * elevations with you" is how a drawing or a quote actually reaches the
 * studio, and losing one of those costs far more than reading a few sign-in
 * notices. The task prompt already declines to raise work off a file-share
 * notification, so the noise stops there rather than here.
 *
 * Extend with INGEST_IGNORE_DOMAINS (comma-separated) without a code change.
 */
const BUILT_IN_IGNORED_DOMAINS = [
  // Chat and collaboration
  'slack.com', 'slack-mail.com', 'zoom.us', 'atlassian.com', 'atlassian.net',
  'notion.so', 'figma.com', 'loom.com', 'asana.com', 'trello.com',
  'monday.com', 'clickup.com', 'airtable.com',
  // Developer tooling — this repo's own bots reach the studio through these
  'github.com', 'gitlab.com', 'vercel.com', 'netlify.com', 'sentry.io',
  'circleci.com', 'npmjs.com',
  // Sign-in and security alerts only. Drive's own sharing mail comes from
  // google.com and docs.google.com, which are deliberately left readable.
  'accounts.google.com',
  // Social
  'linkedin.com', 'facebookmail.com', 'facebook.com', 'twitter.com', 'x.com',
  'instagram.com', 'pinterest.com',
];

/** Domains the studio has added on top of the built-in list. */
function extraIgnoredDomains(): string[] {
  return (process.env.INGEST_IGNORE_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

export function ignoredDomains(): string[] {
  return [...BUILT_IN_IGNORED_DOMAINS, ...extraIgnoredDomains()];
}

/**
 * Gmail search terms that leave the noise out of the listing entirely.
 *
 * Cheaper than filtering after the fact: excluded mail is never listed, so
 * it costs nothing on every later pass either. Note there is no `is:unread`
 * here and there must never be one — the studio reads its mail in Gmail
 * first, and mail already opened is exactly the mail it wants read.
 */
export function ignoredSenderQuery(): string {
  return ignoredDomains()
    .map((d) => `-from:${d}`)
    .join(' ');
}

/**
 * Whether this sender is machinery. The query above keeps almost all of it
 * out; this catches the rest — a custom query, or a domain that slipped
 * past Gmail's own matching.
 */
export function isIgnoredSender(from: string): boolean {
  const address = addressOf(from || '');
  const at = address.lastIndexOf('@');
  if (at === -1) return false;
  const domain = address.slice(at + 1);
  return ignoredDomains().some((d) => domain === d || domain.endsWith(`.${d}`));
}

export interface EmailLink {
  url: string;
  /** The domain, so "the Canva link" can be found without reading the URL. */
  host: string;
}

/**
 * Every link in a message body.
 *
 * Done with a regex rather than by asking Claude: it is exact, free, and
 * cannot invent a URL that was never there — which matters most for the
 * thing people ask for by name ("send me the Canva link"). Tracking and
 * unsubscribe machinery is dropped so the list stays worth reading.
 */
const LINK_NOISE = /googleusercontent|gstatic|doubleclick|list-manage|mailchimp|sendgrid|unsubscribe|\.gif|\.png|\.jpg/i;

export function linksIn(body: string): EmailLink[] {
  const found = new Map<string, EmailLink>();
  // Stop at whitespace and at the punctuation that usually closes a URL in
  // prose, so a trailing full stop or bracket does not become part of it.
  for (const match of body.matchAll(/https?:\/\/[^\s<>"'`)\]}]+/g)) {
    const url = match[0].replace(/[.,;:!?]+$/, '');
    if (url.length > 500 || LINK_NOISE.test(url)) continue;
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      if (!found.has(url)) found.set(url, { url, host });
    } catch {
      // Not a URL the platform can parse; not worth storing.
    }
    if (found.size >= 25) break;
  }
  return [...found.values()];
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
    files: attachmentsOf(payload),
    messageIdHeader: header(payload, 'Message-ID') || header(payload, 'Message-Id'),
  };
}

// ── Live reading, for the assistant ─────────────────────────
// Ingestion only ever wanted PDFs, and only from the last few days. The
// assistant is asked for anything — last spring's floor plan, a photo a
// client sent, a spreadsheet of finishes — so it reads the mailbox itself.

/** Any attachment on a message, whatever its type. */
export interface MessageAttachment {
  filename: string;
  mimeType: string;
  attachmentId: string;
  size: number;
}

/** A message as a search result: enough to choose one, not to read it. */
export interface MessageSummary {
  gmailId: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  receivedAt: string | null;
}

/**
 * Every real attachment on a message.
 *
 * "Real" is doing the work: a signature logo or a pasted screenshot is an
 * attachment to Gmail, carries a filename like image001.png, and would bury
 * the one drawing someone actually sent. Those parts are the ones referenced
 * from the HTML body by Content-ID and marked inline, so that is what is
 * left out. An inline part with no Content-ID is kept — some clients mark
 * genuine attachments inline for no reason.
 */
export function attachmentsOf(payload: gmail_v1.Schema$MessagePart | undefined): MessageAttachment[] {
  const out: MessageAttachment[] = [];
  const stack: gmail_v1.Schema$MessagePart[] = payload ? [payload] : [];
  while (stack.length) {
    const part = stack.shift()!;
    if (part.filename && part.body?.attachmentId) {
      const disposition = header(part, 'Content-Disposition').toLowerCase();
      const embedded = disposition.startsWith('inline') && Boolean(header(part, 'Content-ID'));
      if (!embedded) {
        out.push({
          filename: part.filename,
          mimeType: part.mimeType || 'application/octet-stream',
          attachmentId: part.body.attachmentId,
          size: part.body.size ?? 0,
        });
      }
    }
    if (part.parts) stack.push(...part.parts);
  }
  return out;
}

/** A readable message plus every real attachment on it. */
export async function getMessageWithAttachments(
  gmail: gmail_v1.Gmail,
  id: string,
): Promise<ParsedEmail & { files: MessageAttachment[] }> {
  const email = await getEmail(gmail, id);
  return { ...email, files: email.files ?? [] };
}

/**
 * Search the whole mailbox with Gmail's own query language.
 *
 * Headers only — a search that fetched every body would spend seconds on
 * messages nobody is going to open. Fetched in parallel because each one is
 * a separate request and they are independent.
 */
export async function searchMessages(
  gmail: gmail_v1.Gmail,
  query: string,
  max = 10,
): Promise<MessageSummary[]> {
  const ids = await listMessageIds(gmail, query, max);
  const found = await Promise.all(
    ids.map(async (id) => {
      const res = await gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject'],
      });
      const msg = res.data;
      const dateMs = msg.internalDate ? Number(msg.internalDate) : null;
      return {
        gmailId: msg.id!,
        threadId: msg.threadId ?? '',
        from: header(msg.payload, 'From'),
        to: header(msg.payload, 'To'),
        subject: header(msg.payload, 'Subject'),
        snippet: msg.snippet ?? '',
        receivedAt: dateMs ? new Date(dateMs).toISOString() : null,
      };
    }),
  );
  return found;
}

/** Where a message opens in Gmail, for a person who wants the original. */
export function gmailMessageUrl(gmailId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${gmailId}`;
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
