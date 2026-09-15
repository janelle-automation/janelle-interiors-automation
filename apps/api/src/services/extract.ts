import type Anthropic from '@anthropic-ai/sdk';
import { SEATS, SEAT_KEYS, type EmailClass, type DocumentType, type TaskKind, type Seat } from '@janelle/shared';
import { extractJson, type CallContext } from './anthropic.js';
import type { ParsedEmail } from './gmail.js';

export interface EmailExtraction {
  class: EmailClass;
  confidence: number;
  project_hint: string | null;
  vendor_hint: string | null;
  po_number: string | null;
  amount: number | null;
  dates: string[];
  summary: string;
  /** The person to reply to — the counterparty who actually wrote/asked. */
  reply_to_email: string | null;
  reply_to_name: string | null;
  /** Addresses that were CC'd and should stay on the reply. */
  cc_emails: string[];
  /** End client / property this concerns (hotel, homeowner, etc.). */
  client_name: string | null;
  /** An install or delivery target date, ISO, if mentioned. */
  target_date: string | null;
  /** The project stage this email implies (for auto-advancing status). */
  stage_signal: string | null;
}

const EMAIL_SYSTEM = `You are the intelligence layer for an interior design studio's workflow system.
Classify a single project email and extract structured facts from it.

IMPORTANT for recipients: the email may be a FORWARD (e.g. subject starts "Fwd:") that the
studio owner sent to themselves. In that case the real correspondent — the vendor or client who
actually wrote or asked the question — is inside the quoted/forwarded text, not the top "From".
Read the forwarded headers ("From:", "To:", "Cc:") in the body to find who should receive the reply.

Return JSON with exactly these keys:
- "class": one of "vendor_quote", "order_confirmation", "client_approval", "houzz_notification", "general"
- "confidence": number 0..1
- "project_hint": the project or client name if identifiable, else null
- "vendor_hint": the vendor/supplier name if identifiable, else null
- "po_number": a purchase order number if present, else null
- "amount": a total amount as a number if present, else null
- "dates": array of ISO dates (YYYY-MM-DD) mentioned as ship/ETA/deadline dates
- "summary": one concise sentence describing the email
- "reply_to_email": the single best email address to send the reply to (the original sender/counterparty), or null if none is present
- "reply_to_name": that person's display name if known, else null
- "cc_emails": array of other email addresses that were on the original correspondence and should be CC'd (exclude the studio's own address); [] if none
- "client_name": the end client or property the work is for (e.g. the hotel, homeowner, or brand), or null
- "target_date": an install or delivery target date as ISO (YYYY-MM-DD) if the email mentions one, else null
- "stage_signal": the project stage this email implies, one of "lead","concept","spec","approval","po","production","shipping","install","complete", or null. Infer from context: a new inquiry/lead → "lead"; concept or design discussion → "concept"; specs/quotes being gathered → "spec"; the client approving selections → "approval"; an order being placed → "po"; a vendor confirming or producing → "production"; shipping/tracking → "shipping"; delivery or install → "install"; the job finished → "complete".`;

export async function classifyEmail(
  email: ParsedEmail,
  ctx: Partial<CallContext> = {},
): Promise<EmailExtraction | null> {
  const user = [
    `From: ${email.from}`,
    `To: ${email.to}`,
    `Subject: ${email.subject}`,
    '',
    email.body || email.snippet,
  ].join('\n');
  return extractJson<EmailExtraction>(EMAIL_SYSTEM, user, { feature: 'email.extract', ...ctx });
}

export interface TaskExtraction {
  /** False for anything that is merely informational — the important gate. */
  needs_task: boolean;
  /** Who the sender is asking to do it, as written (a first name is fine). */
  assignee_hint: string | null;
  /** Which named seat owns this outcome, per the studio's roles document. */
  seat: Seat | null;
  /** The Tasks SOP requires a next step on every task; without one it fails review. */
  next_step: string | null;
  /** "Where" in the six questions: the project or property this concerns. */
  project_hint: string | null;
  /** Imperative, ≤80 chars, names the counterparty. */
  title: string;
  detail: string | null;
  kind: TaskKind;
  /** ISO date, only when the email states or clearly implies a deadline. */
  due_date: string | null;
}

const SEAT_TABLE = SEAT_KEYS.map((k) => {
  const s = SEATS[k];
  return `  "${k}" — ${s.label}${s.person ? ` (${s.person})` : ' (VACANT)'}
      owns: ${s.owns}
      does NOT own: ${s.notOwns}`;
}).join('\n');

