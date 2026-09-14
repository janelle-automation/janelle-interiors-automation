import { Router } from 'express';
import {
  PROJECT_STAGES,
  ROLE_DASHBOARD,
  SEATS,
  SEAT_KEYS,
  type DashboardCardKey,
  type DashboardSummary,
  type Seat,
} from '@janelle/shared';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

/** Statuses that still need someone to do something. */
const LIVE = ['open', 'in_progress', 'blocked'];

/**
 * One figure per card, then the role decides which of them to show.
 *
 * Everything is computed for everyone — the numbers are cheap, they come
 * from the same handful of queries, and a shared truth is easier to reason
 * about than five different endpoints. What changes per role is which
 * figures are surfaced and in what order (ROLE_DASHBOARD, in shared,
 * derived from the studio's roles document).
 */
dashboardRouter.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const { db, userId, role } = req.auth!;
    const today = new Date().toISOString().slice(0, 10);

    const [projects, pos, followUps, gaps, emails, documents, drafts, tasks, profiles] =
      await Promise.all([
        db.from('projects').select('id, stage, status'),
        db.from('purchase_orders').select('id, status'),
        db.from('follow_ups').select('id, type, status').in('status', ['open', 'drafted']),
        db.from('spec_gaps').select('id').eq('resolved', false),
        db.from('emails').select('*', { count: 'exact', head: true }),
        db.from('documents').select('*', { count: 'exact', head: true }),
        db.from('drafts').select('*', { count: 'exact', head: true }),
        db
          .from('tasks')
          .select('id, status, assigned_to, due_date, next_step')
          .in('status', LIVE),
        db.from('profiles').select('full_name'),
      ]);

    const projectRows = (projects.data ?? []) as { stage: string; status: string }[];
    const taskRows = (tasks.data ?? []) as {
      assigned_to: string | null;
      due_date: string | null;
      next_step: string | null;
    }[];
    const followUpRows = (followUps.data ?? []) as { type: string }[];

    const byStage = Object.fromEntries(PROJECT_STAGES.map((s) => [s, 0])) as Record<
      string,
      number
    >;
    for (const p of projectRows) byStage[p.stage]++;

    const mine = taskRows.filter((t) => t.assigned_to === userId);

    const figures: Record<DashboardCardKey, number> = {
      myOpenTasks: mine.length,
      myOverdueTasks: mine.filter((t) => t.due_date && t.due_date < today).length,
      unassignedTasks: taskRows.filter((t) => !t.assigned_to).length,
      // The studio's Tasks SOP says every task names its next action. One
      // without it is the thing the PM-support seat exists to chase.
      tasksWithoutNextStep: taskRows.filter((t) => !t.next_step?.trim()).length,
      openFollowUps: followUpRows.length,
      awaitingClient: followUpRows.filter((f) => f.type === 'client_approval_overdue').length,
      draftsPending: drafts.count ?? 0,
      specGaps: (gaps.data ?? []).length,
      openPOs: ((pos.data ?? []) as { status: string }[]).filter(
        (o) => !['received', 'cancelled'].includes(o.status),
      ).length,
      activeProjects: projectRows.filter((p) => p.status === 'active').length,
      installsSoon: projectRows.filter((p) => ['shipping', 'install'].includes(p.stage)).length,
      emailsRead: emails.count ?? 0,
      documentsParsed: documents.count ?? 0,
      escalations: followUpRows.filter((f) => f.type === 'task_escalation').length,
    };

    // A seat with nobody in it silently swallows work: resolveBySeat falls
    // back to the role, and if that role is empty too the task lands
    // unassigned. Worth saying out loud on the dashboard.
    const names = new Set(
      ((profiles.data ?? []) as { full_name: string | null }[])
        .map((p) => p.full_name?.toLowerCase().trim())
        .filter((n): n is string => !!n),
    );
    const vacantSeats = SEAT_KEYS.filter((seat) => {
      const person = SEATS[seat].person;
      if (!person) return true; // the document's own vacancy, the COO
      // "Brianna / Amanda" share a seat — either name fills it.
      return !person
        .split('/')
        .map((p) => p.trim().toLowerCase())
        .some((p) => [...names].some((n) => n === p || n.startsWith(`${p} `)));
    }).map((seat: Seat) => ({
      seat,
      label: SEATS[seat].label,
      role: SEATS[seat].role,
    }));

    const view = role ? ROLE_DASHBOARD[role] : null;

    const summary: DashboardSummary = {
      role,
      focus: view?.focus ?? 'Your studio at a glance.',
      cards: view?.cards ?? (['activeProjects', 'openPOs', 'openFollowUps'] as DashboardCardKey[]),
      figures,
      byStage,
      vacantSeats,
    };

    res.json({ data: summary });
  }),
);
