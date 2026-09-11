import { DEFAULT_SLA, type FollowUpType, type SlaSettings } from '@janelle/shared';
import { supabaseAdmin } from '../lib/supabase.js';
import { anthropic, generate } from './anthropic.js';

export interface FollowUpResult {
  ok: boolean;
  reason?: string;
  raised: number;
  drafted: number;
}

interface Trigger {
  type: FollowUpType;
  projectId: string | null;
  vendorId: string | null;
  target: string | null;
  reason: string;
  context: string;
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString();
}
const todayIso = () => new Date().toISOString().slice(0, 10);

/** Compose a nudge body via Claude, with a plain-text fallback. */
async function draftBody(t: Trigger): Promise<{ subject: string; body: string }> {
  const SUBJECTS: Partial<Record<FollowUpType, string>> = {
    client_approval_overdue: 'Quick follow-up on your approval',
    vendor_silence: 'Following up on our order',
    // Proactive, not apologetic: the client should hear from us first.
    quote_overdue: 'An update on your quote',
    client_waiting: 'An update on your request',
  };
  const subject = SUBJECTS[t.type] ?? 'Checking in on timing';

  if (!anthropic) {
    return {
      subject,
      body: `Hi,\n\nJust following up regarding ${t.context}. ${t.reason} Could you share an update when you have a moment?\n\nThank you,\nJanelle Interiors`,
    };
  }
  const body = await generate(
    'You write short, warm, professional follow-up emails for an interior design studio. 2 short paragraphs, no placeholders, sign off as "Janelle Interiors".',
    `Write a follow-up email. Situation: ${t.reason} Context: ${t.context}`,
    800,
  );
  return { subject, body };
}

interface Recipient {
  to: string;
  cc: string[];
  threadId: string | null;
  subject: string | null;
}

/**
 * Resolve the best recipient + thread for a follow-up from the most
 * recent ingested email for a vendor or project — reusing the same
 * extracted correspondent + CC data the auto-reply drafts use.
 */
async function resolveRecipient(
  orgId: string,
  key: { vendorId?: string | null; projectId?: string | null; preferClass?: string },
): Promise<Recipient | null> {
  if (!supabaseAdmin) return null;
  let q = supabaseAdmin
    .from('emails')
    .select('thread_id, subject, extracted_json')
    .eq('org_id', orgId)
    .order('received_at', { ascending: false, nullsFirst: false })
    .limit(1);
  if (key.vendorId) q = q.eq('vendor_id', key.vendorId);
  else if (key.projectId) q = q.eq('project_id', key.projectId);
  else return null;
  if (key.preferClass) q = q.eq('class', key.preferClass);

  const { data } = await q;
  const e = data?.[0] as
    | { thread_id: string | null; subject: string | null; extracted_json: { reply_to_email?: string; cc_emails?: string[] } | null }
    | undefined;
  const ex = e?.extracted_json ?? {};
  const to = (ex.reply_to_email ?? '').toLowerCase();
  if (!to.includes('@')) return null;
  const cc = (ex.cc_emails ?? []).map((c) => c.toLowerCase()).filter((a) => a.includes('@') && a !== to);
  return { to, cc, threadId: e?.thread_id ?? null, subject: e?.subject ?? null };
}

/**
 * Scan an org for overdue/quiet items, raise follow-ups (deduped), and
 * draft Gmail messages where a recipient is known. Nothing is sent.
 */
