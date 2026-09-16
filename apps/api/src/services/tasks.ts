import {
  DEFAULT_SLA, SEATS, SEAT_KEYS, TASK_HYGIENE_SEAT, TASK_KIND_ROLE, TASK_KINDS,
  dueDateFor, seatPeople,
  type Seat, type SlaSettings, type TaskKind, type UserRole,
} from '@janelle/shared';
import { supabaseAdmin } from '../lib/supabase.js';
import { hasSeatColumn } from '../lib/columns.js';
import { extractTask } from './extract.js';
import { loadStudioNames } from '../lib/studioNames.js';
import { STUDIO_TEAM, isStudioMailbox } from '../lib/studioTeam.js';
import { matchPerson } from './proposals.js';
import type { ParsedEmail } from './gmail.js';

/**
 * Classes that never imply internal work.
 *
 * Only Houzz's own automated notifications are excluded. "general" is NOT:
 * the studio delegates by email, so internal messages like "Task in houzz —
 * can you see if you can get Yael to send elevations" classify as general
 * and are exactly the work this system exists to capture. Filtering noise is
 * the extraction prompt's job, via needs_task.
 */
const IGNORED_CLASSES = ['houzz_notification'];

/** Statuses that still count against someone's workload. */
const LIVE_STATUSES = ['open', 'in_progress', 'blocked'];

/**
 * The studio's SLA, briefly cached.
 *
 * Every task raised needs it to work out a due date, and a reading pass
 * raises them in a loop — without this that is one extra query per email.
 */
const SLA_TTL_MS = 60_000;
const slaCache = new Map<string, { at: number; value: SlaSettings }>();

async function readSla(orgId: string): Promise<SlaSettings> {
  const hit = slaCache.get(orgId);
  if (hit && Date.now() - hit.at < SLA_TTL_MS) return hit.value;
  if (!supabaseAdmin) return DEFAULT_SLA;

  try {
    const { data } = await supabaseAdmin
      .from('organizations')
      .select('settings')
      .eq('id', orgId)
      .maybeSingle();
    const settings = ((data as { settings?: Partial<SlaSettings> } | null)?.settings ?? {}) as Partial<SlaSettings>;
    const value: SlaSettings = { ...DEFAULT_SLA, ...settings };
    slaCache.set(orgId, { at: Date.now(), value });
    return value;
  } catch (err) {
    console.error('[tasks] SLA unreadable, using defaults:', (err as Error).message);
    return DEFAULT_SLA;
  }
}

/**
 * Resolve a name or address the sender used ("Joanna", "get Yael to...")
 * against the team. Matches on full name, either part of it, or the local
 * part of the email address, so a first name is enough.
 */
async function resolveNamedPerson(orgId: string, hint: string | null): Promise<string | null> {
  if (!supabaseAdmin || !hint) return null;
  const needle = hint.trim().toLowerCase();
  if (needle.length < 2) return null;

  const { data } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, email')
    .eq('org_id', orgId);
  const accounts = (data ?? []) as { id: string; full_name: string | null; email: string | null }[];

  // The part of an address before the @ names its owner: "carissa" is
  // carissa@. Never a shared inbox's — "systems" is nobody.
  const byLocalPart = accounts.find(
    (p) => p.email && !isStudioMailbox(p.email) && !needle.includes('@') && p.email.split('@')[0].toLowerCase() === needle,
  );
  if (byLocalPart) return byLocalPart.id;

  // An address is exact or it is nobody; a name goes through the same matcher
  // Jenny uses: whole name, every word, the start of a name, a spelling one
  // or two letters out, every other spelling the studio lists — and never a
  // pick between two equally good answers. The substring test this replaced
  // gave any task that mentioned "an" to Brianna.
  const named = accounts.filter((p) => p.full_name) as { id: string; full_name: string; email: string | null }[];
  const match = matchPerson(hint, named);
  // Work nobody reads is not assigned: a shared inbox is never the owner.
  return match.status === 'found' && !isStudioMailbox(match.row.email) ? match.row.id : null;
}

