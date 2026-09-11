import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { runDigest } from '../services/digest.js';

export const digestsRouter = Router();
digestsRouter.use(requireAuth);

// Today's digest (or the most recent one, so the page is never blank).
digestsRouter.get(
  '/latest',
  asyncHandler(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from('digests')
      .select('id, digest_date, figures, narrative, escalations, created_at')
      .order('digest_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ data });
  }),
);

// Recent digests, newest first.
digestsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from('digests')
      .select('id, digest_date, narrative, escalations, created_at')
      .order('digest_date', { ascending: false })
      .limit(30);
    if (error) throw new Error(error.message);
    res.json({ data });
  }),
);

// Build today's digest now (principal / coordinator only).
digestsRouter.post(
  '/run',
  requireRole('principal', 'coordinator'),
  asyncHandler(async (req, res) => {
    if (!req.auth!.orgId) return res.status(400).json({ error: 'No organization for user' });
    const result = await runDigest(req.auth!.orgId);
    res.json({ data: result });
  }),
);
