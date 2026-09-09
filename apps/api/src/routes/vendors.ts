import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';

export const vendorsRouter = Router();

vendorsRouter.use(requireAuth);

vendorsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from('vendors')
      .select('id, name, category, contacts, notes')
      .order('name');
    if (error) throw new Error(error.message);
    res.json({ data });
  }),
);