export async function runFollowUps(orgId: string): Promise<FollowUpResult> {
  if (!supabaseAdmin) return { ok: false, reason: 'supabase_not_configured', raised: 0, drafted: 0 };

  const { data: org } = await supabaseAdmin
    .from('organizations')
    .select('settings')
    .eq('id', orgId)
    .maybeSingle();
  const settings = (org?.settings ?? {}) as Partial<SlaSettings>;
  const sla: SlaSettings = { ...DEFAULT_SLA, ...settings };
  const vendorDays = sla.vendor_silence_days;
  const clientDays = sla.client_approval_days;

  const triggers: Trigger[] = [];

  // 0. Quote SLA — the studio's sharpest pain point: a quote request that
  //    sits too long, where the client is left guessing. The rule is to tell
  //    the client something before they have to ask.
  const { data: staleQuotes } = await supabaseAdmin
    .from('tasks')
    .select('id, title, project_id, vendor_id, created_at, projects(name, client_name)')
    .eq('org_id', orgId)
    .eq('kind', 'quote_request')
    .in('status', ['open', 'in_progress', 'blocked'])
    .lt('created_at', daysAgoIso(sla.quote_response_days));
  for (const t of staleQuotes ?? []) {
    const proj = (t as { projects?: { name?: string; client_name?: string } }).projects;
    triggers.push({
      type: 'quote_overdue',
      projectId: (t as { project_id: string | null }).project_id,
      vendorId: (t as { vendor_id: string | null }).vendor_id,
      target: null,
      reason: `A quote request has been open more than ${sla.quote_response_days} days; the client should be told where it stands.`,
      context: `${(t as { title: string }).title}${proj?.client_name ? ` — ${proj.client_name}` : ''}`,
    });
  }

  // 0b. Client waiting — someone owes the client a reply. Internal nudge only.
  const waitingCutoff = new Date(Date.now() - sla.client_waiting_hours * 3600_000).toISOString();
  const { data: waiting } = await supabaseAdmin
    .from('tasks')
    .select('id, title, project_id, created_at, projects(name, client_name)')
    .eq('org_id', orgId)
    .eq('kind', 'client_approval')
    .in('status', ['open', 'in_progress', 'blocked'])
    .lt('created_at', waitingCutoff);
  for (const t of waiting ?? []) {
    const proj = (t as { projects?: { name?: string; client_name?: string } }).projects;
    triggers.push({
      type: 'client_waiting',
      projectId: (t as { project_id: string | null }).project_id,
      vendorId: null,
      target: null,
      reason: `The client has been waiting over ${sla.client_waiting_hours} hours for a response.`,
      context: `${(t as { title: string }).title}${proj?.client_name ? ` — ${proj.client_name}` : ''}`,
    });
  }

  // 1. Vendor silence — POs placed but not confirmed past the threshold.
  const { data: silentPos } = await supabaseAdmin
    .from('purchase_orders')
    .select('id, po_number, project_id, vendor_id, order_date, vendors(name, contacts)')
    .eq('org_id', orgId)
    .eq('status', 'placed')
    .lte('order_date', daysAgoIso(vendorDays).slice(0, 10));
  for (const po of silentPos ?? []) {
    const vendor = (po as { vendors?: { name?: string; contacts?: { email?: string }[] } }).vendors;
    triggers.push({
      type: 'vendor_silence',
      projectId: (po as { project_id: string | null }).project_id,
      vendorId: (po as { vendor_id: string | null }).vendor_id,
      target: vendor?.contacts?.[0]?.email ?? null,
      reason: `No confirmation on ${(po as { po_number?: string }).po_number ?? 'the order'} in over ${vendorDays} days.`,
      context: `${vendor?.name ?? 'vendor'} — ${(po as { po_number?: string }).po_number ?? 'PO'}`,
    });
  }

  // 2. Date slipping — POs past ETA, not yet received.
  const { data: latePos } = await supabaseAdmin
    .from('purchase_orders')
    .select('id, po_number, project_id, vendor_id, eta, vendors(name, contacts)')
    .eq('org_id', orgId)
    .lt('eta', todayIso())
    .not('status', 'in', '("received","cancelled")');
  for (const po of latePos ?? []) {
    const vendor = (po as { vendors?: { name?: string; contacts?: { email?: string }[] } }).vendors;
    triggers.push({
      type: 'date_slipping',
      projectId: (po as { project_id: string | null }).project_id,
      vendorId: (po as { vendor_id: string | null }).vendor_id,
      target: vendor?.contacts?.[0]?.email ?? null,
      reason: `Delivery is past its ETA (${(po as { eta?: string }).eta}).`,
      context: `${vendor?.name ?? 'vendor'} — ${(po as { po_number?: string }).po_number ?? 'PO'}`,
    });
  }

  // 3. Client approval overdue — projects stuck in "approval".
  const { data: stuck } = await supabaseAdmin
    .from('projects')
    .select('id, name, client_name, updated_at')
    .eq('org_id', orgId)
    .eq('stage', 'approval')
    .lt('updated_at', daysAgoIso(clientDays));
  for (const p of stuck ?? []) {
    triggers.push({
      type: 'client_approval_overdue',
      projectId: (p as { id: string }).id,
      vendorId: null,
      target: null,
      reason: `Awaiting client approval for over ${clientDays} days.`,
      context: `${(p as { name: string }).name} (${(p as { client_name?: string }).client_name ?? 'client'})`,
    });
  }

  // 4. Spec gaps — internal reminders (no email).
  const { data: gaps } = await supabaseAdmin
    .from('spec_gaps')
    .select('id, item, project_id')
    .eq('org_id', orgId)
    .eq('resolved', false);
  for (const g of gaps ?? []) {
    triggers.push({
      type: 'spec_gap',
      projectId: (g as { project_id: string }).project_id,
      vendorId: null,
      target: null,
      reason: `Missing information on "${(g as { item: string }).item}" before it can be ordered.`,
      context: (g as { item: string }).item,
    });
  }

  let raised = 0;
  let drafted = 0;

  for (const t of triggers) {
    // Dedupe against an existing open follow-up of the same kind.
    const dedupe = supabaseAdmin
      .from('follow_ups')
      .select('id')
      .eq('org_id', orgId)
      .eq('type', t.type)
      .in('status', ['open', 'drafted']);
    if (t.projectId) dedupe.eq('project_id', t.projectId);
    if (t.vendorId) dedupe.eq('vendor_id', t.vendorId);
    const { data: dupes } = await dedupe;
    if (dupes && dupes.length) continue;

    let draftId: string | null = null;
    let status: 'open' | 'drafted' = 'open';

    // Resolve the real correspondent + thread from recent email; fall
    // back to the vendor's stored contact where no email exists yet.
    let resolved: Recipient | null = null;
    if (t.type === 'vendor_silence' || t.type === 'date_slipping') {
      resolved = await resolveRecipient(orgId, { vendorId: t.vendorId });
    } else if (t.type === 'client_approval_overdue') {
      resolved = await resolveRecipient(orgId, { projectId: t.projectId, preferClass: 'client_approval' });
    }
    const to = resolved?.to ?? t.target;

    if (to) {
      try {
        const gen = await draftBody(t);
        const subject = resolved?.subject
          ? /^re:/i.test(resolved.subject)
            ? resolved.subject
            : `Re: ${resolved.subject}`
          : gen.subject;
        // Kept IN THE SYSTEM (not Gmail): store the composed message.
        const ccLine = resolved?.cc.length ? `\nCc: ${resolved.cc.join(', ')}` : '';
        const composed = `To: ${to}${ccLine}\n\n${gen.body}`;
        const { data: draftRow } = await supabaseAdmin!
          .from('drafts')
          .insert({ org_id: orgId, follow_up_id: null, subject, body_preview: composed })
          .select('id')
          .maybeSingle();
        draftId = draftRow?.id ?? null;
        status = 'drafted';
        drafted++;
      } catch (err) {
        console.error('[followups] draft failed', (err as Error).message);
      }
    }

    await supabaseAdmin!.from('follow_ups').insert({
      org_id: orgId,
      type: t.type,
      project_id: t.projectId,
      vendor_id: t.vendorId,
      target: to,
      reason: t.reason,
      due_date: todayIso(),
      status,
      draft_id: draftId,
    });
    raised++;
  }

  await supabaseAdmin.from('activity_log').insert({
    org_id: orgId,
    action: 'followups.run',
    entity: 'follow_ups',
    meta: { raised, drafted },
  });

  return { ok: true, raised, drafted };
}
