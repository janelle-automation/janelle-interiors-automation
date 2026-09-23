import {
  DEFAULT_SLA, SEATS, SEAT_KEYS, TASK_HYGIENE_SEAT, TASK_KIND_LABELS, TASK_KIND_ROLE, TASK_KINDS,
  dueDateFor, seatPeople,
  type Seat, type SlaSettings, type TaskKind, type UserRole,
} from '@janelle/shared';
import { supabaseAdmin } from '../lib/supabase.js';
import { hasSeatColumn, hasSubtasks, hasTaskCompletion } from '../lib/columns.js';
import { extractTask, type TaskExtraction } from './extract.js';
import { loadStudioNames } from '../lib/studioNames.js';
import { STUDIO_TEAM, isAutomatedAddress, isStudioAddress, isStudioMailbox } from '../lib/studioTeam.js';
import { matchProjectId } from './promote.js';
import { matchPerson } from './proposals.js';
import { gmailFor, readSentMail, type ParsedEmail } from './gmail.js';
import { orgSourceUserId } from '../lib/tokens.js';
import { bodyColumnsReady, readStoredText } from '../lib/emailStore.js';

/**
 * An email whose "does this need a task?" has already been answered NO.
 *
 * Without it every scan asked the question again of every email that had
 * not raised a task — the studio's whole inbox, one Claude call each, on
 * every press of the button, to get the same "no" as last time. Kept in
 * `extracted_json` under an underscore key, the convention `emailStore`
 * already uses for data stored beside the model's own output, so it needs
 * no migration. Only a definite no is remembered: a call that failed is
 * worth asking again.
 */
const TASK_CHECKED_KEY = '_task_checked';

