import {
  TASK_KINDS,
  TASK_KIND_ROLE,
  canManageTasks,
  canWith,
  type PermissionOverrides,
  type Seat,
  type TaskKind,
  type UserRole,
} from '@janelle/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { addressOf, isStudioMailbox, namesFor, studioPerson } from '../lib/studioTeam.js';

/**
 * Turning something Jenny prepared into something that exists.
 *
 * Two ways in, one way through. A person presses Confirm on a proposal, or
 * says "yes" to it — typed, or aloud with their hands full — and both land
 * here, so a task saved by voice is checked, matched and recorded exactly
 * like one saved by a click.
 */

/** Who is saving, and what they are allowed to do. */
export interface Actor {
  db: SupabaseClient;
  userId: string;
  orgId: string | null;
  role: UserRole | null;
  seat?: Seat | null;
  permissions?: PermissionOverrides | null;
}

/** A refusal the person should hear in words, with the status a route would send. */
export class ProposalError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

// ── Matching what was said to who and what exists ───────────

/** Lower case, parenthesised asides dropped — "Janelle (Admin)" is Janelle. */
const clean = (s: string) =>
  s
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

export type NameMatch<T> =
  | { status: 'found'; row: T }
  | { status: 'ambiguous'; rows: T[] }
  | { status: 'none' };

/**
 * Find the one row a spoken or typed name means.
 *
 * Names arrive misheard and misspelt — voice turns "Denish" into "Danish" —
 * and the old match was a plain substring, so a near miss matched nobody and
 * the task was saved with no owner, silently. Tried from strictest to
 * loosest: the whole name, every word of it, part of it, and last a spelling
 * one or two letters out. Two equally good answers are reported as such,
 * never picked between.
 */
export function matchName<T>(said: string, rows: T[], nameOf: (row: T) => string): NameMatch<T> {
  const target = clean(said);
  if (!target) return { status: 'none' };

  const named = rows.map((row) => ({ row, name: clean(nameOf(row)) })).filter((r) => r.name);
  const decide = (hits: { row: T }[]): NameMatch<T> | null =>
    hits.length === 1 ? { status: 'found', row: hits[0].row } : hits.length > 1 ? { status: 'ambiguous', rows: hits.map((h) => h.row) } : null;

  const exact = decide(named.filter((r) => r.name === target));
  if (exact) return exact;

  // Every word said is a word of the name, or the start of one: "den" is Denish.
  const words = target.split(' ');
  const byWords = decide(
    named.filter((r) => {
      const theirs = r.name.split(' ');
      return words.every((w) => theirs.some((t) => t === w || (w.length >= 3 && t.startsWith(w))));
    }),
  );
  if (byWords) return byWords;

  const partial = decide(named.filter((r) => r.name.includes(target)));
  if (partial) return partial;

  // A spelling slip: the closest name, if it is close enough and closest alone.
  const tolerance = target.length <= 4 ? 0 : target.length <= 7 ? 1 : 2;
  if (!tolerance) return { status: 'none' };
  const scored = named
    .map((r) => ({
      row: r.row,
      distance: Math.min(editDistance(target, r.name), ...r.name.split(' ').map((t) => editDistance(target, t))),
    }))
    .filter((r) => r.distance <= tolerance)
    .sort((a, b) => a.distance - b.distance);
  if (!scored.length) return { status: 'none' };
  const best = scored.filter((s) => s.distance === scored[0].distance);
  return decide(best) ?? { status: 'none' };
}

export interface Person {
  id: string;
  full_name: string;
  email?: string | null;
}

export interface ProjectRef {
  id: string;
  name: string;
  client_name: string | null;
}

export async function teamOf(db: SupabaseClient): Promise<Person[]> {
  const { data, error } = await db.from('profiles').select('id, full_name, email');
  if (error) throw new Error(`Could not read the team: ${error.message}`);
  return ((data ?? []) as { id: string; full_name: string | null; email: string | null }[])
    .filter((p) => p.full_name)
    .map((p) => ({ id: p.id, full_name: p.full_name as string, email: p.email }));
}

