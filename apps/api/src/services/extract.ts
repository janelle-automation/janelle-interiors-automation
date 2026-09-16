import type Anthropic from '@anthropic-ai/sdk';
import { SEATS, SEAT_KEYS, type EmailClass, type DocumentType, type TaskKind, type Seat } from '@janelle/shared';
import { extractJson, type CallContext } from './anthropic.js';
import type { ParsedEmail } from './gmail.js';
import { studioNamesBlock, type StudioNames } from '../lib/studioNames.js';

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
  /** True when project_hint was copied from the studio's own project list. */
  project_is_existing?: boolean;
}

/**
 * How a job is named — shared by every prompt that has to name one.
 *
 * Emails say "Lemon's", "the Lemon project", "Lemons 81326", "291 Saddle
 * Lane". Every one of those used to become the project's name as written,
 * so one job appeared under four names and a task read "Finalize furniture
 * proposal for Lemon's Project". These are the rules the studio's own
 * project list follows.
 */
const PROJECT_NAME_RULES = `PROJECT NAMES
- If the email concerns a project in the studio's list, use that project's name EXACTLY as listed —
  even when the email says it differently ("Lemon's", "the Lemon job", "Lemons 81326", the street
  address). Matching is on meaning: the client's surname, the property, the address, a job number.
- Only if it is clearly a job NOT in the list, write the name the studio would file it under: the
  client's surname or the property's name, plus what the property is — "Lemon Residence", "Casa Elar
  Primary Suite", "Harborview Hotel". Never a possessive ("Lemon's"), never the word "project", never a
  job number or street address alone, never a room or a topic ("living room", "samples", "lighting").
- A vendor, a studio team member or the studio itself is never a project.
- If the email is not about one specific job, null.

CLIENT NAMES
- The client is who the work is FOR: a homeowner ("Sarah Lemon", "The Lemons"), a hotel group or a
  business ("Harborview Group"). For a project in the list, use the client listed for it unless the
  email plainly names a different one.
- Never a vendor, never anyone on the studio team, never the sender just because they sent it.
- If the email does not say, null — do not guess from the project name.`;

const EMAIL_SYSTEM = `You are the intelligence layer for an interior design studio's workflow system.
Classify a single project email and extract structured facts from it.

IMPORTANT for recipients: the email may be a FORWARD (e.g. subject starts "Fwd:") that the
studio owner sent to themselves. In that case the real correspondent — the vendor or client who
actually wrote or asked the question — is inside the quoted/forwarded text, not the top "From".
Read the forwarded headers ("From:", "To:", "Cc:") in the body to find who should receive the reply.

Return JSON with exactly these keys:
- "class": one of "vendor_quote", "order_confirmation", "client_approval", "houzz_notification", "general"
- "confidence": number 0..1
- "project_hint": the project's name, following PROJECT NAMES below, else null
- "project_is_existing": true if project_hint was copied from the studio's project list, else false
- "vendor_hint": the vendor/supplier name — exactly as listed if it is a known vendor — else null
- "po_number": a purchase order number if present, else null
- "amount": a total amount as a number if present, else null
- "dates": array of ISO dates (YYYY-MM-DD) mentioned as ship/ETA/deadline dates
- "summary": one concise sentence describing the email
- "reply_to_email": the single best email address to send the reply to (the original sender/counterparty), or null if none is present
- "reply_to_name": that person's display name if known, else null
- "cc_emails": array of other email addresses that were on the original correspondence and should be CC'd (exclude the studio's own address); [] if none
- "client_name": who the work is for, following CLIENT NAMES below, or null
- "target_date": an install or delivery target date as ISO (YYYY-MM-DD) if the email mentions one, else null
- "stage_signal": the project stage this email implies, one of "lead","concept","spec","approval","po","production","shipping","install","complete", or null. Infer from context: a new inquiry/lead → "lead"; concept or design discussion → "concept"; specs/quotes being gathered → "spec"; the client approving selections → "approval"; an order being placed → "po"; a vendor confirming or producing → "production"; shipping/tracking → "shipping"; delivery or install → "install"; the job finished → "complete".

${PROJECT_NAME_RULES}

ATTACHMENTS
What is attached to an email is often the clearest statement of which job it is — a proposal's cover
page, a drawing's title block, a quote's sidemark, a file named "Lemon Residence - Elevations.pdf".
They are listed under the email, with what each PDF was read to say. Weigh them with the body:
- When the body does not name the job (or the client) but an attachment does, use the attachment's.
- When they disagree, prefer whichever matches a project in the studio's list; failing that, a
  document's own title page or title block over a passing mention in the body.
- A file name is evidence too — but a generic one ("scan.pdf", "IMG_2231.jpg", "Quote.pdf") says nothing.
- The vendor that issued an attached quote is the vendor, never the client or the project.`;

/**
 * What an email's attachments said about themselves, for classifying the email.
 *
 * `read` is set for a PDF that was read before the email was classified;
 * every other attachment still contributes its file name.
 */
export interface AttachmentEvidence {
  filename: string;
  mimeType?: string | null;
  read?: Pick<DocumentExtraction, 'type' | 'title' | 'summary' | 'project_hint' | 'client' | 'vendor'> | null;
}