async function markTaskChecked(emailId: string): Promise<void> {
  if (!supabaseAdmin) return;
  try {
    const { data } = await supabaseAdmin.from('emails').select('extracted_json').eq('id', emailId).maybeSingle();
    const current = (data as { extracted_json: Record<string, unknown> | null } | null)?.extracted_json ?? {};
    await supabaseAdmin
      .from('emails')
      .update({ extracted_json: { ...current, [TASK_CHECKED_KEY]: new Date().toISOString() } })
      .eq('id', emailId);
  } catch {
    // A missed mark costs one more question on the next scan, nothing more.
  }
}

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
  parsed: { from?: string; to?: string; cc?: string | string[] },
): Promise<string | null> {
  if (!supabaseAdmin) return null;

  // Gmail gives Cc as one header line, "A <a@x>, b@y"; older callers passed a
  // list. Treating the line as a list threw, and every task from a message
  // failed with it.
  const addresses = (raw: string | string[] | undefined) =>
    (Array.isArray(raw) ? raw.join(',') : raw ?? '')
      .split(',')
      .map((part) => {
        const m = part.match(/<([^>]+)>/);
        return (m ? m[1] : part).trim().toLowerCase();
      })
      .filter((a) => a.includes('@'));

  const sender = new Set(addresses(parsed.from));
  // Mail to a shared inbox was sent to the studio, not handed to a person.
  const recipients = [...addresses(parsed.to), ...addresses(parsed.cc)]
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
    .select('id, email')
    .eq('org_id', orgId)
    .eq('role', role)
    .order('created_at', { ascending: true });

  // A shared inbox holds a role so it can sign in; nobody reads work given to it.
  const ids = ((candidates ?? []) as { id: string; email: string | null }[])
    .filter((p) => !isStudioMailbox(p.email))
    .map((p) => p.id);
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
// ────────────────────────────────────────────────────────────
//  Open → In progress, from the conversation itself
//
//  Every task on the board sat in Open, because the only thing that ever
//  moved one was a person changing the dropdown. A task is raised from an
//  email; the moment anybody writes on that thread again — the studio
//  answering it, or the vendor coming back — the work has started, and the
//  board should say so rather than waiting to be told.
//
//  Deliberately one-way and only out of `open`: blocked, done and cancelled
//  are judgements a person made, and a stray reply must not undo them.
// ────────────────────────────────────────────────────────────

/**
 * Move tasks whose source thread has moved to `in_progress`.
 *
 * Returns how many were advanced. Never throws: this runs behind ingestion
 * and must not be able to fail it.
 */
export async function advanceActiveTasks(orgId: string): Promise<number> {
  if (!supabaseAdmin) return 0;

  try {
    const { data: openTasks } = await supabaseAdmin
      .from('tasks')
      .select('id, title, source_email_id, created_at, project_id, vendor_id')
      .eq('org_id', orgId)
      .eq('status', 'open');

    const tasks = (openTasks ?? []) as unknown as {
      id: string; title: string; source_email_id: string | null; created_at: string;
      project_id: string | null; vendor_id: string | null;
    }[];
    if (!tasks.length) return 0;

    // The thread each task came out of.
    const sourceIds = tasks.map((t) => t.source_email_id).filter((id): id is string => !!id);
    const { data: sources } = sourceIds.length
      ? await supabaseAdmin.from('emails').select('id, thread_id').in('id', sourceIds)
      : { data: [] };
    const threadOf = new Map(
      ((sources ?? []) as { id: string; thread_id: string | null }[])
        .filter((e) => e.thread_id)
        .map((e) => [e.id, e.thread_id as string]),
    );

    // Everything the studio has read since the oldest open task was raised —
    // not only mail on those threads.
    //
    // A conversation does not stay in its thread. Somebody drops out of it
    // and writes a fresh email about the same job a week later, and to a
    // thread-scoped check that is silence: the task sat at Open and aged
    // into overdue while the work was visibly moving. What identifies the
    // conversation is the job and the supplier, not the thread id.
    const oldest = tasks.reduce((min, t) => (t.created_at < min ? t.created_at : min), tasks[0].created_at);
    const { data: later } = await supabaseAdmin
      .from('emails')
      .select('thread_id, received_at, project_id, vendor_id')
      .eq('org_id', orgId)
      .gte('received_at', oldest)
      .order('received_at', { ascending: false })
      .limit(1000);

    const lastInbound = new Map<string, string>();
    /** Latest mail per supplier, and per supplier-on-a-job. */
    const lastByVendor = new Map<string, string>();
    const lastByVendorJob = new Map<string, string>();
    const keep = (map: Map<string, string>, key: string, at: string) => {
      const seen = map.get(key);
      if (!seen || seen < at) map.set(key, at);
    };
    for (const row of (later ?? []) as {
      thread_id: string | null; received_at: string | null; project_id: string | null; vendor_id: string | null;
    }[]) {
      if (!row.received_at) continue;
      if (row.thread_id) keep(lastInbound, row.thread_id, row.received_at);
      if (row.vendor_id) {
        keep(lastByVendor, row.vendor_id, row.received_at);
        if (row.project_id) keep(lastByVendorJob, `${row.vendor_id}|${row.project_id}`, row.received_at);
      }
    }

    // The addresses each supplier is reached at, so "we wrote to them" can
    // be recognised on a thread this system has never seen.
    const { data: vendorRows } = await supabaseAdmin
      .from('vendors')
      .select('id, contacts')
      .eq('org_id', orgId);
    const vendorAddresses = new Map<string, string[]>();
    for (const v of (vendorRows ?? []) as { id: string; contacts: { email?: string }[] | null }[]) {
      const list = (Array.isArray(v.contacts) ? v.contacts : [])
        .map((c) => (c.email ?? '').trim().toLowerCase())
        .filter(Boolean);
      if (list.length) vendorAddresses.set(v.id, list);
    }

    // And the half ingestion cannot see: the studio replying from Gmail,
    // which is the most direct evidence there is that someone picked the
    // task up.
    let sentOnThread = new Map<string, string>();
    let sentToAddress = new Map<string, string>();
    try {
      const days = Math.ceil((Date.now() - new Date(oldest).getTime()) / 86400_000) + 1;
      const userId = await orgSourceUserId(orgId);
      const gmail = userId ? await gmailFor(userId) : null;
      if (gmail) {
        const sent = await readSentMail(gmail, Math.min(days, 30));
        sentOnThread = sent.byThread;
        sentToAddress = sent.byAddress;
      }
    } catch (err) {
      console.error('[tasks] sent-mail check failed', (err as Error).message);
    }

    /**
     * Why this task is moving, or null if nothing says it is.
     *
     * Three kinds of evidence, strongest first. Each one is deliberately
     * narrow: "in progress" has to keep meaning something, so a busy job is
     * not allowed to advance every task attached to it. The supplier is
     * what ties the evidence to the work — mail about the same job from
     * somebody unrelated proves nothing about this particular task.
     */
    const movedBy = (t: (typeof tasks)[number]): string | null => {
      const after = (at: string | undefined) => !!at && at > t.created_at;

      const thread = t.source_email_id ? threadOf.get(t.source_email_id) : undefined;
      if (thread && (after(sentOnThread.get(thread)) || after(lastInbound.get(thread)))) {
        return 'a message on its own thread';
      }

      if (!t.vendor_id) return null;

      // The studio wrote to this supplier — on any thread, including one
      // composed fresh. The most direct evidence there is that a person
      // picked the task up, and the case a thread check cannot see at all.
      const addresses = vendorAddresses.get(t.vendor_id) ?? [];
      if (addresses.some((a) => after(sentToAddress.get(a)))) return 'the studio wrote to the supplier';

      // The supplier wrote back. Tied to the job where the task names one,
      // so an unrelated order with the same vendor does not count.
      const key = t.project_id ? `${t.vendor_id}|${t.project_id}` : null;
      if (key ? after(lastByVendorJob.get(key)) : after(lastByVendor.get(t.vendor_id))) {
        return 'the supplier wrote about this job';
      }

      return null;
    };

    const moving = tasks
      .map((t) => ({ task: t, why: movedBy(t) }))
      .filter((m): m is { task: (typeof tasks)[number]; why: string } => m.why !== null);
    if (!moving.length) return 0;

    await supabaseAdmin
      .from('tasks')
      .update({ status: 'in_progress' })
      .in('id', moving.map((m) => m.task.id));

    await supabaseAdmin.from('activity_log').insert({
      org_id: orgId,
      action: 'tasks.advanced',
      entity: 'tasks',
      // What moved each one, so a status nobody set can be accounted for.
      meta: {
        count: moving.length,
        moved: moving.slice(0, 8).map((m) => ({ title: m.task.title, why: m.why })),
      },
    });

    return moving.length;
  } catch (err) {
    console.error('[tasks] advancing failed', (err as Error).message);
    return 0;
  }
}

// ────────────────────────────────────────────────────────────
//  Closing work the mail shows is finished
//
//  advanceActiveTasks says a task has started. Nothing said it had ended:
//  a task whose work was done early — the vendor sent the quote, the client
//  approved — stayed on the board until somebody dragged it to Done, and
//  once its date passed the nightly engine chased its owner for work that
//  was already finished.
//
//  The email that finishes a task is read anyway, by the same Claude call
//  that decides whether it raises one, so that call is also shown the open
//  tasks it could plausibly finish and asked which it does. No extra call,
//  and a close has to quote the words in the email that prove it.
// ────────────────────────────────────────────────────────────

/** At most this many open tasks are put to the model per email. */
const MAX_CLOSABLE = 8;

export interface LiveTask {
  id: string;
  title: string;
  kind: TaskKind;
  next_step: string | null;
  due_date: string | null;
  created_at: string;
  project_id: string | null;
  vendor_id: string | null;
  source_email_id: string | null;
  projects?: { name: string } | null;
  vendors?: { name: string } | null;
}

/** The email being read, as stored. */
export interface EmailFacts {
  id: string;
  thread_id: string | null;
  received_at: string | null;
  project_id: string | null;
  vendor_id: string | null;
  subject: string | null;
  from_addr: string | null;
}

export interface ClosableTask {
  ref: string;
  task: LiveTask;
  /** One line for the prompt: the task, its job and supplier, and why it was picked. */
  line: string;
}

const LIVE_TASK_COLUMNS =
  'id, title, kind, next_step, due_date, created_at, project_id, vendor_id, source_email_id, projects(name), vendors(name)';

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/**
 * The live tasks one email could plausibly finish, closest first.
 *
 * Related means the same thread, or the same job, or the same supplier on a
 * job that does not contradict it — a quote from a vendor for one job must
 * not close the chase for the same vendor's quote on another. And the email
 * has to come AFTER the ask: mail from before a task existed cannot be its
 * answer, which matters when an older email is read late.
 *
 * Pure, so the ranking can be checked without a database.
 */
export function rankClosable(
  email: EmailFacts,
  tasks: LiveTask[],
  sources: Map<string, { thread_id: string | null; received_at: string | null }>,
): { task: LiveTask; why: string }[] {
  const at = Number.isNaN(ms(email.received_at)) ? Date.now() : ms(email.received_at);
  const scored: { task: LiveTask; why: string; score: number }[] = [];

  for (const t of tasks) {
    if (t.source_email_id === email.id) continue;
    const source = t.source_email_id ? sources.get(t.source_email_id) : undefined;
    const since = Number.isNaN(ms(source?.received_at)) ? ms(t.created_at) : ms(source?.received_at);
    if (!Number.isNaN(since) && at <= since) continue;

    const sameThread = !!email.thread_id && source?.thread_id === email.thread_id;
    const sameProject = !!email.project_id && t.project_id === email.project_id;
    const sameVendor = !!email.vendor_id && t.vendor_id === email.vendor_id;
    const otherJob = !!email.project_id && !!t.project_id && t.project_id !== email.project_id;

    if (!sameThread && otherJob) continue;
    const score = sameThread ? 3 : sameProject && sameVendor ? 2 : sameProject || sameVendor ? 1 : 0;
    if (!score) continue;

    const why = sameThread ? 'same email thread' : sameProject && sameVendor ? 'same job and supplier' : sameProject ? 'same job' : 'same supplier';
    scored.push({ task: t, why, score });
  }

  // Closest relation first, then the newest ask: a thread's latest request is
  // the one a reply is most likely answering.
  scored.sort((a, b) => b.score - a.score || ms(b.task.created_at) - ms(a.task.created_at));
  return scored.map(({ task, why }) => ({ task, why }));
}

function closableLine(t: LiveTask, why: string): string {
  return [
    `${t.title} (${TASK_KIND_LABELS[t.kind] ?? t.kind})`,
    t.projects?.name ? `job: ${t.projects.name}` : null,
    t.vendors?.name ? `supplier: ${t.vendors.name}` : null,
    t.next_step ? `next step: ${t.next_step}` : null,
    `raised ${t.created_at.slice(0, 10)}`,
    why,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The open tasks to show the model for this email, with refs.
 *
 * Two kinds are left out on purpose: a task a person reopened after the
 * system had closed it (they have said it is not finished, and the next
 * reply on the thread would only close it again), and a parent whose
 * subtasks are still live (its steps are the record of what is left).
 * Never throws — without it, the email still raises its task.
 */
async function loadClosable(orgId: string, email: EmailFacts): Promise<ClosableTask[]> {
  if (!supabaseAdmin) return [];
  try {
    const { data: rows } = await supabaseAdmin
      .from('tasks')
      .select(LIVE_TASK_COLUMNS)
      .eq('org_id', orgId)
      .in('status', LIVE_STATUSES);
    const live = (rows ?? []) as unknown as LiveTask[];
    if (!live.length) return [];

    const sourceIds = [...new Set(live.map((t) => t.source_email_id).filter((id): id is string => !!id))];
    const { data: sourceRows } = sourceIds.length
      ? await supabaseAdmin.from('emails').select('id, thread_id, received_at').in('id', sourceIds)
      : { data: [] };
    const sources = new Map(
      ((sourceRows ?? []) as { id: string; thread_id: string | null; received_at: string | null }[]).map((e) => [e.id, e]),
    );

    const ranked = rankClosable(email, live, sources);
    if (!ranked.length) return [];
    const ids = ranked.map((r) => r.task.id);

    const { data: reopened } = await supabaseAdmin
      .from('activity_log')
      .select('entity_id')
      .eq('org_id', orgId)
      .eq('action', 'task.auto_complete')
      .in('entity_id', ids);
    const skip = new Set(((reopened ?? []) as { entity_id: string }[]).map((r) => r.entity_id));

    if (await hasSubtasks()) {
      const { data: kids } = await supabaseAdmin
        .from('tasks')
        .select('parent_task_id')
        .in('parent_task_id', ids)
        .in('status', LIVE_STATUSES);
      for (const k of (kids ?? []) as { parent_task_id: string }[]) skip.add(k.parent_task_id);
    }

    return ranked
      .filter((r) => !skip.has(r.task.id))
      .slice(0, MAX_CLOSABLE)
      .map((r, i) => ({ ref: `T${i + 1}`, task: r.task, line: closableLine(r.task, r.why) }));
  } catch (err) {
    console.error('[tasks] finding closable tasks failed:', (err as Error).message);
    return [];
  }
}

/** "Acme Sales" from `"Acme Sales" <sales@acme.com>`; the address when there is no name. */
/**
 * Where a stored message's text lives, which depends on whether migration
 * 0010 has been applied — before it, the body was tucked inside
 * `extracted_json`. `readStoredText` reads either shape.
 */
async function bodyFieldNames(): Promise<string[]> {
  return (await bodyColumnsReady()) ? ['body_text', 'links', 'extracted_json'] : ['extracted_json'];
}

/** How many earlier messages of a thread are worth the tokens. */
const THREAD_CONTEXT = 4;

/** How much of each one — enough to carry the ask, not the whole history. */
const THREAD_CHARS = 1500;

/**
 * What was said before this message, oldest first.
 *
 * The work an email implies is usually not in the email. A thread opens with
 * the ask and closes with "approved, go ahead" — and the closing message,
 * read on its own, was all the task extractor ever saw. It could not name
 * the job, the supplier or the work, so it raised nothing, or raised a task
 * whose title was the word "Approved".
 *
 * Bounded on purpose: the last few messages carry the ask, and a long thread
 * would otherwise cost more in tokens than the task is worth. Never throws —
 * a task read from one message is worse than one read from the conversation,
 * but far better than no task at all.
 */
async function loadThreadContext(
  orgId: string,
  threadId: string | null,
  exceptEmailId: string,
): Promise<{ from: string; date: string; text: string }[]> {
  if (!supabaseAdmin || !threadId) return [];
  try {
    const { data } = await supabaseAdmin
      .from('emails')
      .select(`id, from_addr, subject, snippet, received_at, ${(await bodyFieldNames()).join(', ')}`)
      .eq('org_id', orgId)
      .eq('thread_id', threadId)
      .neq('id', exceptEmailId)
      .order('received_at', { ascending: false })
      .limit(THREAD_CONTEXT);

    // A column list built at runtime cannot be parsed by the typed client.
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    return rows
      .reverse() // oldest first: a conversation only reads forwards
      .map((row) => {
        const text = readStoredText(row as Parameters<typeof readStoredText>[0]).body
          ?? (row.snippet as string | null)
          ?? '';
        return {
          from: (row.from_addr as string | null) ?? 'unknown',
          date: ((row.received_at as string | null) ?? '').slice(0, 10) || 'undated',
          text: text.trim().slice(0, THREAD_CHARS),
        };
      })
      .filter((m) => m.text.length > 0);
  } catch (err) {
    console.error('[tasks] thread context unreadable:', (err as Error).message);
    return [];
  }
}

function senderName(from: string | null): string {
  const raw = (from ?? '').trim();
  const name = raw.replace(/<[^>]*>/, '').replace(/["']/g, '').trim();
  return name || raw.replace(/[<>]/g, '') || 'an unknown sender';
}

/**
 * Close the tasks the model says this email finished.
 *
 * Only refs it was shown, only with evidence, and only while the task is
 * still live — a person may have closed or reopened it while the email was
 * being read. Each close is logged with the words that justified it, and
 * the note on the task (migration 0015) says the same on the board.
 * Returns the ids closed.
 */
async function closeFinished(
  orgId: string,
  email: EmailFacts,
  closable: ClosableTask[],
  completes: TaskExtraction['completes'],
): Promise<string[]> {
  if (!supabaseAdmin || !closable.length || !Array.isArray(completes)) return [];

  const byRef = new Map(closable.map((c) => [c.ref, c.task]));
  const withNote = await hasTaskCompletion();
  const day = (email.received_at ?? new Date().toISOString()).slice(0, 10);
  const closed: string[] = [];

  for (const c of completes) {
    const task = byRef.get(String(c?.ref ?? '').trim().toUpperCase());
    const evidence = String(c?.evidence ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    // No proof, no close: an invented ref or an empty reason is not an answer.
    if (!task || !evidence || closed.includes(task.id)) continue;

    const patch: Record<string, unknown> = { status: 'done' };
    if (withNote) {
      patch.completion_note =
        `Closed automatically — "${email.subject?.trim() || '(no subject)'}" from ${senderName(email.from_addr)}, ${day}: "${evidence}"`;
    }
    const { data } = await supabaseAdmin
      .from('tasks')
      .update(patch)
      .eq('id', task.id)
      .eq('org_id', orgId)
      .in('status', LIVE_STATUSES)
      .select('id');
    if (!data?.length) continue;
    closed.push(task.id);

    await supabaseAdmin.from('activity_log').insert({
      org_id: orgId,
      action: 'task.auto_complete',
      entity: 'tasks',
      entity_id: task.id,
      meta: {
        title: task.title,
        email_id: email.id,
        evidence,
        due_date: task.due_date,
        // What the studio asked for: whether finished work was early.
        finished: !task.due_date ? null : day < task.due_date ? 'early' : day === task.due_date ? 'on_time' : 'late',
      },
    });
  }
  return closed;
}

/**
 * Raise tasks from email already in the system.
 *
 * Bounded by a clock, because a person is watching: it used to read every
 * taskless email in one request, one Claude call apiece, which on a
 * studio's inbox ran two or three minutes behind a button that said
 * "Reading email…" — and on the host, where a request dies at 60s, would
 * never have finished at all. Now it stops starting new emails once the
 * budget is spent and says how many are left, so each press answers in
 * seconds and the next press carries on where it stopped.
 */
export async function backfillTasks(
  orgId: string,
  opts: { limit?: number; budgetMs?: number } = {},
): Promise<{ ok: boolean; reason?: string; scanned: number; created: number; remaining: number }> {
  const limit = opts.limit ?? 50;
  const deadline = Date.now() + (opts.budgetMs ?? Number.POSITIVE_INFINITY);
  if (!supabaseAdmin) return { ok: false, reason: 'supabase_not_configured', scanned: 0, created: 0, remaining: 0 };

  const { data: existing, error: exErr } = await supabaseAdmin
    .from('tasks')
    .select('source_email_id')
    .eq('org_id', orgId)
    .not('source_email_id', 'is', null);
  if (exErr) return { ok: false, reason: exErr.message, scanned: 0, created: 0, remaining: 0 };
  const done = new Set((existing ?? []).map((r) => (r as { source_email_id: string }).source_email_id));

  // The body has its own column once migration 0010 is in; before that it
  // lives inside extracted_json, which readStoredText unpacks either way.
  const withBody = await bodyColumnsReady();
  const { data: emails, error } = await supabaseAdmin
    .from('emails')
    .select(`id, class, subject, from_addr, to_addr, snippet, extracted_json${withBody ? ', body_text' : ''}`)
    .eq('org_id', orgId)
    .not('class', 'in', `(${IGNORED_CLASSES.map((c) => `"${c}"`).join(',')})`)
    .order('received_at', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) return { ok: false, reason: error.message, scanned: 0, created: 0, remaining: 0 };

  type Row = {
    id: string; class: string; subject: string | null;
    from_addr: string | null; to_addr: string | null; snippet: string | null;
    body_text?: string | null;
    extracted_json: ({ summary?: string } & Record<string, unknown>) | null;
  };
  // Only what has never been asked: no task yet, and no "no" on record.
  const todo = ((emails ?? []) as unknown as Row[]).filter(
    (e) => !done.has(e.id) && !e.extracted_json?.[TASK_CHECKED_KEY],
  );

  let scanned = 0;
  let created = 0;
  let remaining = todo.length;
  for (const e of todo) {
    if (Date.now() > deadline) break;
    remaining--;
    scanned++;
    try {
      // The email as it was sent, where the studio has kept it — the same
      // text the reading pass decided on. The summary and snippet are the
      // fallback for mail stored before bodies were kept at all.
      const stored = readStoredText(e).body;
      const body = stored || [e.extracted_json?.summary, e.snippet].filter(Boolean).join('\n\n');
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
  return { ok: true, scanned, created, remaining };
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
    .select('project_id, vendor_id, thread_id, received_at, subject, from_addr, projects(name, client_name), vendors(name)')
    .eq('id', emailId)
    .maybeSingle();
  const filed = email as {
    projects?: { name: string; client_name: string | null } | null;
    vendors?: { name: string } | null;
  } | null;
  const filedUnder = filed?.projects ?? null;

  // The open work this email might be the answer to, read from the stored
  // row rather than `parsed` — a backfill passes no thread id.
  const facts = { id: emailId, ...(email as Omit<EmailFacts, 'id'> | null) } as EmailFacts;
  const closable = email ? await loadClosable(orgId, facts) : [];

  const names = await loadStudioNames(orgId);
  // The conversation, not just the message: see loadThreadContext.
  const thread = await loadThreadContext(
    orgId,
    (email as { thread_id: string | null } | null)?.thread_id ?? parsed.threadId ?? null,
    emailId,
  );
  const extracted = await extractTask(parsed, { orgId }, {
    project: filedUnder?.name ?? null,
    client: filedUnder?.client_name ?? null,
    vendor: filed?.vendors?.name ?? null,
    names,
    openTasks: closable.map(({ ref, line }) => ({ ref, line })),
    thread,
  });
  // Unusable JSON is not an answer — leave it to be asked again.
  if (!extracted) return false;

  // Before the needs_task gate: the email that finishes work usually raises
  // none of its own.
  try {
    await closeFinished(orgId, facts, closable, extracted.completes);
  } catch (err) {
    console.error('[tasks] closing finished tasks failed:', (err as Error).message);
  }

  if (!extracted.needs_task) {
    await markTaskChecked(emailId);
    return false;
  }

  const title = String(extracted.title ?? '').trim().slice(0, 200);
  if (!title) return false;

  // The supplier the work is about: the email's own, else the one the task
  // names, when the studio has it on file. Most studio mail about a supplier
  // is not a quote, so the email itself often has no vendor.
  const vendorId =
    (email as { vendor_id: string | null } | null)?.vendor_id ??
    (extracted.vendor ? matchProjectId(names.vendors, extracted.vendor) : null);

  // Who to reach, so whoever picks the task up does not have to open the
  // thread to find out. Never a studio address or a no-reply sender.
  const contactEmail = extracted.contact_email?.trim() || null;
  const contact =
    contactEmail && contactEmail.includes('@') && !isStudioAddress(contactEmail) && !isAutomatedAddress(contactEmail)
      ? `${extracted.contact_name?.trim() ? `${extracted.contact_name.trim()} ` : ''}<${contactEmail}>`
      : null;
  const detail = [extracted.detail?.trim() || null, contact ? `Contact: ${contact}` : null].filter(Boolean).join('\n\n') || null;

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
    (await resolveFromChain(orgId, parsed)) ??
    (await resolveBySeat(orgId, seat)) ??
    (await resolveAssignee(orgId, role)) ??
    (await resolveTriage(orgId));

  const { error } = await supabaseAdmin.from('tasks').insert({
    org_id: orgId,
    title,
    detail,
    kind,
    assigned_to: assignedTo,
    assigned_role: seat ? SEATS[seat].role : role,
    seat,
    next_step: extracted.next_step ?? null,
    project_id: (email as { project_id: string | null } | null)?.project_id ?? null,
    vendor_id: vendorId,
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