/** The people on the team, with the shared mailboxes set aside. */
export function peopleOf<T extends Person>(team: T[]): T[] {
  return team.filter((p) => !isStudioMailbox(p.email));
}

/** matchName across every name each person goes by, one answer per person. */
function matchSpellings<T extends Person>(said: string, rows: T[]): NameMatch<T> {
  const spellings = rows.flatMap((row) => namesFor(row).map((name) => ({ row, name })));
  const found = matchName(said, spellings, (s) => s.name);
  if (found.status === 'none') return found;
  const distinct = found.status === 'found' ? [found.row.row] : [...new Set(found.rows.map((s) => s.row))];
  return distinct.length === 1 ? { status: 'found', row: distinct[0] } : { status: 'ambiguous', rows: distinct };
}

/**
 * The one teammate a name or an address means.
 *
 * People first, by every name they go by — "Adelaide", as the roles document
 * spells her, is Adeleigh McGee. A shared mailbox is matched only when no
 * person is: "Janelle" is Janelle Kandziora rather than the "Janelle (Admin)"
 * account on systems@, which used to make that name a tie between the two.
 */
export function matchPerson<T extends Person>(said: string, team: T[]): NameMatch<T> {
  const address = addressOf(said);
  if (address) {
    const hit = team.find((p) => p.email?.toLowerCase() === address);
    if (hit) return { status: 'found', row: hit };
    // Known to the studio by that address, with an account that never recorded it.
    // An account made with only a first name still counts, unless it is shared.
    const known = studioPerson({ email: address });
    if (!known) return { status: 'none' };
    const byName = matchSpellings(known.name, peopleOf(team));
    return byName.status !== 'none' ? byName : matchSpellings(known.name.split(' ')[0], peopleOf(team));
  }
  const person = matchSpellings(said, peopleOf(team));
  if (person.status !== 'none') return person;
  return matchSpellings(said, team.filter((p) => isStudioMailbox(p.email)));
}

export async function projectsOf(db: SupabaseClient): Promise<ProjectRef[]> {
  const { data, error } = await db.from('projects').select('id, name, client_name');
  if (error) throw new Error(`Could not read the projects: ${error.message}`);
  return (data ?? []) as ProjectRef[];
}

/** A project by its own name first, then by its client's. */
export function matchProject(said: string, projects: ProjectRef[]): NameMatch<ProjectRef> {
  const byName = matchName(said, projects, (p) => p.name);
  if (byName.status !== 'none') return byName;
  return matchName(said, projects, (p) => p.client_name ?? '');
}

/** "Fri, Sep 18" — the way a due date is said back to someone. */
export function friendlyDay(iso: string | null | undefined): string | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

// ── Saving ──────────────────────────────────────────────────

export interface SavedTask {
  kind: 'task';
  id: string;
  title: string;
  assignee: string | null;
  project: string | null;
  due_date: string | null;
  /** True when this was already saved moments ago, and that one was returned. */
  duplicate: boolean;
}

export interface SavedDraft {
  kind: 'draft';
  id: string;
  subject: string;
  to: string | null;
}

/** How the person agreed — recorded, so the audit trail shows which. */
export type ConfirmedVia = 'button' | 'conversation';

/**
 * Save a task someone agreed to.
 *
 * The owner and project are matched here again rather than trusted from the
 * proposal: the browser sends the input back, and the ids in it are only as
 * good as the browser. A name that matches nobody is refused, not saved
 * without an owner — "added for Denish" must never mean "added for no one".
 */
