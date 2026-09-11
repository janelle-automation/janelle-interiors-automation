import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { runIngest } from '../services/ingest.js';
import { promoteAll } from '../services/promote.js';
import { runFollowUps } from '../services/followups.js';
import { runReport } from '../services/report.js';
import { runDigest } from '../services/digest.js';
import { supabaseAdmin } from '../lib/supabase.js';

export const opsRouter = Router();

// ── Scheduled jobs ──────────────────────────────────────────
// Vercel Cron calls these; there is no long-running process to hold the
// node-cron timers that `services/scheduler.ts` uses when self-hosted.
// They authenticate with CRON_SECRET rather than a user session, so they
// are declared BEFORE `requireAuth` is applied to the rest of the router.

const cronRouter = Router();

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Denies when unset. */
cronRouter.use((req, res, next) => {
  const secret = process.env.CRON_SECRET ?? '';
  if (!secret) {
    return res.status(503).json({ error: 'CRON_SECRET is not configured on the server' });
  }
  const header = req.header('authorization') ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : String(req.query.key ?? '');
  if (given !== secret) return res.status(401).json({ error: 'Not authorised' });
  next();
});

/** Run a job for every organisation, collecting per-org results. */
async function forEachOrg<T>(fn: (orgId: string) => Promise<T>) {
  if (!supabaseAdmin) return { ok: false, reason: 'supabase_not_configured', results: [] as unknown[] };
  const { data: orgs } = await supabaseAdmin.from('organizations').select('id');
  const results: unknown[] = [];
  for (const org of orgs ?? []) {
    const orgId = (org as { id: string }).id;
    try {
      results.push({ orgId, result: await fn(orgId) });
    } catch (err) {
      results.push({ orgId, error: (err as Error).message });
    }
  }
  return { ok: true, results };
}

// Vercel Cron issues GET requests; POST is allowed for manual curl testing.
cronRouter.all('/ingest', asyncHandler(async (_req, res) => res.json({ data: await forEachOrg((id) => runIngest(id)) })));
cronRouter.all('/follow-ups', asyncHandler(async (_req, res) => res.json({ data: await forEachOrg((id) => runFollowUps(id)) })));
cronRouter.all('/report', asyncHandler(async (_req, res) => res.json({ data: await forEachOrg((id) => runReport(id)) })));
cronRouter.all('/digest', asyncHandler(async (_req, res) => res.json({ data: await forEachOrg((id) => runDigest(id)) })));

opsRouter.use('/cron', cronRouter);

// ── Signed-in operations ────────────────────────────────────
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
