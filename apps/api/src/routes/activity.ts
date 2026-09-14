import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { AI_USAGE_ACTION } from '../services/anthropic.js';

export const activityRouter = Router();
activityRouter.use(requireAuth);

// Audit log — everything the system read, extracted and drafted.
activityRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from('activity_log')
      .select('id, action, entity, meta, created_at, profiles(full_name)')
      // Every Claude call is logged here too; those belong on the AI usage
      // report, not in the studio's audit trail.
      .neq('action', AI_USAGE_ACTION)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    res.json({ data });
  }),
);
