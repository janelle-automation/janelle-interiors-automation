import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { runReport } from '../services/report.js';

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

// List past reports, newest first.
reportsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from('reports')
      .select('id, week_of, narrative, generated_json, created_at')
      .order('week_of', { ascending: false })
      .limit(12);
    if (error) throw new Error(error.message);
    res.json({ data });
  }),
);

// Generate this week's report now (principal / coordinator only).
reportsRouter.post(
  '/generate',
  requireRole('principal', 'coordinator'),
  asyncHandler(async (req, res) => {
    if (!req.auth!.orgId) return res.status(400).json({ error: 'No organization for user' });
    const result = await runReport(req.auth!.orgId);
    res.json({ data: result });
  }),
);
