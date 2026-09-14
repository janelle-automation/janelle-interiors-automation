import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { PROJECT_STAGES } from '@janelle/shared';

export const projectsRouter = Router();

projectsRouter.use(requireAuth);

// Update editable fields of a project (client, budget, dates, stage…).
projectsRouter.patch(
  '/:id',
  requirePermission('projects', 'update'),
  asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const patch: Record<string, unknown> = {};

    if ('client_name' in b) patch.client_name = b.client_name ? String(b.client_name) : null;
    if ('notes' in b) patch.notes = b.notes ? String(b.notes) : null;
    if ('budget' in b) {
      const n = Number(b.budget);
      patch.budget = b.budget === '' || b.budget == null || Number.isNaN(n) ? null : n;
    }
    if ('target_install' in b) patch.target_install = b.target_install || null;
    if ('start_date' in b) patch.start_date = b.start_date || null;
    if ('stage' in b) {
      if (!PROJECT_STAGES.includes(b.stage)) return res.status(400).json({ error: 'Invalid stage' });
      patch.stage = b.stage;
    }
    if ('status' in b) patch.status = String(b.status);

    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'No fields to update' });

    const { data, error } = await req.auth!.db
      .from('projects')
      .update(patch)
      .eq('id', req.params.id)
      .select('*')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: 'Project not found' });
    res.json({ data });
  }),
);

// List projects (RLS limits to the caller's org).
projectsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { db } = req.auth!;

    // The list needs the same PO figures the detail page shows, or a project
    // with a live order reads as empty. Aggregated here rather than per-row
    // in the client, which would be one request per project.
    const [projectsRes, posRes, gapsRes] = await Promise.all([
      db
        .from('projects')
        .select('id, name, client_name, stage, status, budget, target_install, assigned_to, updated_at')
        .order('updated_at', { ascending: false }),
      db.from('purchase_orders').select('project_id, amount, status'),
      db.from('spec_gaps').select('project_id').eq('resolved', false),
    ]);

    if (projectsRes.error) throw new Error(projectsRes.error.message);
    if (posRes.error) throw new Error(posRes.error.message);

    type Po = { project_id: string | null; amount: number | null; status: string };
    const CLOSED = ['received', 'cancelled'];

    const openPos = new Map<string, number>();
    const committed = new Map<string, number>();
    for (const row of (posRes.data ?? []) as Po[]) {
      if (!row.project_id) continue;
      committed.set(row.project_id, (committed.get(row.project_id) ?? 0) + Number(row.amount ?? 0));
      if (!CLOSED.includes(row.status)) {
        openPos.set(row.project_id, (openPos.get(row.project_id) ?? 0) + 1);
      }
    }

    const gaps = new Map<string, number>();
    for (const row of (gapsRes.data ?? []) as { project_id: string | null }[]) {
      if (row.project_id) gaps.set(row.project_id, (gaps.get(row.project_id) ?? 0) + 1);
    }

    const data = (projectsRes.data ?? []).map((p) => {
      const row = p as { id: string };
      return {
        ...p,
        open_pos: openPos.get(row.id) ?? 0,
        /** Total value of every PO on the project, open or not. */
        po_total: committed.get(row.id) ?? 0,
        spec_gaps: gaps.get(row.id) ?? 0,
      };
    });

    res.json({ data });
  }),
);

// One project with its POs and spec gaps.
projectsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { db } = req.auth!;
    const id = req.params.id;

    const [{ data: project }, { data: pos }, { data: gaps }, { data: emails }, { data: documents }] = await Promise.all([
      db.from('projects').select('*').eq('id', id).maybeSingle(),
      db.from('purchase_orders').select('*').eq('project_id', id),
      db.from('spec_gaps').select('*').eq('project_id', id).eq('resolved', false),
      db.from('emails').select('id, subject, class, received_at, from_addr').eq('project_id', id).order('received_at'),
      db.from('documents').select('id, type, parsed_json, created_at').eq('project_id', id).order('created_at'),
    ]);

    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json({
      data: {
        project,
        purchase_orders: pos ?? [],
        spec_gaps: gaps ?? [],
        emails: emails ?? [],
        documents: documents ?? [],
      },
    });
  }),
);
