import type { EmailClass } from '@janelle/shared';
import { generate, isAiReady } from './anthropic.js';
import type { ParsedEmail } from './gmail.js';

/** Email classes that warrant an auto-drafted reply. */
export const REPLYABLE: EmailClass[] = ['vendor_quote', 'order_confirmation', 'client_approval'];

const GUIDANCE: Partial<Record<EmailClass, string>> = {
  vendor_quote:
    'A vendor sent a quote. Acknowledge receipt warmly, say you are reviewing it with the client, and ask them to confirm current pricing and lead time. Do not commit to purchasing yet.',
  order_confirmation:
    'A vendor confirmed an order. Thank them, confirm you have the details, and ask them to share tracking or a firm ship date once it dispatches.',
  client_approval:
    'A client approved a selection. Warmly confirm you will proceed to place the order, and note the next step (procurement / lead time) so they know what happens next.',
};

export interface ReplyDraft {
  subject: string;
  body: string;
}

/**
 * Compose a reply draft tailored to an incoming email's type and
 * content. Returns null when the class is not replyable or Claude is
 * unavailable.
 */
export async function draftReply(email: ParsedEmail, cls: EmailClass): Promise<ReplyDraft | null> {
  if (!REPLYABLE.includes(cls) || !(await isAiReady())) return null;

  const subject = email.subject.toLowerCase().startsWith('re:') ? email.subject : `Re: ${email.subject}`;

  const body = await generate(
    'You draft email replies for an interior design studio. Warm, precise, professional. ' +
      'Two short paragraphs at most. No placeholders or brackets. Sign off as "Janelle Interiors". ' +
      'Return only the reply body — no subject line, no quoted original.',
    [
      GUIDANCE[cls] ?? 'Write a brief, helpful reply.',
      '',
      `From: ${email.from}`,
      `Subject: ${email.subject}`,
      '',
      'Email content:',
      (email.body || email.snippet).slice(0, 6000),
    ].join('\n'),
    { feature: 'reply.draft' },
    700,
  );

  return { subject, body };
}
