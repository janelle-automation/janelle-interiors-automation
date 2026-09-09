import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';

export const emailsRouter = Router();
emailsRouter.use(requireAuth);

// Inbox Intelligence — the classified, linked project mail.
emailsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from('emails')
      .select('id, from_addr, subject, snippet, received_at, class, confidence, projects(name), vendors(name)')
      .order('received_at', { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    res.json({ data });
  }),
);
