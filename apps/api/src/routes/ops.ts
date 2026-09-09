import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { runIngest } from '../services/ingest.js';
import { promoteAll } from '../services/promote.js';

export const opsRouter = Router();
opsRouter.use(requireAuth);

// Backfill: promote existing parsed emails + documents into vendors,
// projects and purchase orders (principal / coordinator only).
opsRouter.post(
  '/promote',
  requireRole('principal', 'coordinator'),
  asyncHandler(async (req, res) => {
    if (!req.auth!.orgId) return res.status(400).json({ error: 'No organization for user' });
    const result = await promoteAll(req.auth!.orgId);
    res.json({ data: result });
  }),
);

// Manually trigger an ingestion pass (principal / coordinator only).
opsRouter.post(
  '/ingest',
  requireRole('principal', 'coordinator'),
  asyncHandler(async (req, res) => {
    if (!req.auth!.orgId) return res.status(400).json({ error: 'No organization for user' });
    const result = await runIngest(req.auth!.orgId, {
      emailQuery: typeof req.body?.emailQuery === 'string' ? req.body.emailQuery : undefined,
      folderId: typeof req.body?.folderId === 'string' ? req.body.folderId : undefined,
    });
    res.json({ data: result });
  }),
);