const TASK_SYSTEM = `You decide whether an email for an interior design studio requires
someone on the team to DO something, and if so you write that work item.

The studio is moving its task list out of Houzz Pro and into this system, so internal
email IS where the work is assigned. Watch for:
- An explicit marker the team already uses: "Task in houzz", "TASK:", "To do", "Action item".
- A direct request to a colleague: "Can you...", "Could you see if...", "Please chase...",
  "Would you follow up with...". The sender is delegating; that is a task.
- A promise someone made that has to be tracked: "I will send you...", "I'll resume Tuesday".
- Something a client or vendor is waiting on.

Be conservative anyway. MOST email needs no task. Return "needs_task": false for
newsletters, marketing, receipts, automated notifications from tools (GitHub, Vercel,
Google Drive sharing, Copilot, sign-in alerts), calendar noise, pure FYI updates, and
anything already fully resolved in the thread. A task is warranted only when a specific
person must take a specific action that is not yet done.

Return JSON with exactly these keys:
- "needs_task": true or false
- "assignee_hint": the name or email of the person being ASKED to do it, exactly as it
  appears — usually the recipient, or a name in the body ("Can you see if Joanna..." →
  "Joanna"). Use null when no one is named. Never guess.
- "title": an imperative instruction naming the counterparty, at most 80 characters
  (e.g. "Chase Yael for the OVI elevation drawings"). Use "" when needs_task is false.
- "detail": one or two sentences of context a colleague would need to act, or null
- "kind": one of "quote_request" (a quote must be requested or chased),
  "order_followup" (an existing order/PO needs chasing or confirming),
  "client_approval" (the client must approve or decide something),
  "spec_review" (a specification, drawing, elevation, CAD plan or selection needs
  producing or reviewing),
  "scheduling" (a delivery, install or meeting must be booked or moved),
  "admin" (anything else genuinely actionable)
- "due_date": ISO date (YYYY-MM-DD) if the email states or clearly implies a deadline, else null.
  Resolve relative wording ("Friday the 19th", "next week", "end of month") against the
  current date given below, and never return a date in the past.
- "project_hint": the project, property or client this concerns, as written, else null.
- "next_step": the single concrete next action, in a few words ("call Yael", "send the
  revised spec to procurement"). The studio requires one on every task; if the email
  genuinely does not imply one, use null rather than inventing something.
- "seat": which seat owns this outcome, from the table below, or null if genuinely unclear.

SEATS — one owner per outcome. Match on what the seat OWNS, and rule a seat out when the
work is in its "does NOT own" list. A drawing or elevation is design, never technical
production; a purchase order is operations, never design; anything hotel is hotel_ffe.
${SEAT_TABLE}`;

/**
 * Decide whether an email implies internal work. Returns null when Claude
 * gives back unusable JSON, which the caller treats as "no task".
 */
export async function extractTask(
  email: ParsedEmail,
  ctx: Partial<CallContext> = {},
): Promise<TaskExtraction | null> {
  const user = [
    // Claude has no clock; without this, "Friday the 19th" lands in the wrong year.
    `Today's date: ${new Date().toISOString().slice(0, 10)}`,
    '',
    `From: ${email.from}`,
    `To: ${email.to}`,
    `Subject: ${email.subject}`,
    '',
    email.body || email.snippet,
  ].join('\n');
  return extractJson<TaskExtraction>(TASK_SYSTEM, user, { feature: 'task.extract', ...ctx });
}

export interface DocumentExtraction {
  type: DocumentType;
  confidence: number;
  vendor: string | null;
  po_number: string | null;
  project_hint: string | null;
  client: string | null;
  total: number | null;
  order_date: string | null;
  eta: string | null;
  line_items: { description: string; sku: string | null; qty: number; unit_price: number | null }[];
}

const DOC_SYSTEM = `You are reading a PDF from an interior design studio: a vendor quote or an order confirmation.
Extract its structured contents.

Return JSON with exactly these keys:
- "type": one of "quote", "order_confirmation", "purchase_order", "other"
- "confidence": number 0..1
- "vendor": vendor/supplier name, else null
- "po_number": purchase order number if present, else null
- "project_hint": the project/job name if identifiable, else null
- "client": the end client or property the order is for (hotel, homeowner, brand), else null
- "total": grand total as a number, else null
- "order_date": ISO date (YYYY-MM-DD) or null
- "eta": estimated ship/delivery ISO date or null
- "line_items": array of { "description", "sku" (or null), "qty" (number), "unit_price" (number or null) }`;

/**
 * The largest PDF worth reading.
 *
 * Reading one holds the file three times over — the downloaded buffer, its
 * base64 form (a third larger again), and the JSON request body the SDK
 * builds around it. On a 1024MB function a big attachment can exhaust the
 * memory and take the whole invocation down, which reaches the browser as a
 * dropped connection rather than an error, losing everything that pass had
 * read. Claude refuses documents over 32MB anyway, so an oversized file
 * costs the download and the memory and then fails regardless. Quotes and
 * order confirmations are comfortably under this.
 */
export const MAX_PDF_BYTES = 12 * 1024 * 1024;

export async function extractPdf(
  pdf: Buffer,
  filename: string,
  ctx: Partial<CallContext> = {},
): Promise<DocumentExtraction | null> {
  if (pdf.byteLength > MAX_PDF_BYTES) {
    console.warn(`[extract] skipping ${filename}: ${Math.round(pdf.byteLength / 1e6)}MB is over the read limit`);
    return null;
  }
  const content: Anthropic.ContentBlockParam[] = [
    {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') },
    },
    { type: 'text', text: `Filename: ${filename}\nExtract the structured contents as instructed.` },
  ];
  return extractJson<DocumentExtraction>(DOC_SYSTEM, content, { feature: 'document.extract', ...ctx });
}
