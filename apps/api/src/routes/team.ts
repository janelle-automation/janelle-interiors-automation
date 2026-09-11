import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';

export const teamRouter = Router();
teamRouter.use(requireAuth);

// The people in this org, for assignee pickers. RLS scopes it to the caller's org.
teamRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from('profiles')
      .select('id, full_name, email, role')
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    res.json({ data });
  }),
);
