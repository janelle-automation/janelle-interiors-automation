import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { PROJECT_STAGES } from '@janelle/shared';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

dashboardRouter.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const { db } = req.auth!;

    const [projects, pos, followUps, gaps, emails, documents, drafts] = await Promise.all([
      db.from('projects').select('id, stage, status'),
      db.from('purchase_orders').select('id, status'),
      db.from('follow_ups').select('id, type, status').in('status', ['open', 'drafted']),
      db.from('spec_gaps').select('id').eq('resolved', false),
      db.from('emails').select('*', { count: 'exact', head: true }),
      db.from('documents').select('*', { count: 'exact', head: true }),
      db.from('drafts').select('*', { count: 'exact', head: true }),
    ]);

    const projectRows = projects.data ?? [];
    const byStage = Object.fromEntries(PROJECT_STAGES.map((s) => [s, 0])) as Record<string, number>;
    for (const p of projectRows) byStage[(p as { stage: string }).stage]++;

    const openPOs = (pos.data ?? []).filter(
      (o) => !['received', 'cancelled'].includes((o as { status: string }).status),
    ).length;
    const awaitingClient = (followUps.data ?? []).filter(
      (f) => (f as { type: string }).type === 'client_approval_overdue',
    ).length;
    const installsSoon = projectRows.filter((p) =>
      ['shipping', 'install'].includes((p as { stage: string }).stage),
    ).length;

    res.json({
      data: {
        activeProjects: projectRows.filter((p) => (p as { status: string }).status === 'active').length,
        openPOs,
        awaitingClient,
        specGaps: (gaps.data ?? []).length,
        installsSoon,
        openFollowUps: (followUps.data ?? []).length,
        emailsRead: emails.count ?? 0,
        documentsParsed: documents.count ?? 0,
        draftsPending: drafts.count ?? 0,
        byStage,
      },
    });
  }),
);
