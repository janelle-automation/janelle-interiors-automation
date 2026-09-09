import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';

export const activityRouter = Router();
activityRouter.use(requireAuth);

// Audit log — everything the system read, extracted and drafted.
activityRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from('activity_log')
      .select('id, action, entity, meta, created_at, profiles(full_name)')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    res.json({ data });
  }),
);
