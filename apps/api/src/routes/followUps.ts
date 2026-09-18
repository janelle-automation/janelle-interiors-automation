import { Router } from 'express';
import { requireAuth, requireRole, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { runFollowUps } from '../services/followups.js';

export const followUpsRouter = Router();
followUpsRouter.use(requireAuth);
// Closing a module to a role has to mean something: until now nothing
// anywhere checked `read`, so revoking it would have been a switch that
// changed nothing. No view, no module — writes are still checked
// separately below.
followUpsRouter.use(requirePermission('follow_ups', 'read'));

// The review queue, newest first, with related names.
//
// Only what is still waiting on somebody. The heading says "Awaiting your
// review" and this returned every follow-up ever raised, so a nudge marked
// done — by a person or by the engine noticing it had been answered — stayed
// on the page exactly as before. `?status=all` for the whole history.
followUpsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    let q = req.auth!.db
      .from('follow_ups')
      .select('id, type, project_id, vendor_id, target, reason, due_date, status, draft_id, created_at, projects(name), vendors(name)')
      .order('created_at', { ascending: false });
    if (String(req.query.status ?? '') !== 'all') q = q.in('status', ['open', 'drafted']);

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    res.json({ data });
  }),
);

// Update a follow-up's status (e.g. mark sent / dismissed / done).
followUpsRouter.patch(
  '/:id',
  requirePermission('follow_ups', 'update'),
  asyncHandler(async (req, res) => {
    const status = String(req.body?.status ?? '');
    const allowed = ['open', 'drafted', 'sent', 'dismissed', 'done'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const { data, error } = await req.auth!.db
      .from('follow_ups')
      .update({ status })
      .eq('id', req.params.id)
      .select('id, status')
      .maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ data });
  }),
);

// Run the follow-up engine now (principal / coordinator only).
followUpsRouter.post(
  '/run',
  requireRole('principal', 'coordinator'),
  asyncHandler(async (req, res) => {
    if (!req.auth!.orgId) return res.status(400).json({ error: 'No organization for user' });
    const result = await runFollowUps(req.auth!.orgId);
    res.json({ data: result });
  }),
);