export async function commitTask(
  actor: Actor,
  input: Record<string, unknown>,
  via: ConfirmedVia = 'button',
): Promise<SavedTask> {
  const { db, orgId, userId, role, seat, permissions } = actor;
  if (!canWith(permissions, role, 'tasks', 'create')) {
    throw new ProposalError('Your role cannot create tasks.', 403);
  }

  const title = String(input.title ?? '').trim().slice(0, 200);
  if (!title) throw new ProposalError('A task needs a title.');
  const kind = (TASK_KINDS.includes(input.kind as TaskKind) ? input.kind : 'admin') as TaskKind;

  const dueRaw = String(input.due_date ?? '').trim();
  const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(dueRaw) ? dueRaw : null;

  let assignee: Person | null = null;
  const assigneeId = typeof input.assignee_id === 'string' ? input.assignee_id : null;
  const assigneeName = typeof input.assignee_name === 'string' ? input.assignee_name.trim() : '';
  if (assigneeId || assigneeName) {
    const team = await teamOf(db);
    const byId = assigneeId ? team.find((p) => p.id === assigneeId) : undefined;
    const matched = byId ? ({ status: 'found', row: byId } as const) : matchPerson(assigneeName, team);
    if (matched.status === 'none') throw new ProposalError(`No one called "${assigneeName}" is on the team.`);
    if (matched.status === 'ambiguous') {
      throw new ProposalError(`"${assigneeName}" could be ${matched.rows.map((p) => p.full_name).join(' or ')} — say which.`);
    }
    assignee = matched.row;
    // Running the board is what lets someone give work to others.
    if (assignee.id !== userId && !canManageTasks(role, seat ?? null)) {
      throw new ProposalError('Only someone who runs the task board can assign work to other people.', 403);
    }
  }

  // A task raised from an email carries the email: its project and vendor
  // come with it unless the person named others, and the board links back
  // to what was actually asked.
  const emailId = typeof input.email_id === 'string' && input.email_id ? input.email_id : null;
  type EmailLink = { id: string; project_id: string | null; vendor_id: string | null };
  let email: EmailLink | null = null;
  if (emailId) {
    const { data } = await db.from('emails').select('id, project_id, vendor_id').eq('id', emailId).maybeSingle();
    email = (data as EmailLink | null) ?? null;
    if (!email) throw new ProposalError('That email is no longer in the system.');
    const { data: existingForEmail } = await db
      .from('tasks')
      .select('id, title')
      .eq('source_email_id', emailId)
      .limit(1);
    const already = (existingForEmail?.[0] as { id: string; title: string } | undefined) ?? null;
    if (already) {
      throw new ProposalError(`That email already has a task: "${already.title}". Update that one instead.`, 409);
    }
  }

  let project: ProjectRef | null = null;
  const projectId = typeof input.project_id === 'string' ? input.project_id : email?.project_id ?? null;
  const projectName = typeof input.project === 'string' ? input.project.trim() : '';
  if (projectId || projectName) {
    const projects = await projectsOf(db);
    const byId = projectId ? projects.find((p) => p.id === projectId) : undefined;
    const matched = byId ? ({ status: 'found', row: byId } as const) : matchProject(projectName, projects);
    if (matched.status === 'none') throw new ProposalError(`No project matches "${projectName}".`);
    if (matched.status === 'ambiguous') {
      throw new ProposalError(`"${projectName}" could be ${matched.rows.map((p) => p.name).join(' or ')} — say which.`);
    }
    project = matched.row;
  }

  // A confirmation can arrive twice: a "yes" saved it, the answer never
  // reached the browser, and the person pressed Confirm too. The same task
  // saved in the last ten minutes is that one, not a second.
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data: recent } = await db
    .from('tasks')
    .select('id, title')
    .ilike('title', title.replace(/[%_]/g, (c) => `\\${c}`))
    .gte('created_at', since)
    .limit(1);
  const existing = (recent?.[0] as { id: string } | undefined) ?? null;
  if (existing) {
    return {
      kind: 'task', id: existing.id, title, assignee: assignee?.full_name ?? null,
      project: project?.name ?? null, due_date: dueDate, duplicate: true,
    };
  }

  const { data, error } = await db
    .from('tasks')
    .insert({
      org_id: orgId,
      title,
      detail: input.detail ? String(input.detail).slice(0, 4000) : null,
      kind,
      assigned_to: assignee?.id ?? null,
      assigned_role: TASK_KIND_ROLE[kind],
      project_id: project?.id ?? null,
      vendor_id: email?.vendor_id ?? null,
      source_email_id: email?.id ?? null,
      due_date: dueDate,
      next_step: input.next_step ? String(input.next_step).slice(0, 500) : null,
    })
    .select('id')
    .maybeSingle();
  if (error) {
    // One task per email is enforced by the database too; a race with the
    // reading pass lands here rather than as a server error.
    if (error.code === '23505') throw new ProposalError('That email already has a task. Update that one instead.', 409);
    throw new Error(error.message);
  }
  const id = (data as { id: string } | null)?.id;
  if (!id) throw new Error('The task was not saved.');

  await db.from('activity_log').insert({
    org_id: orgId,
    actor: userId,
    action: 'assistant.task_create',
    entity: 'tasks',
    entity_id: id,
    meta: { title, kind, assigned: Boolean(assignee), via },
  });

  return {
    kind: 'task', id, title, assignee: assignee?.full_name ?? null,
    project: project?.name ?? null, due_date: dueDate, duplicate: false,
  };
}