/**
 * Whoever holds a seat: the account given that seat on Team & roles, then
 * the people the roles document names for it — by their address on the
 * studio's list, then by name. Null for the vacant COO seat, and for a seat
 * whose people have no account yet.
 */
async function resolveSeatHolder(orgId: string, seat: Seat): Promise<string | null> {
  if (!supabaseAdmin) return null;

  if (await hasSeatColumn()) {
    const { data } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('org_id', orgId)
      .eq('seat', seat)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    const id = (data as { id?: string } | null)?.id;
    if (id) return id;
  }

  // "Brianna Johnson / Amanda Neubecker" share the design seat; each in turn.
  // An account made with only a first name still counts, unless that first
  // name is shared.
  for (const name of seatPeople(seat)) {
    const email = STUDIO_TEAM.find((p) => p.name === name)?.email;
    for (const said of [email, name, name.split(' ')[0]]) {
      const id = said ? await resolveNamedPerson(orgId, said) : null;
      if (id) return id;
    }
  }
  return null;
}

/** Route to whoever holds the seat that owns this outcome. */
async function resolveBySeat(orgId: string, seat: Seat | null): Promise<string | null> {
  if (!seat || !SEAT_KEYS.includes(seat)) return null;
  return resolveSeatHolder(orgId, seat);
}

/**
 * Work out who owns a task from the email chain itself.
 *
 * The sender is delegating, so the person being written TO is the owner —
 * not the person writing. Skips the sender and the connected mailbox, and
 * prefers the first teammate on the To: line, falling back to Cc.
 */
async function resolveFromChain(
  orgId: string,
  parsed: { from?: string; to?: string; cc?: string[] },
): Promise<string | null> {
  if (!supabaseAdmin) return null;

  const addresses = (raw: string | undefined) =>
    (raw ?? '')
      .split(',')
      .map((part) => {
        const m = part.match(/<([^>]+)>/);
        return (m ? m[1] : part).trim().toLowerCase();
      })
      .filter((a) => a.includes('@'));

  const sender = new Set(addresses(parsed.from));
  // Mail to a shared inbox was sent to the studio, not handed to a person.
  const recipients = [...addresses(parsed.to), ...(parsed.cc ?? []).map((c) => c.toLowerCase())]
    .filter((a) => !sender.has(a) && !isStudioMailbox(a));
  if (recipients.length === 0) return null;

  const { data } = await supabaseAdmin
    .from('profiles')
    .select('id, email')
    .eq('org_id', orgId);

  const byEmail = new Map<string, string>();
  for (const row of data ?? []) {
    const p = row as { id: string; email: string | null };
    if (p.email) byEmail.set(p.email.toLowerCase(), p.id);
  }
  // Order matters: To: before Cc:, first named first.
  for (const addr of recipients) {
    const id = byEmail.get(addr);
    if (id) return id;
  }
  return null;
}

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
 * Whoever runs the task board, as a last resort before leaving work ownerless.
 *
 * A studio only half-onboarded has nobody in most roles, so routing by kind
 * finds no one and the task lands unassigned — which in practice means
 * nobody ever sees it. The roles document already names who that is: the PM
 * support seat owns "chasing overdue and unassigned tasks", so triage is
 * genuinely that seat's work rather than a dumping ground.
 *
 * Deliberately NOT the principal. She is the bottleneck this system exists
 * to relieve, and quietly defaulting everything to her would rebuild the
 * problem in software.
 */
async function resolveTriage(orgId: string): Promise<string | null> {
  return resolveSeatHolder(orgId, TASK_HYGIENE_SEAT);
}

// ── Deduplication ───────────────────────────────────────────

/**
 * Compare titles without caring about case, punctuation or spacing.
 *
 * Claude writes the title fresh for each email, so the same ask arriving
 * twice comes back as "Tell Denish which Slack workspace to use (existing
 * or new)" both times — but a stray comma or a trailing full stop would
 * defeat a plain string comparison.
 */
