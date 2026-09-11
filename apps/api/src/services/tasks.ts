import { TASK_KIND_ROLE, TASK_KINDS, type TaskKind, type UserRole } from '@janelle/shared';
import { supabaseAdmin } from '../lib/supabase.js';
import { extractTask } from './extract.js';
import type { ParsedEmail } from './gmail.js';

/** Classes that never imply internal work — skipped before spending a Claude call. */
const IGNORED_CLASSES = ['general', 'houzz_notification', 'unclassified'];

/** Statuses that still count against someone's workload. */
const LIVE_STATUSES = ['open', 'in_progress', 'blocked'];

/**
 * Pick the person who should own a task of this kind: whoever holds the
 * mapped role and currently carries the fewest live tasks, oldest profile
 * winning a tie. Returns null when nobody holds the role — the task is
 * then created unassigned and surfaced in the UI for a human to claim.
 */
async function resolveAssignee(
  orgId: string,
  role: UserRole,
): Promise<string | null> {
  if (!supabaseAdmin) return null;

  const { data: candidates } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('org_id', orgId)
    .eq('role', role)
    .order('created_at', { ascending: true });

  const ids = (candidates ?? []).map((p) => (p as { id: string }).id);
  if (ids.length === 0) return null;
  if (ids.length === 1) return ids[0];

  // Count live tasks per candidate and take the lightest load.
  const { data: load } = await supabaseAdmin
    .from('tasks')
    .select('assigned_to')
    .eq('org_id', orgId)
    .in('assigned_to', ids)
    .in('status', LIVE_STATUSES);

  const counts = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const row of load ?? []) {
    const id = (row as { assigned_to: string | null }).assigned_to;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  // `ids` is already oldest-first, so the first minimum wins the tie.
  return ids.reduce((best, id) => ((counts.get(id) ?? 0) < (counts.get(best) ?? 0) ? id : best), ids[0]);
}

/**
 * Raise tasks from email already stored in the system.
 *
 * Ingestion skips messages it has seen before, so mail that arrived before
 * the tasks table existed would never produce work. This walks the stored
 * emails that have no task yet and runs the same extraction over them,
 * using the snippet and the summary Claude wrote at ingest time in place
 * of the original body.
 *
 * Safe to run repeatedly: emails that already have a task are skipped, and
 * the unique index is the backstop.
 */
export async function backfillTasks(
  orgId: string,
  limit = 50,
): Promise<{ ok: boolean; reason?: string; scanned: number; created: number }> {
  if (!supabaseAdmin) return { ok: false, reason: 'supabase_not_configured', scanned: 0, created: 0 };

  const { data: existing, error: exErr } = await supabaseAdmin
    .from('tasks')
    .select('source_email_id')
    .eq('org_id', orgId)
    .not('source_email_id', 'is', null);
  if (exErr) return { ok: false, reason: exErr.message, scanned: 0, created: 0 };
  const done = new Set((existing ?? []).map((r) => (r as { source_email_id: string }).source_email_id));

  const { data: emails, error } = await supabaseAdmin
    .from('emails')
    .select('id, class, subject, from_addr, to_addr, snippet, extracted_json')
    .eq('org_id', orgId)
    .not('class', 'in', `(${IGNORED_CLASSES.map((c) => `"${c}"`).join(',')})`)
    .order('received_at', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) return { ok: false, reason: error.message, scanned: 0, created: 0 };

  let scanned = 0;
  let created = 0;
  for (const row of emails ?? []) {
    const e = row as {
      id: string; class: string; subject: string | null;
      from_addr: string | null; to_addr: string | null; snippet: string | null;
      extracted_json: { summary?: string } | null;
    };
    if (done.has(e.id)) continue;
    scanned++;
    try {
      // The original body is not stored; the ingest-time summary is usually
      // a better signal than the raw snippet anyway, so use both.
      const body = [e.extracted_json?.summary, e.snippet].filter(Boolean).join('\n\n');
      const made = await createTaskFromEmail(orgId, e.id, e.class, {
        gmailId: '',
        threadId: '',
        from: e.from_addr ?? '',
        to: e.to_addr ?? '',
        replyTo: '',
        subject: e.subject ?? '',
        snippet: e.snippet ?? '',
        body,
        receivedAt: null,
        attachments: [],
      } as unknown as ParsedEmail);
      if (made) created++;
    } catch (err) {
      console.error('[backfill] task from email failed:', (err as Error).message);
    }
  }
  return { ok: true, scanned, created };
}

/**
 * Read one classified email, decide whether it implies work, and if so
 * create a task assigned by role. Idempotent: the unique index on
 * (org_id, source_email_id) means a re-promoted email is a no-op.
 */
export async function createTaskFromEmail(
  orgId: string,
  emailId: string,
  emailClass: string,
  parsed: ParsedEmail,
): Promise<boolean> {
  if (!supabaseAdmin) return false;
  if (IGNORED_CLASSES.includes(emailClass)) return false;

  // Cheap guard before the Claude call — avoids re-extracting on a backfill.
  const { data: existing } = await supabaseAdmin
    .from('tasks')
    .select('id')
    .eq('org_id', orgId)
    .eq('source_email_id', emailId)
    .maybeSingle();
  if (existing) return false;

  const extracted = await extractTask(parsed);
  if (!extracted || !extracted.needs_task) return false;

  const title = String(extracted.title ?? '').trim().slice(0, 200);
  if (!title) return false;

  const kind: TaskKind = TASK_KINDS.includes(extracted.kind) ? extracted.kind : 'admin';
  const role = TASK_KIND_ROLE[kind];
  const assignedTo = await resolveAssignee(orgId, role);

  // promoteEmail may have re-linked this email to a project/vendor, so read
  // the row back rather than trusting the ids the caller started with.
  const { data: email } = await supabaseAdmin
    .from('emails')
    .select('project_id, vendor_id')
    .eq('id', emailId)
    .maybeSingle();

  const { error } = await supabaseAdmin.from('tasks').insert({
    org_id: orgId,
    title,
    detail: extracted.detail ?? null,
    kind,
    assigned_to: assignedTo,
    assigned_role: role,
    project_id: (email as { project_id: string | null } | null)?.project_id ?? null,
    vendor_id: (email as { vendor_id: string | null } | null)?.vendor_id ?? null,
    source_email_id: emailId,
    due_date: extracted.due_date ?? null,
  });

  // A concurrent ingest may have won the race; the unique index makes that safe.
  if (error) {
    if (error.code === '23505') return false;
    throw new Error(error.message);
  }

  await supabaseAdmin.from('activity_log').insert({
    org_id: orgId,
    action: 'task.create',
    entity: 'tasks',
    entity_id: emailId,
    meta: { title, kind, assigned_role: role, assigned: Boolean(assignedTo) },
  });

  return true;
}
