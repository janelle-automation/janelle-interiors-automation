import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';

export const draftsRouter = Router();
draftsRouter.use(requireAuth);

// List drafts kept in the system (reply drafts, follow-up nudges, saved
// prompt output). These are reviewed in the app, not in Gmail.
draftsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from('drafts')
      .select('id, subject, body_preview, follow_up_id, created_at')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    res.json({ data });
  }),
);

// Save a draft in the system from supplied text (e.g. Prompt Studio output).
draftsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const to = String(req.body?.to ?? '').trim();
    const subject = String(req.body?.subject ?? 'Draft').trim();
    const body = String(req.body?.body ?? '').trim();
    if (!body) return res.status(400).json({ error: 'Draft body is required' });

    const composed = to ? `To: ${to}\n\n${body}` : body;
    const { data, error } = await req.auth!.db
      .from('drafts')
      .insert({ org_id: req.auth!.orgId, subject, body_preview: composed, created_by: req.auth!.userId })
      .select('id')
      .maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ data: { id: data?.id } });
  }),
);

// Edit a draft's recipients, subject and body. The body may be HTML (from the
// rich-text editor); To / Cc stay as header lines so older readers still work.
draftsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const to = String(req.body?.to ?? '').trim();
    const cc = String(req.body?.cc ?? '').trim();
    const subject = String(req.body?.subject ?? '').trim();
    const body = String(req.body?.body ?? '').trim();
    if (!body) return res.status(400).json({ error: 'Draft body is required' });

    const headers = [to ? `To: ${to}` : null, cc ? `Cc: ${cc}` : null].filter(Boolean).join('\n');
    const composed = headers ? `${headers}\n\n${body}` : body;

    const { data, error } = await req.auth!.db
      .from('drafts')
      .update({ subject: subject || 'Draft', body_preview: composed })
      .eq('id', req.params.id)
      .select('id, subject, body_preview, follow_up_id, created_at')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: 'Draft not found' });

    await req.auth!.db.from('activity_log').insert({
      org_id: req.auth!.orgId,
      actor: req.auth!.userId,
      action: 'draft.edit',
      entity: 'drafts',
      entity_id: data.id,
      meta: { subject: data.subject },
    });

    res.json({ data });
  }),
);

// Delete a draft (after sending it manually or dismissing it).
draftsRouter.delete(
  '/:id',
  requirePermission('drafts', 'delete'),
  asyncHandler(async (req, res) => {
    const { error } = await req.auth!.db.from('drafts').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ data: { ok: true } });
  }),
);
