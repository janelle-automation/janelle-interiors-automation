import { Router } from 'express';
import { TASK_KINDS, TASK_STATUSES, canManageTasks } from '@janelle/shared';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { hasSubtasks, hasTaskCompletion } from '../lib/columns.js';

export const tasksRouter = Router();
tasksRouter.use(requireAuth);
// Closing a module to a role has to mean something: until now nothing
// anywhere checked `read`, so revoking it would have been a switch that
// changed nothing. No view, no module — writes are still checked
// separately below.
tasksRouter.use(requirePermission('tasks', 'read'));

// When a task was finished, and the system's note when it closed it — only
// once migration 0015 has added them. `updated_at` stands in until then.
async function completionColumns(): Promise<string> {
  return (await hasTaskCompletion()) ? ', completed_at, completion_note' : '';
}

// List tasks, newest first, with the names needed to render a row.
tasksRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from('tasks')
      .select(
        `id, title, detail, kind, status, assigned_to, assigned_role, seat, next_step, project_id, vendor_id, source_email_id, due_date, created_at, updated_at${await completionColumns()}, projects(name), vendors(name), profiles(full_name)`,
      )
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    res.json({ data });
  }),
);

/**
 * Everything behind one task, for the detail panel.
 *
 * Four questions the board itself cannot answer: what the task actually
 * says, which email it came from, what has happened to it since, and what
 * it breaks down into. Assembled here rather than in four calls from the
 * browser, because opening a card should cost one round-trip.
 */
tasksRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const db = req.auth!.db;

    const subtasksReady = await hasSubtasks();
    const { data: task, error } = await db
      .from('tasks')
      .select(
        `id, title, detail, kind, status, assigned_to, assigned_role, seat, next_step,
         project_id, vendor_id, source_email_id, due_date, created_at, updated_at,
         reminded_at, reminder_count${await completionColumns()},
         projects(name), vendors(name), profiles(full_name, email)`,
      )
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const t = task as unknown as { source_email_id: string | null };

    // The email that raised it — the studio's first question about any task
    // is "where did this come from". Never the body: the snippet and the
    // summary Claude already extracted are enough to recognise the thread.
    const emailQuery = t.source_email_id
      ? db
          .from('emails')
          .select('id, subject, from_addr, to_addr, snippet, received_at, class, extracted_json')
          .eq('id', t.source_email_id)
          .maybeSingle()
      : null;

    // What has happened since: reminders and escalations raised against it.
    const historyQuery = db
      .from('follow_ups')
      .select('id, type, reason, status, created_at')
      .eq('task_id', req.params.id)
      .order('created_at', { ascending: true });

    const subtaskQuery = subtasksReady
      ? db
          .from('tasks')
          .select('id, title, status, assigned_to, due_date, created_at, profiles(full_name)')
          .eq('parent_task_id', req.params.id)
          .order('created_at', { ascending: true })
      : null;

    const [emailRes, historyRes, subtaskRes] = await Promise.all([
      emailQuery,
      historyQuery,
      subtaskQuery,
    ]);

    res.json({
      data: {
        task,
        email: emailRes?.data ?? null,
        history: historyRes.data ?? [],
        subtasks: subtaskRes?.data ?? [],
        // So the panel can say why it is not offering subtasks, rather than
        // pretending the task simply has none.
        subtasksAvailable: subtasksReady,
      },
    });
  }),
);

/**
 * Break a task into a step of its own.
 *
 * A subtask is a task: same table, same columns, same rules. It inherits
 * the parent's project and kind so it lands in the right place without
 * asking, and starts unassigned and undated because the point of writing
 * it down is usually that those are still to be decided.
 */
tasksRouter.post(
  '/:id/subtasks',
  requirePermission('tasks', 'create'),
  asyncHandler(async (req, res) => {
    if (!(await hasSubtasks())) {
      return res.status(503).json({
        error: 'Subtasks are not available yet — apply migration 0009 (npm run db:apply) first',
      });
    }

    const title = String(req.body?.title ?? '').trim();
    if (!title) return res.status(400).json({ error: 'A title is required' });

    const db = req.auth!.db;
    const { data: parent } = await db
      .from('tasks')
      .select('id, kind, project_id, vendor_id, org_id')
      .eq('id', req.params.id)
      .maybeSingle();
    if (!parent) return res.status(404).json({ error: 'Task not found' });

    const p = parent as unknown as {
      kind: string; project_id: string | null; vendor_id: string | null; org_id: string;
    };

    const { data, error } = await db
      .from('tasks')
      .insert({
        org_id: p.org_id,
        parent_task_id: req.params.id,
        title: title.slice(0, 200),
        kind: p.kind,
        project_id: p.project_id,
        vendor_id: p.vendor_id,
        assigned_to: req.body?.assigned_to ? String(req.body.assigned_to) : null,
        due_date: req.body?.due_date ? String(req.body.due_date) : null,
      })
      .select('id, title, status, assigned_to, due_date, created_at')
      .maybeSingle();
    if (error) throw new Error(error.message);

    res.json({ data });
  }),
);

