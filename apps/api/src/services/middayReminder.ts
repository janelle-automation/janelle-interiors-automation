import { TASK_CATEGORIES, TASK_CATEGORY_LABELS, defaultTaskCategory, type TaskCategory } from '@janelle/shared';
import { hasTaskCategory, hasTaskCompletion } from '../lib/columns.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { orgSourceUserId } from '../lib/tokens.js';
import { isStudioMailbox } from '../lib/studioTeam.js';
import { pacificDate, pacificDayStart, pacificHourNow } from '../lib/pacificTime.js';
import { gmailFor, sendMessage } from './gmail.js';
import {
  middayOwnerEmail,
  middayPersonalEmail,
  type MiddayGroup,
  type MiddayTaskRow,
  type ReminderSlot,
} from './emailTemplate.js';
import { env } from '../env.js';

export type { ReminderSlot };

/** Statuses that mean the work is still outstanding. */
const LIVE_STATUSES = ['open', 'in_progress', 'blocked'];

/**
 * Which of the day's two emails this moment calls for: the morning plan up to
 * early afternoon, the evening wrap-up after it. The scheduler only fires at 9am
 * and 5pm Pacific, so for a real send this is exact; for a manual "send now" it
 * picks whichever is nearer.
 */
export function reminderSlotNow(): ReminderSlot {
  return pacificHourNow() < 13 ? 'morning' : 'evening';
}

export interface Task {
  title: string;
  due_date: string | null;
  status: string;
  project: string | null;
  category: TaskCategory;
  /** Finished today — only ever true in the evening wrap-up. */
  done: boolean;
  assignedTo: string | null;
  assigneeName: string | null;
  assigneeEmail: string | null;
}

/** "2026-09-17" → "Sep 17": the date as a person says it. */
function shortDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** The two dates the emails are about, in the studio's own calendar. */
export interface Window {
  today: string;
  tomorrow: string;
}

/**
 * What goes in each email.
 *
 *   morning  Not finished, and due today or before. Everything due later is
 *            left to its own day — a reminder is not an inventory, and the full
 *            list is on the task board every email links to.
 *   evening  What was finished today, what is still pending from today and
 *            earlier, and what is due tomorrow. The first two say how the day
 *            went; the last starts tomorrow's list tonight.
 *
 * A task with no date appears in neither: with no date there is nothing to
 * remind anyone of.
 */
export function belongsIn(t: Task, slot: ReminderSlot, w: Window): boolean {
  if (slot === 'morning') return !t.done && t.due_date !== null && t.due_date <= w.today;
  return t.done || (t.due_date !== null && t.due_date <= w.tomorrow);
}

/** One task, phrased for the time of day it is read — what the email template renders. */
function toRow(t: Task, w: Window, slot: ReminderSlot): MiddayTaskRow {
  const base = {
    title: t.title,
    project: t.project,
    category: TASK_CATEGORY_LABELS[t.category],
    blocked: t.status === 'blocked',
  };
  if (t.done) return { ...base, dueText: 'completed today', tone: 'good', blocked: false };

  const due = t.due_date as string;
  const late = slot === 'morning' ? 'overdue' : 'still pending';
  if (due < w.today) return { ...base, dueText: `${late}, was due ${shortDate(due)}`, tone: 'crit' };
  if (due === w.today) return { ...base, dueText: slot === 'morning' ? 'due today' : 'still pending, due today', tone: 'warn' };
  return { ...base, dueText: 'due tomorrow', tone: 'neutral' };
}

/**
 * One task list, grouped by what kind of work it is.
 *
 * Design, FF&E, Procurement & shipping and Admin & operations are separate
 * jobs, often with separate people behind them, so the email reads as four
 * short lists instead of one long one. Inside each, the work still to do comes
 * first — the oldest overdue at the top — then tomorrow's, then, in the
 * evening, what was finished.
 */
export function toGroups(rows: Task[], w: Window, slot: ReminderSlot): MiddayGroup[] {
  const rank = (t: Task) => (t.done ? 2 : (t.due_date as string) > w.today ? 1 : 0);
  return TASK_CATEGORIES.map((category) => ({
    label: TASK_CATEGORY_LABELS[category].toUpperCase(),
    rows: rows
      .filter((t) => t.category === category)
      .sort(
        (a, b) =>
          rank(a) - rank(b) || (a.due_date ?? '').localeCompare(b.due_date ?? '') || a.title.localeCompare(b.title),
      )
      .map((t) => toRow(t, w, slot)),
  }));
}

