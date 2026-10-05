import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';

export const emailsRouter = Router();
emailsRouter.use(requireAuth);
// Closing a module to a role has to mean something: until now nothing
// anywhere checked `read`, so revoking it would have been a switch that
// changed nothing. No view, no module — writes are still checked
// separately below.
emailsRouter.use(requirePermission('emails', 'read'));

// Inbox Intelligence — the classified, linked project mail.
// The task an email raised (at most one — uq_tasks_source_email) gives the
// Inbox its category column.
const EMAIL_COLUMNS =
  'id, from_addr, subject, snippet, received_at, class, confidence, gmail_id, extracted_json, projects(name), vendors(name), tasks(category, kind, seat)';

emailsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from('emails')
      .select(EMAIL_COLUMNS)
      .order('received_at', { ascending: false })
      // Was 50 — a studio mailbox runs to hundreds of messages, and anything
      // older than the 50 most recent was invisible to the Inbox page no
      // matter what a filter or a deep link from a task asked for.
      .limit(500);
    if (error) throw new Error(error.message);
    res.json({ data });
  }),
);

// One email, however old — for a deep link (e.g. a task's "Open in Inbox")
// to a message that has since aged out of the list above.
emailsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from('emails')
      .select(EMAIL_COLUMNS)
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: 'Email not found' });
    res.json({ data });
  }),
);
