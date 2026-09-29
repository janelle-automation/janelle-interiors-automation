import { supabaseAdmin } from '../lib/supabase.js';
import { orgSourceUserId } from '../lib/tokens.js';
import { isStudioMailbox } from '../lib/studioTeam.js';
import { gmailFor, sendMessage } from './gmail.js';
import { middayOwnerEmail, middayPersonalEmail, type MiddayGroup, type MiddayTaskRow } from './emailTemplate.js';
import { env } from '../env.js';

/** Statuses that mean the work is still outstanding. */
const LIVE_STATUSES = ['open', 'in_progress', 'blocked'];

/** How far back "recently updated" looks — a bit more than one send cycle (9am ↔ 5pm is 8h) so nothing sent twice a day slips through the gap. */
const RECENT_WINDOW_MS = 24 * 3600_000;

interface Task {
  title: string;
  due_date: string | null;
  status: string;
  project: string | null;
  updated_at: string;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** One task, placed in a group and phrased for reading — what the email template renders. */
function toRow(t: Task, today: string): MiddayTaskRow {
  const overdue = t.due_date !== null && t.due_date < today;
  const dueToday = t.due_date === today;
  return {
    title: t.title,
    project: t.project,
    dueText: !t.due_date
      ? 'no due date'
      : overdue
        ? `overdue, was due ${t.due_date}`
        : dueToday
          ? 'due today'
          : `due ${t.due_date}`,
    tone: overdue ? 'crit' : dueToday ? 'warn' : t.due_date ? 'neutral' : 'faint',
    blocked: t.status === 'blocked',
  };
}

/** One task list, split into the same groups the in-app reminder uses. */
function toGroups(rows: Task[], today: string): MiddayGroup[] {
  return [
    { label: 'OVERDUE', rows: rows.filter((t) => t.due_date !== null && t.due_date < today) },
    { label: 'DUE TODAY', rows: rows.filter((t) => t.due_date === today) },
    { label: 'COMING UP', rows: rows.filter((t) => t.due_date !== null && t.due_date > today) },
    { label: 'NO DUE DATE', rows: rows.filter((t) => t.due_date === null) },
  ].map((g) => ({ label: g.label, rows: g.rows.map((t) => toRow(t, today)) }));
}

/**
 * What changed since the last reminder, newest first — led with so it reads
 * as news rather than the same static list twice a day. A row here also
 * still appears in its own due-date group below; the point is to surface it,
 * not to move it.
 */
function recentGroup(rows: Task[], today: string, since: string): MiddayGroup {
  const recent = [...rows]
    .filter((t) => t.updated_at >= since)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return { label: 'RECENTLY UPDATED', rows: recent.map((t) => toRow(t, today)) };
}

function groupsWithRecent(rows: Task[], today: string, since: string): MiddayGroup[] {
  return [recentGroup(rows, today, since), ...toGroups(rows, today)];
}

export interface MiddayReminderResult {
  ok: boolean;
  reason?: string;
  /** Personal reminders composed, one per teammate with live work. */
  personal: number;
  ownerSent: boolean;
}

/**
 * Send the task reminder: one email per teammate naming their own open
 * work, and one to the owner breaking down the whole studio's open work by
 * person. Runs at 9am and 5pm Pacific (see ops.ts / scheduler.ts) — each
 * send leads with what changed since the last one, so the two a day never
 * read as the same email repeated.
 *
 * Real sends, not drafts — the one deliberate exception besides account
 * invitations (see sendMessage). Each teammate and the owner get their own
 * reminder at their own address.
 */
export async function runMiddayReminder(orgId: string): Promise<MiddayReminderResult> {
  if (!supabaseAdmin) return { ok: false, reason: 'supabase_not_configured', personal: 0, ownerSent: false };

  const { data } = await supabaseAdmin
    .from('tasks')
    .select('title, due_date, status, assigned_to, updated_at, projects(name), profiles(full_name, email)')
    .eq('org_id', orgId)
    .in('status', LIVE_STATUSES);

  type Raw = {
    title: string; due_date: string | null; status: string; assigned_to: string | null; updated_at: string;
    projects: { name: string } | null;
    profiles: { full_name: string | null; email: string | null } | null;
  };
  const tasks = ((data ?? []) as unknown as Raw[]).map((t) => ({
    title: t.title,
    due_date: t.due_date,
    status: t.status,
    updated_at: t.updated_at,
    project: t.projects?.name ?? null,
    assignedTo: t.assigned_to,
    assigneeName: t.profiles?.full_name ?? null,
    assigneeEmail: t.profiles?.email ?? null,
  }));

  // Nothing open anywhere: a reminder with nothing to say teaches people to
  // stop reading it, same reasoning as the in-app popup's silence.
  if (!tasks.length) return { ok: true, personal: 0, ownerSent: false };

  const sender = await orgSourceUserId(orgId);
  const gmail = sender ? await gmailFor(sender) : null;
  if (!gmail) return { ok: false, reason: 'no_source_mailbox', personal: 0, ownerSent: false };

  const today = todayIso();
  const since = new Date(Date.now() - RECENT_WINDOW_MS).toISOString();
  const appUrl = (env.appUrl ?? '').replace(/\/+$/, '');
  const boardUrl = appUrl ? `${appUrl}/tasks` : undefined;

  // One group per teammate who owns live work. A shared mailbox is not a
  // person to remind, same rule as everywhere else tasks are assigned.
  const byPerson = new Map<string, { name: string; email: string | null; rows: Task[] }>();
  for (const t of tasks) {
    if (!t.assignedTo || !t.assigneeName || isStudioMailbox(t.assigneeEmail)) continue;
    const entry = byPerson.get(t.assignedTo) ?? { name: t.assigneeName, email: t.assigneeEmail, rows: [] };
    entry.rows.push(t);
    byPerson.set(t.assignedTo, entry);
  }

  let personal = 0;
  for (const { name, email, rows } of byPerson.values()) {
    if (!email) {
      console.error('[midday] personal reminder skipped for', name, '(no email on file)');
      continue;
    }
    const mail = middayPersonalEmail({ name, groups: groupsWithRecent(rows, today, since), boardUrl });
    try {
      await sendMessage(gmail, { to: email, subject: mail.subject, body: mail.text, html: mail.html });
      personal++;
    } catch (err) {
      console.error('[midday] personal reminder failed for', name, (err as Error).message);
    }
  }

  // One team-wide breakdown to whoever actually holds the owner's seat —
  // never the shared mailbox, which can hold it in Team & roles by mistake
  // (see resolveSeatHolder) and is not a person who reads a reminder.
  const { data: principalRows } = await supabaseAdmin
    .from('profiles')
    .select('full_name, email')
    .eq('org_id', orgId)
    .eq('role', 'principal');
  const owners = ((principalRows ?? []) as { full_name: string | null; email: string | null }[]).filter(
    (p) => p.full_name && p.email && !isStudioMailbox(p.email),
  );

  let ownerSent = false;
  if (owners.length) {
    const unassigned = tasks.filter((t) => !t.assignedTo);
    const people = [...byPerson.values()]
      .sort((a, b) => b.rows.length - a.rows.length)
      .map((p) => ({ name: p.name, groups: groupsWithRecent(p.rows, today, since) }));
    const unassignedGroups = groupsWithRecent(unassigned, today, since);

    for (const owner of owners) {
      const mail = middayOwnerEmail({
        name: owner.full_name as string,
        people,
        unassigned: unassignedGroups,
        boardUrl,
      });
      try {
        await sendMessage(gmail, {
          to: owner.email as string,
          subject: mail.subject,
          body: mail.text,
          html: mail.html,
        });
        ownerSent = true;
      } catch (err) {
        console.error('[midday] owner summary failed:', (err as Error).message);
      }
    }
  }

  await supabaseAdmin.from('activity_log').insert({
    org_id: orgId,
    action: 'midday_reminder.sent',
    entity: 'tasks',
    meta: { personal, owner_sent: ownerSent, open_tasks: tasks.length },
  });

  return { ok: true, personal, ownerSent };
}