// Update a task's status and/or its assignee.
tasksRouter.patch(
  '/:id',
  requirePermission('tasks', 'update'),
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const patch: Record<string, unknown> = {};

    if ('status' in b) {
      if (!TASK_STATUSES.includes(b.status)) return res.status(400).json({ error: 'Invalid status' });
      patch.status = b.status;
    }
    if ('assigned_to' in b) {
      patch.assigned_to = b.assigned_to ? String(b.assigned_to) : null;
    }
    // The SOP's other two requirements, editable where the work is looked
    // at. A task without a date cannot be chased, and one without a next
    // step fails the studio's own review — so both have to be fixable here
    // rather than only by re-reading the email that raised it.
    if ('due_date' in b) {
      const due = b.due_date ? String(b.due_date) : null;
      if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
        return res.status(400).json({ error: 'A due date must be YYYY-MM-DD' });
      }
      patch.due_date = due;
    }
    if ('next_step' in b) {
      const step = String(b.next_step ?? '').trim();
      patch.next_step = step ? step.slice(0, 500) : null;
    }

    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'No fields to update' });

    // Anyone may work their own queue; handing work to someone else — or
    // taking it off them — belongs to whoever runs the board. That is a
    // principal or coordinator by role, and also the seats the roles
    // document puts on the board: PM support owns "pushing tasks so each
    // has ONE owner", which is impossible without this. Claiming an
    // unassigned task for yourself stays open to everyone, which is how
    // gaps get filled.
    if (!canManageTasks(req.auth!.role, req.auth!.seat)) {
      const { data: current } = await req.auth!.db
        .from('tasks')
        .select('assigned_to')
        .eq('id', req.params.id)
        .maybeSingle();
      if (!current) return res.status(404).json({ error: 'Task not found' });

      const owner = (current as { assigned_to: string | null }).assigned_to;
      const me = req.auth!.userId;

      if (owner && owner !== me) {
        return res.status(403).json({ error: "You cannot change someone else's task" });
      }
      if ('assigned_to' in patch && patch.assigned_to !== me && patch.assigned_to !== null) {
        return res.status(403).json({ error: 'Only someone who runs the task board can assign work to others' });
      }
    }

    const { data, error } = await req.auth!.db
      .from('tasks')
      .update(patch)
      .eq('id', req.params.id)
      .select('id, status, assigned_to')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: 'Task not found' });
    res.json({ data });
  }),
);

// Create a task by hand, for work that never arrived as an email.
tasksRouter.post(
  '/',
  requirePermission('tasks', 'create'),
  asyncHandler(async (req, res) => {
    const title = String(req.body?.title ?? '').trim();
    if (!title) return res.status(400).json({ error: 'Title is required' });

    const kind = TASK_KINDS.includes(req.body?.kind) ? req.body.kind : 'admin';

    const { data, error } = await req.auth!.db
      .from('tasks')
      .insert({
        org_id: req.auth!.orgId,
        title: title.slice(0, 200),
        detail: req.body?.detail ? String(req.body.detail) : null,
        kind,
        assigned_to: req.body?.assigned_to ? String(req.body.assigned_to) : null,
        project_id: req.body?.project_id ? String(req.body.project_id) : null,
        due_date: req.body?.due_date || null,
      })
      .select('id')
      .maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ data: { id: data?.id } });
  }),
);

/**
 * Delete a task outright.
 *
 * The board could only ever move a task between statuses, so a card raised
 * from a misread email — or a duplicate of one already being worked — could
 * be cancelled but never removed, and sat in the list for ever. Principals
 * and coordinators hold this by default; every other role reaches it only
 * if the studio grants it on Permissions.
 *
 * Logged, because the work itself is gone afterwards and the audit trail is
 * the only remaining record that it existed.
 */
tasksRouter.delete(
  '/:id',
  requirePermission('tasks', 'delete'),
  asyncHandler(async (req, res) => {
    const { db, orgId, userId } = req.auth!;

    const { data: task } = await db
      .from('tasks')
      .select('id, title, source_email_id')
      .eq('id', req.params.id)
      .maybeSingle();
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const { error } = await db.from('tasks').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);

    await db.from('activity_log').insert({
      org_id: orgId,
      actor: userId,
      action: 'task.delete',
      entity: 'tasks',
      entity_id: (task as { id: string }).id,
      meta: {
        title: (task as { title: string }).title,
        from_email: Boolean((task as { source_email_id: string | null }).source_email_id),
      },
    });

    res.json({ data: { ok: true } });
  }),
);
