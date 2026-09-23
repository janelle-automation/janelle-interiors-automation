import { Router } from 'express';
import { requireAuth, requireRole, requirePermission } from '../middleware/auth.js';
import { hasFollowUpSnooze } from '../lib/columns.js';
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
    const snoozeReady = await hasFollowUpSnooze();
    let q = req.auth!.db
      .from('follow_ups')
      .select(
        `id, type, project_id, vendor_id, target, reason, due_date, status, draft_id, created_at, task_id${
          snoozeReady ? ', snoozed_until, note' : ''
        }, projects(name), vendors(name), tasks(assigned_to)`,
      )
      .order('created_at', { ascending: false });

    const all = String(req.query.status ?? '') === 'all';
    if (!all) {
      q = q.in('status', ['open', 'drafted']);
      // Put down until a date: out of the queue until that date arrives, and
      // back on its own afterwards. `?status=all` still shows them, which is
      // how someone finds what they snoozed and changes their mind.
      if (snoozeReady) q = q.or(`snoozed_until.is.null,snoozed_until.lte.${new Date().toISOString()}`);
    }

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
    const patch: Record<string, unknown> = {};

    // Status and snooze are separate acts. Snoozing must NOT change the
    // status: the nudge is still open, it is simply not being asked about
    // until the date — and a status change would have taken it out of the
    // engine's dedupe, which is what would have raised a second copy of it.
    if (req.body?.status !== undefined) {
      const status = String(req.body.status);
      const allowed = ['open', 'drafted', 'sent', 'dismissed', 'done'];
      if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
      patch.status = status;
    }

    const snoozeReady = await hasFollowUpSnooze();
    if (req.body?.snoozeDays !== undefined && snoozeReady) {
      const days = Number(req.body.snoozeDays);
      if (!Number.isFinite(days) || days < 0 || days > 90) {
        return res.status(400).json({ error: 'Snooze must be between 0 and 90 days' });
      }
      // Zero wakes it now, which is how "actually, un-snooze this" is said.
      patch.snoozed_until = days === 0 ? null : new Date(Date.now() + days * 86_400_000).toISOString();
    }

    if (req.body?.note !== undefined && snoozeReady) {
      const note = String(req.body.note).trim().slice(0, 500);
      patch.note = note || null;
    }

    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to change' });

    const { data, error } = await req.auth!.db
      .from('follow_ups')
      .update(patch)
      .eq('id', req.params.id)
      .select(`id, status${snoozeReady ? ', snoozed_until, note' : ''}`)
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