function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface DuplicateTaskRow {
  id: string;
  title: string;
  status: string;
  project_id: string | null;
  assigned_to: string | null;
  next_step: string | null;
  due_date: string | null;
  detail: string | null;
  created_at: string;
}

/** Fields that make one copy of a task more useful than another. */
const TASK_FIELDS = ['assigned_to', 'next_step', 'due_date', 'detail'] as const;

function filled(t: DuplicateTaskRow): number {
  return TASK_FIELDS.filter((f) => t[f] !== null && t[f] !== undefined && t[f] !== '').length;
}

export interface TaskDedupe {
  ok: boolean;
  reason?: string;
  /** Task rows deleted. */
  removed: number;
  /** One entry per group folded together. */
  merged: { kept: string; removed: number }[];
}

/**
 * Remove tasks that are the same piece of work raised more than once.
 *
 * Creating a task now refuses a live duplicate, but the board already holds
 * the ones raised before that guard existed. Only LIVE work is considered:
 * a finished task and a new one with the same title are usually the job
 * genuinely coming round again, not a mistake.
 *
 * The survivor keeps whatever the copies knew that it did not — an owner, a
 * next step, a due date — so folding them together never loses detail.
 */
export async function mergeDuplicateTasks(orgId: string): Promise<TaskDedupe> {
  if (!supabaseAdmin) return { ok: false, reason: 'supabase_not_configured', removed: 0, merged: [] };

  const { data } = await supabaseAdmin
    .from('tasks')
    .select('id, title, status, project_id, assigned_to, next_step, due_date, detail, created_at')
    .eq('org_id', orgId)
    .in('status', LIVE_STATUSES)
    .order('created_at', { ascending: true });

  const tasks = (data ?? []) as DuplicateTaskRow[];

  // Same wording AND same project. Two jobs may each need "Chase the vendor
  // for a quote", and those are two real tasks.
  const groups = new Map<string, DuplicateTaskRow[]>();
  for (const t of tasks) {
    const key = `${t.project_id ?? 'none'}::${titleKey(t.title)}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }

  const result: TaskDedupe = { ok: true, removed: 0, merged: [] };

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    // The most complete copy survives; the oldest breaks a tie, being the
    // one people have already seen on the board.
    const keep = [...group].sort(
      (a, b) => filled(b) - filled(a) || a.created_at.localeCompare(b.created_at),
    )[0];
    const losers = group.filter((t) => t.id !== keep.id);

    try {
      const patch: Record<string, unknown> = {};
      for (const field of TASK_FIELDS) {
        if (keep[field] === null || keep[field] === undefined || keep[field] === '') {
          const donor = losers.find((l) => l[field] !== null && l[field] !== undefined && l[field] !== '');
          if (donor) patch[field] = donor[field];
        }
      }
      if (Object.keys(patch).length) {
        await supabaseAdmin.from('tasks').update(patch).eq('id', keep.id).eq('org_id', orgId);
      }

      // follow_ups.task_id cascades, so a reminder raised against a copy
      // goes with it rather than dangling.
      const { error } = await supabaseAdmin
        .from('tasks')
        .delete()
        .eq('org_id', orgId)
        .in('id', losers.map((l) => l.id));
      if (error) throw new Error(error.message);

      result.removed += losers.length;
      result.merged.push({ kept: keep.title, removed: losers.length });
    } catch (err) {
      // Leave this group alone rather than half-merged; the rest still run.
      console.error('[tasks] dedupe failed for', keep.title, (err as Error).message);
    }
  }

  if (result.removed) {
    await supabaseAdmin.from('activity_log').insert({
      org_id: orgId,
      action: 'tasks.deduped',
      entity: 'tasks',
      meta: { removed: result.removed, groups: result.merged },
    });
  }

  return result;
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

  // promoteEmail may have re-linked this email to a project/vendor, so read
  // the row back rather than trusting the ids the caller started with.
  //
  // Read BEFORE the task is written, not after: the title names the job,
  // and naming it from the email's own wording is how the board filled with
  // "Finalize furniture proposal for Lemon's Project" while the project on
  // file was Lemon Residence.
  const { data: email } = await supabaseAdmin
    .from('emails')
    .select('project_id, vendor_id, projects(name, client_name)')
    .eq('id', emailId)
    .maybeSingle();
  const filedUnder = (email as { projects?: { name: string; client_name: string | null } | null } | null)?.projects ?? null;

  const extracted = await extractTask(parsed, { orgId }, {
    project: filedUnder?.name ?? null,
    client: filedUnder?.client_name ?? null,
    names: await loadStudioNames(orgId),
  });
  if (!extracted || !extracted.needs_task) return false;

  const title = String(extracted.title ?? '').trim().slice(0, 200);
  if (!title) return false;

  const kind: TaskKind = TASK_KINDS.includes(extracted.kind) ? extracted.kind : 'admin';
  const role = TASK_KIND_ROLE[kind];

  // The unique index keys on the SOURCE EMAIL, so a thread where two
  // messages both ask for the same thing raised the same task twice — the
  // studio saw "Tell Denish which Slack workspace to use" on the board
  // twice over. One live task per piece of work: if the same title is
  // already open on the same project, the follow-up mail is a repeat of the
  // ask, not new work.
  //
  // Scoped to the project, not the whole studio: "Chase the vendor for a
  // quote" is one task per job, and org-wide matching would silently drop
  // the second job's.
  const { data: liveSame } = await supabaseAdmin
    .from('tasks')
    .select('id, title, project_id')
    .eq('org_id', orgId)
    .in('status', LIVE_STATUSES);

  const wanted = titleKey(title);
  const projectOf = (email as { project_id: string | null } | null)?.project_id ?? null;
  // Same ask on the same job — or on a job and on nothing. A reply that
  // arrives before the project exists files the first copy nowhere, and
  // requiring the projects to be equal let the second one in beside it.
  // Two DIFFERENT projects are still two jobs.
  const already = (liveSame ?? []).some((row) => {
    const r = row as { title: string; project_id: string | null };
    if (titleKey(r.title) !== wanted) return false;
    return r.project_id === projectOf || r.project_id === null || projectOf === null;
  });
  if (already) return false;

  // Four ways to decide the owner, most specific first. Each step is a
  // weaker signal than the one above it:
  //   1. a person named in the body — the sender already decided
  //   2. whoever the mail was addressed to — the chain says who was asked
  //   3. the seat that owns this outcome, per the studio's roles document
  //   4. the role that owns this kind of work
  //   5. whoever runs the board, so nothing is created ownerless
  const seat = (extracted.seat && SEAT_KEYS.includes(extracted.seat) ? extracted.seat : null) as Seat | null;
  const assignedTo =
    (await resolveNamedPerson(orgId, extracted.assignee_hint ?? null)) ??
    (await resolveFromChain(orgId, parsed as { from?: string; to?: string })) ??
    (await resolveBySeat(orgId, seat)) ??
    (await resolveAssignee(orgId, role)) ??
    (await resolveTriage(orgId));

  const { error } = await supabaseAdmin.from('tasks').insert({
    org_id: orgId,
    title,
    detail: extracted.detail ?? null,
    kind,
    assigned_to: assignedTo,
    assigned_role: seat ? SEATS[seat].role : role,
    seat,
    next_step: extracted.next_step ?? null,
    project_id: (email as { project_id: string | null } | null)?.project_id ?? null,
    vendor_id: (email as { vendor_id: string | null } | null)?.vendor_id ?? null,
    source_email_id: emailId,
    // The email's own date when it gave one; otherwise the studio's SLA for
    // this kind of work. A task with no date cannot be chased for being
    // late, so "none" is the one answer that helps nobody.
    due_date: extracted.due_date ?? dueDateFor(kind, await readSla(orgId)),
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
    meta: {
      title,
      kind,
      assigned_role: role,
      assigned: Boolean(assignedTo),
      // Worth recording which dates the studio actually committed to.
      due_from: extracted.due_date ? 'email' : 'sla',
    },
  });

  return true;
}