/** The attachments as lines of evidence under the email. */
function attachmentsBlock(attachments: AttachmentEvidence[]): string {
  if (!attachments.length) return '';
  const lines = attachments.slice(0, 12).map((a, i) => {
    const kind = a.mimeType === 'application/pdf' || /\.pdf$/i.test(a.filename) ? 'PDF' : a.mimeType ?? 'file';
    if (!a.read) return `${i + 1}. "${a.filename}" (${kind}) — not read; only its name is known`;
    const r = a.read;
    const facts = [
      r.title ? `titled "${r.title}"` : null,
      r.summary ? r.summary : null,
      `project: ${r.project_hint ?? '—'}`,
      `client: ${r.client ?? '—'}`,
      r.vendor ? `issued by: ${r.vendor}` : null,
    ].filter(Boolean);
    return `${i + 1}. "${a.filename}" (${kind}, ${r.type}) — ${facts.join('; ')}`;
  });
  return ['', '— ATTACHMENTS —', ...lines].join('\n');
}

export async function classifyEmail(
  email: ParsedEmail,
  ctx: Partial<CallContext> = {},
  names?: StudioNames | null,
  attachments: AttachmentEvidence[] = [],
): Promise<EmailExtraction | null> {
  const user = [
    ...(names ? [studioNamesBlock(names), '', '— THE EMAIL —', ''] : []),
    `From: ${email.from}`,
    `To: ${email.to}`,
    `Subject: ${email.subject}`,
    '',
    email.body || email.snippet,
    attachmentsBlock(attachments),
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
  When the email has been filed against a project (given above the email), refer to the job by
  THAT name — "Finalize furniture proposal for Lemon Residence", never "for Lemon's Project".
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
- "project_hint": the project this concerns, following PROJECT NAMES below, else null.
- "next_step": the single concrete next action, in a few words ("call Yael", "send the
  revised spec to procurement"). The studio requires one on every task; if the email
  genuinely does not imply one, use null rather than inventing something.
- "seat": which seat owns this outcome, from the table below, or null if genuinely unclear.

SEATS — one owner per outcome. Match on what the seat OWNS, and rule a seat out when the
work is in its "does NOT own" list. A drawing or elevation is design, never technical
production; a purchase order is operations, never design; anything hotel is hotel_ffe.
${SEAT_TABLE}

${PROJECT_NAME_RULES}`;

/** Where an email has already been filed, so a task refers to the job by its real name. */
export interface TaskFiling {
  project?: string | null;
  client?: string | null;
  names?: StudioNames | null;
}

/**
 * Decide whether an email implies internal work. Returns null when Claude
 * gives back unusable JSON, which the caller treats as "no task".
 */
export async function extractTask(
  email: ParsedEmail,
  ctx: Partial<CallContext> = {},
  filing: TaskFiling = {},
): Promise<TaskExtraction | null> {
  const user = [
    // Claude has no clock; without this, "Friday the 19th" lands in the wrong year.
    `Today's date: ${new Date().toISOString().slice(0, 10)}`,
    ...(filing.names ? ['', studioNamesBlock(filing.names)] : []),
    ...(filing.project
      ? ['', `This email has been filed against the project "${filing.project}"${filing.client ? ` (client: ${filing.client})` : ''}. Refer to the job by that name.`]
      : []),
    '',
    '— THE EMAIL —',
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
  /** The document's own title, as on its cover or first page. */
  title?: string | null;
  /** One sentence on what the document is — a proposal, elevations, a quote. */
  summary?: string | null;
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

const DOC_SYSTEM = `You are reading a PDF that reached an interior design studio — attached to an email or kept
in its Drive. It may be a vendor quote, an order confirmation, a purchase order, an invoice, a design
presentation or proposal, drawings or elevations, a specification or finish schedule, or something else.
Extract its structured contents, and above all WHICH JOB IT IS FOR and WHO THE CLIENT IS.

Where documents say which job and client they belong to — look at all of these:
- the cover page or first page title ("Lemon Residence — Furniture Proposal", "Prepared for Sarah Lemon");
- a drawing's title block (project, client, address, sheet title);
- header and footer lines: "Project:", "Job:", "Job name:", "Client:", "Customer:", "Prepared for";
- on vendor paperwork, the SIDEMARK or TAG — FF&E vendors write the client's or job's name there
  ("Sidemark: LEMON / LIVING RM") — and a "Ship to" or "Deliver to" that is a residence, not the studio.
The studio itself, and the vendor who issued the document, are never the client.

Return JSON with exactly these keys:
- "type": one of "quote", "order_confirmation", "purchase_order", "other" (a presentation, proposal,
  drawing, specification or invoice is "other")
- "title": the document's own title as on its cover or first page, else null
- "summary": one sentence saying what the document is and what it covers
- "confidence": number 0..1
- "vendor": the supplier that ISSUED a quote, order or invoice, else null — a design presentation or
  drawing set has no vendor
- "po_number": purchase order number if present, else null
- "project_hint": the job's name, following PROJECT NAMES below, else null
- "client": who the job is for, following CLIENT NAMES below, else null
- "total": grand total as a number, else null
- "order_date": ISO date (YYYY-MM-DD) or null
- "eta": estimated ship/delivery ISO date or null
- "line_items": array of { "description", "sku" (or null), "qty" (number), "unit_price" (number or null) }

${PROJECT_NAME_RULES}`;

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
  names?: StudioNames | null,
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
    {
      type: 'text',
      text: `${names ? `${studioNamesBlock(names)}\n\n` : ''}Filename: ${filename}\nExtract the structured contents as instructed.`,
    },
  ];
  return extractJson<DocumentExtraction>(DOC_SYSTEM, content, { feature: 'document.extract', ...ctx });
}
