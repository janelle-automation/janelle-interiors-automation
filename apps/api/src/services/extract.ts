import type Anthropic from '@anthropic-ai/sdk';
import type { EmailClass, DocumentType } from '@janelle/shared';
import { extractJson } from './anthropic.js';
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

export async function classifyEmail(email: ParsedEmail): Promise<EmailExtraction | null> {
  const user = [
    `From: ${email.from}`,
    `To: ${email.to}`,
    `Subject: ${email.subject}`,
    '',
    email.body || email.snippet,
  ].join('\n');
  return extractJson<EmailExtraction>(EMAIL_SYSTEM, user);
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

export async function extractPdf(pdf: Buffer, filename: string): Promise<DocumentExtraction | null> {
  const content: Anthropic.ContentBlockParam[] = [
    {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') },
    },
    { type: 'text', text: `Filename: ${filename}\nExtract the structured contents as instructed.` },
  ];
  return extractJson<DocumentExtraction>(DOC_SYSTEM, content);
}