/**
 * Save a draft someone agreed to.
 *
 * Stored exactly as every other draft in the system is — To and Cc as
 * header lines above the body — so it appears in Drafts beside the reply
 * drafts and follow-up nudges, and goes out the same way: a person opens
 * it in Gmail and presses Send there.
 */
export async function commitDraft(
  actor: Actor,
  input: Record<string, unknown>,
  via: ConfirmedVia = 'button',
): Promise<SavedDraft> {
  const { db, orgId, userId, role, permissions } = actor;
  if (!canWith(permissions, role, 'drafts', 'create')) {
    throw new ProposalError('Your role cannot create drafts.', 403);
  }

  const subject = String(input.subject ?? '').trim().slice(0, 200);
  const body = String(input.body ?? '').trim().slice(0, 10_000);
  if (!subject || !body) throw new ProposalError('A draft needs a subject and a body.');

  const to = String(input.to ?? '').trim();
  const cc = String(input.cc ?? '').trim();
  const headers = [to ? `To: ${to}` : null, cc ? `Cc: ${cc}` : null].filter(Boolean).join('\n');

  const { data, error } = await db
    .from('drafts')
    .insert({ org_id: orgId, subject, body_preview: headers ? `${headers}\n\n${body}` : body, created_by: userId })
    .select('id')
    .maybeSingle();
  if (error) throw new Error(error.message);
  const id = (data as { id: string } | null)?.id;
  if (!id) throw new Error('The draft was not saved.');

  await db.from('activity_log').insert({
    org_id: orgId,
    actor: userId,
    action: 'assistant.draft_create',
    entity: 'drafts',
    entity_id: id,
    meta: { subject, to: to || null, via },
  });

  return { kind: 'draft', id, subject, to: to || null };
}

export interface SavedTaskUpdate {
  kind: 'task_update';
  id: string;
  title: string;
  assignee: string | null;
  due_date: string | null;
  status: string;
}

const STATUSES = ['open', 'in_progress', 'blocked', 'done', 'cancelled'];

/**
 * Change an existing task someone agreed to change.
 *
 * The same rules as the Tasks board, because this is the Tasks board spoken
 * to: anyone may work their own queue and claim unowned work; giving work to
 * someone else, or changing someone else's task, belongs to whoever runs the
 * board.
 */
