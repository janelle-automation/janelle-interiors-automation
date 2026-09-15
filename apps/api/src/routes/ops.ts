import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { backfillEmailBodies, runIngest } from '../services/ingest.js';
import { autoMergeDuplicates, promoteAll, removeVendorProjects } from '../services/promote.js';
import { importHouzzProjects } from '../services/houzz.js';
import { runFollowUps } from '../services/followups.js';
import { runReport } from '../services/report.js';
import { runDigest } from '../services/digest.js';
import { backfillTasks, mergeDuplicateTasks } from '../services/tasks.js';
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

/**
 * How long a whole request may spend working before it must answer.
 *
 * Vercel kills the function at `maxDuration` (vercel.json) and the caller
 * sees a 504 FUNCTION_INVOCATION_TIMEOUT with no result at all. Every job
 * below is resumable, so they stop themselves short of that instead and
 * report what is left.
 *
 * Short rather than nearly-maxDuration: a long-held connection is the one
 * that gets dropped between the browser and the function, and a dropped
 * request carries no status for the caller to act on. The cron path gets
 * more room, since nothing is waiting on its connection.
 */
const JOB_BUDGET_MS = Number(process.env.JOB_BUDGET_MS || 20_000);
const CRON_BUDGET_MS = Number(process.env.CRON_BUDGET_MS || 45_000);

/**
 * Run a job for every organisation, collecting per-org results.
 *
 * The budget is for the request, not for each org, so it is shared out as
 * the loop goes: an org reached with no time left is skipped rather than
 * started and cut off mid-flight.
 */
async function forEachOrg<T>(fn: (orgId: string, budgetMs: number) => Promise<T>) {
  if (!supabaseAdmin) return { ok: false, reason: 'supabase_not_configured', results: [] as unknown[] };
  const deadline = Date.now() + CRON_BUDGET_MS;
  const { data: orgs } = await supabaseAdmin.from('organizations').select('id');
  const results: unknown[] = [];
  let skipped = 0;
  for (const org of orgs ?? []) {
    const orgId = (org as { id: string }).id;
    const left = deadline - Date.now();
    if (left <= 0) {
      skipped++;
      continue;
    }
    try {
      results.push({ orgId, result: await fn(orgId, left) });
    } catch (err) {
      results.push({ orgId, error: (err as Error).message });
    }
  }
  return { ok: true, results, skipped };
}

// Vercel Cron issues GET requests; POST is allowed for manual curl testing.
cronRouter.all('/ingest', asyncHandler(async (_req, res) => res.json({ data: await forEachOrg((id, budgetMs) => runIngest(id, { budgetMs })) })));
cronRouter.all('/follow-ups', asyncHandler(async (_req, res) => res.json({ data: await forEachOrg((id) => runFollowUps(id)) })));
cronRouter.all('/report', asyncHandler(async (_req, res) => res.json({ data: await forEachOrg((id) => runReport(id)) })));
cronRouter.all('/digest', asyncHandler(async (_req, res) => res.json({ data: await forEachOrg((id) => runDigest(id)) })));

opsRouter.use('/cron', cronRouter);

// ── Signed-in operations ────────────────────────────────────
// Everything below this line gets req.auth. Anything added ABOVE it will
// not, and a role check there fails with "Insufficient permissions" even
// for a principal — the role is simply undefined.
opsRouter.use(requireAuth);

// Raise tasks from email that was ingested before the tasks table existed.
opsRouter.post(
  '/backfill-tasks',
  requireRole('principal', 'coordinator'),
  asyncHandler(async (req, res) => {
    if (!req.auth!.orgId) return res.status(400).json({ error: 'No organization for user' });
    res.json({ data: await backfillTasks(req.auth!.orgId) });
  }),
);

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

// Bring the project list over from a Houzz Pro CSV export. Houzz has no
// API for this, so the file is the only route; it stays the source of
// truth and nothing is ever written back to it.
opsRouter.post(
  '/import-houzz',
  requireRole('principal', 'coordinator'),
  asyncHandler(async (req, res) => {
    if (!req.auth!.orgId) return res.status(400).json({ error: 'No organization for user' });
    const csv = typeof req.body?.csv === 'string' ? req.body.csv : '';
    if (!csv.trim()) return res.status(400).json({ error: 'No CSV content was sent' });
    res.json({ data: await importHouzzProjects(req.auth!.orgId, csv) });
  }),
);

// Fetch the body and links for mail read before they were stored. No
// Claude calls: it only fills in text the system used to throw away.
opsRouter.post(
  '/backfill-email-bodies',
  requireRole('principal', 'coordinator'),
  asyncHandler(async (req, res) => {
    if (!req.auth!.orgId) return res.status(400).json({ error: 'No organization for user' });
    res.json({ data: await backfillEmailBodies(req.auth!.orgId, { budgetMs: JOB_BUDGET_MS }) });
  }),
);

// Remove tasks raised more than once for the same work. Reading email does
// this by itself at the end of a pass; this clears the existing backlog.
opsRouter.post(
  '/dedupe-tasks',
  requireRole('principal', 'coordinator'),
  asyncHandler(async (req, res) => {
    if (!req.auth!.orgId) return res.status(400).json({ error: 'No organization for user' });
    res.json({ data: await mergeDuplicateTasks(req.auth!.orgId) });
  }),
);

// Fold every duplicate project into one. Reading email does this by itself
// at the end of a pass; this clears a backlog that built up before then.
opsRouter.post(
  '/dedupe-projects',
  requireRole('principal', 'coordinator'),
  asyncHandler(async (req, res) => {
    if (!req.auth!.orgId) return res.status(400).json({ error: 'No organization for user' });
    const merged = await autoMergeDuplicates(req.auth!.orgId);
    const vendorRows = await removeVendorProjects(req.auth!.orgId);
    res.json({ data: { ...merged, vendorProjectsRemoved: vendorRows.removed, vendorProjectNames: vendorRows.names } });
  }),
);

// Manually trigger an ingestion pass (principal / coordinator only).
opsRouter.post(
  '/ingest',
  requireRole('principal', 'coordinator'),
  asyncHandler(async (req, res) => {
    if (!req.auth!.orgId) return res.status(400).json({ error: 'No organization for user' });
    // Returns `done: false` with a partial count when the budget runs out.
    // The dashboard calls again until it comes back done.
    const result = await runIngest(req.auth!.orgId, {
      emailQuery: typeof req.body?.emailQuery === 'string' ? req.body.emailQuery : undefined,
      folderId: typeof req.body?.folderId === 'string' ? req.body.folderId : undefined,
      budgetMs: JOB_BUDGET_MS,
    });
    res.json({ data: result });
  }),
);