export interface MiddayReminderResult {
  ok: boolean;
  reason?: string;
  slot: ReminderSlot;
  /** Personal reminders composed, one per teammate with something to be told. */
  personal: number;
  ownerSent: boolean;
}

/**
 * Send the day's task email: one per teammate naming their own tasks, and one
 * to the owner breaking down the whole studio by person. At 9am it is the plan
 * for the day; at 5pm it is the wrap-up (see ops.ts / scheduler.ts).
 *
 * Real sends, not drafts — the one deliberate exception besides account
 * invitations (see sendMessage). Each teammate and the owner get their own
 * email at their own address.
 */
export async function runMiddayReminder(orgId: string, slot: ReminderSlot = reminderSlotNow()): Promise<MiddayReminderResult> {
  if (!supabaseAdmin) return { ok: false, reason: 'supabase_not_configured', slot, personal: 0, ownerSent: false };

  // Category and completion time exist only once migrations 0026 and 0015 are
  // applied; until then category is worked out from the kind and the seat, and
  // "finished today" falls back to when the task last changed.
  const [categorised, completion] = await Promise.all([hasTaskCategory(), hasTaskCompletion()]);
  const columns = `title, due_date, status, assigned_to, kind, seat${categorised ? ', category' : ''}, projects(name), profiles(full_name, email)`;

  type Raw = {
    title: string; due_date: string | null; status: string; assigned_to: string | null;
    kind: Parameters<typeof defaultTaskCategory>[0]; seat: string | null; category?: TaskCategory | null;
    projects: { name: string } | null;
    profiles: { full_name: string | null; email: string | null } | null;
  };
  const shape = (rows: unknown, done: boolean): Task[] =>
    ((rows ?? []) as Raw[]).map((t) => ({
      title: t.title,
      due_date: t.due_date,
      status: t.status,
      done,
      category: t.category ?? defaultTaskCategory(t.kind, t.seat),
      project: t.projects?.name ?? null,
      assignedTo: t.assigned_to,
      assigneeName: t.profiles?.full_name ?? null,
      assigneeEmail: t.profiles?.email ?? null,
    }));

  const { data: live } = await supabaseAdmin.from('tasks').select(columns).eq('org_id', orgId).in('status', LIVE_STATUSES);
  let tasks = shape(live, false);

  if (slot === 'evening') {
    const { data: finished } = await supabaseAdmin
      .from('tasks')
      .select(columns)
      .eq('org_id', orgId)
      .eq('status', 'done')
      .gte(completion ? 'completed_at' : 'updated_at', pacificDayStart().toISOString());
    tasks = [...tasks, ...shape(finished, true)];
  }

  // A reminder with nothing to say teaches people to stop reading it, same
  // reasoning as the in-app popup's silence.
  const window: Window = { today: pacificDate(0), tomorrow: pacificDate(1) };
  const relevant = tasks.filter((t) => belongsIn(t, slot, window));
  if (!relevant.length) return { ok: true, slot, personal: 0, ownerSent: false };

  const sender = await orgSourceUserId(orgId);
  const gmail = sender ? await gmailFor(sender) : null;
  if (!gmail) return { ok: false, reason: 'no_source_mailbox', slot, personal: 0, ownerSent: false };

  const appUrl = (env.appUrl ?? '').replace(/\/+$/, '');
  const boardUrl = appUrl ? `${appUrl}/tasks` : undefined;

  // One group per teammate who owns any of it. A shared mailbox is not a
  // person to remind, same rule as everywhere else tasks are assigned.
  const byPerson = new Map<string, { name: string; email: string | null; rows: Task[] }>();
  for (const t of relevant) {
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
    const mail = middayPersonalEmail({ name, slot, groups: toGroups(rows, window, slot), boardUrl });
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
    const unassigned = relevant.filter((t) => !t.assignedTo);
    const people = [...byPerson.values()]
      .sort((a, b) => b.rows.length - a.rows.length)
      .map((p) => ({ name: p.name, groups: toGroups(p.rows, window, slot) }));
    const unassignedGroups = toGroups(unassigned, window, slot);

    for (const owner of owners) {
      const mail = middayOwnerEmail({
        name: owner.full_name as string,
        slot,
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
    meta: {
      slot,
      personal,
      owner_sent: ownerSent,
      included: relevant.length,
      completed: relevant.filter((t) => t.done).length,
    },
  });

  return { ok: true, slot, personal, ownerSent };
}