export async function commitTaskUpdate(
  actor: Actor,
  input: Record<string, unknown>,
  via: ConfirmedVia = 'button',
): Promise<SavedTaskUpdate> {
  const { db, orgId, userId, role, seat, permissions } = actor;
  if (!canWith(permissions, role, 'tasks', 'update')) {
    throw new ProposalError('Your role cannot change tasks.', 403);
  }

  const taskId = typeof input.task_id === 'string' ? input.task_id : '';
  const { data: current } = await db
    .from('tasks')
    .select('id, title, status, assigned_to, due_date')
    .eq('id', taskId)
    .maybeSingle();
  const task = current as { id: string; title: string; status: string; assigned_to: string | null; due_date: string | null } | null;
  if (!task) throw new ProposalError('That task is no longer on the board.', 404);

  const patch: Record<string, unknown> = {};
  let assignee: Person | null = null;

  if ('assignee_id' in input || 'assignee_name' in input) {
    const team = await teamOf(db);
    const id = typeof input.assignee_id === 'string' ? input.assignee_id : null;
    const said = typeof input.assignee_name === 'string' ? input.assignee_name.trim() : '';
    const byId = id ? team.find((p) => p.id === id) : undefined;
    const matched = byId ? ({ status: 'found', row: byId } as const) : said ? matchPerson(said, team) : null;
    if (matched?.status === 'none') throw new ProposalError(`No one called "${said}" is on the team.`);
    if (matched?.status === 'ambiguous') {
      throw new ProposalError(`"${said}" could be ${matched.rows.map((p) => p.full_name).join(' or ')} — say which.`);
    }
    if (matched?.status === 'found') {
      assignee = matched.row;
      patch.assigned_to = assignee.id;
    }
  }

  if (typeof input.due_date === 'string' && input.due_date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.due_date)) throw new ProposalError('A due date must be a calendar date.');
    patch.due_date = input.due_date;
  }
  if (typeof input.status === 'string' && input.status) {
    if (!STATUSES.includes(input.status)) throw new ProposalError(`"${input.status}" is not a task status.`);
    patch.status = input.status;
  }
  if (typeof input.next_step === 'string' && input.next_step.trim()) {
    patch.next_step = input.next_step.trim().slice(0, 500);
  }
  if (!Object.keys(patch).length) throw new ProposalError('Nothing to change on that task.');

  if (!canManageTasks(role, seat ?? null)) {
    if (task.assigned_to && task.assigned_to !== userId) {
      throw new ProposalError("Only someone who runs the task board can change someone else's task.", 403);
    }
    if ('assigned_to' in patch && patch.assigned_to !== userId) {
      throw new ProposalError('Only someone who runs the task board can give work to other people.', 403);
    }
  }

  const { error } = await db.from('tasks').update(patch).eq('id', task.id);
  if (error) throw new Error(error.message);

  await db.from('activity_log').insert({
    org_id: orgId,
    actor: userId,
    action: 'assistant.task_update',
    entity: 'tasks',
    entity_id: task.id,
    meta: { title: task.title, changes: Object.keys(patch), via },
  });

  let owner = assignee?.full_name ?? null;
  if (!owner && task.assigned_to) {
    owner = (await teamOf(db)).find((p) => p.id === task.assigned_to)?.full_name ?? null;
  }
  return {
    kind: 'task_update',
    id: task.id,
    title: task.title,
    assignee: owner,
    due_date: (patch.due_date as string | undefined) ?? task.due_date,
    status: (patch.status as string | undefined) ?? task.status,
  };
}

/** Save whichever kind of proposal this is. */
export function commitProposal(
  actor: Actor,
  tool: string,
  input: Record<string, unknown>,
  via: ConfirmedVia = 'button',
): Promise<SavedTask | SavedDraft | SavedTaskUpdate> {
  if (tool === 'propose_draft') return commitDraft(actor, input, via);
  if (tool === 'propose_task') return commitTask(actor, input, via);
  if (tool === 'propose_task_update') return commitTaskUpdate(actor, input, via);
  throw new ProposalError(`Nothing knows how to save a "${tool}".`);
}
