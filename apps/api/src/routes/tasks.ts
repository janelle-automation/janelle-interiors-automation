import { Router } from 'express';
import { TASK_KINDS, TASK_STATUSES, canSupervise } from '@janelle/shared';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';

export const tasksRouter = Router();
tasksRouter.use(requireAuth);

// List tasks, newest first, with the names needed to render a row.
tasksRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from('tasks')
      .select(
        'id, title, detail, kind, status, assigned_to, assigned_role, project_id, vendor_id, source_email_id, due_date, created_at, projects(name), vendors(name), profiles(full_name)',
      )
      .order('created_at', { ascending: false });
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

    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'No fields to update' });

    // Anyone may work their own queue; handing work to someone else — or
    // taking it off them — is a supervisor's call. Claiming an unassigned
    // task for yourself stays open to everyone, which is how gaps get filled.
    if (!canSupervise(req.auth!.role)) {
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
        return res.status(403).json({ error: 'Only a principal or coordinator can assign work to others' });
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
