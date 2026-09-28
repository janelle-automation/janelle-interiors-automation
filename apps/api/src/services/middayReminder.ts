import { supabaseAdmin } from '../lib/supabase.js';
import { orgSourceUserId } from '../lib/tokens.js';
import { isStudioMailbox, STUDIO_MAILBOXES } from '../lib/studioTeam.js';
import { gmailFor, sendMessage } from './gmail.js';
import { middayOwnerEmail, middayPersonalEmail, type MiddayGroup, type MiddayTaskRow } from './emailTemplate.js';
import { env } from '../env.js';

/** Statuses that mean the work is still outstanding. */
const LIVE_STATUSES = ['open', 'in_progress', 'blocked'];

/**
 * Every recipient, for both the personal reminders and the owner's summary,
 * is this one address rather than the real person while the studio checks
 * the content is right. The person each message is actually about is still
 * named in the subject, so nothing here needs to change to start sending to
 * real addresses later — only this constant.
 */
const TEST_RECIPIENT = STUDIO_MAILBOXES[0];

interface Task {
  title: string;
  due_date: string | null;
  status: string;
  project: string | null;
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

export interface MiddayReminderResult {
  ok: boolean;
  reason?: string;
  /** Personal reminders composed, one per teammate with live work. */
  personal: number;
  ownerSent: boolean;
}

/**
 * Send the midday task reminder: one email per teammate naming their own
 * open work, and one to the owner breaking down the whole studio's open
 * work by person.
 *
 * Real sends, not drafts — the one deliberate exception besides account
 * invitations (see sendMessage). Every recipient is the studio's own
 * systems@ mailbox for now (TEST_RECIPIENT); see its comment.
 */
export async function runMiddayReminder(orgId: string): Promise<MiddayReminderResult> {
  if (!supabaseAdmin) return { ok: false, reason: 'supabase_not_configured', personal: 0, ownerSent: false };

  const { data } = await supabaseAdmin
    .from('tasks')
    .select('title, due_date, status, assigned_to, projects(name), profiles(full_name, email)')
    .eq('org_id', orgId)
    .in('status', LIVE_STATUSES);

  type Raw = {
    title: string; due_date: string | null; status: string; assigned_to: string | null;
    projects: { name: string } | null;
    profiles: { full_name: string | null; email: string | null } | null;
  };
  const tasks = ((data ?? []) as unknown as Raw[]).map((t) => ({
    title: t.title,
    due_date: t.due_date,
    status: t.status,
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
  const appUrl = (env.appUrl ?? '').replace(/\/+$/, '');
  const boardUrl = appUrl ? `${appUrl}/tasks` : undefined;

  // One group per teammate who owns live work. A shared mailbox is not a
  // person to remind, same rule as everywhere else tasks are assigned.
  const byPerson = new Map<string, { name: string; rows: Task[] }>();
  for (const t of tasks) {
    if (!t.assignedTo || !t.assigneeName || isStudioMailbox(t.assigneeEmail)) continue;
    const entry = byPerson.get(t.assignedTo) ?? { name: t.assigneeName, rows: [] };
    entry.rows.push(t);
    byPerson.set(t.assignedTo, entry);
  }

  let personal = 0;
  for (const { name, rows } of byPerson.values()) {
    const mail = middayPersonalEmail({ name, groups: toGroups(rows, today), boardUrl });
    try {
      await sendMessage(gmail, {
        to: TEST_RECIPIENT,
        subject: `[Test send, meant for ${name}] ${mail.subject}`,
        body: mail.text,
        html: mail.html,
      });
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
    (p) => p.full_name && !isStudioMailbox(p.email),
  );

  let ownerSent = false;
  if (owners.length) {
    const unassigned = tasks.filter((t) => !t.assignedTo);
    const people = [...byPerson.values()]
      .sort((a, b) => b.rows.length - a.rows.length)
      .map((p) => ({ name: p.name, groups: toGroups(p.rows, today) }));
    const unassignedGroups = toGroups(unassigned, today);

    for (const owner of owners) {
      const mail = middayOwnerEmail({
        name: owner.full_name as string,
        people,
        unassigned: unassignedGroups,
        boardUrl,
      });
      try {
        await sendMessage(gmail, {
          to: TEST_RECIPIENT,
          subject: `[Test send, meant for ${owner.full_name}] ${mail.subject}`,
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
    meta: { personal, owner_sent: ownerSent, open_tasks: tasks.length, test_recipient: TEST_RECIPIENT },
  });

  return { ok: true, personal, ownerSent };
}
