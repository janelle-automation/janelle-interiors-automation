import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { backfillEmailBodies, refileFromAttachments, runIngest } from '../services/ingest.js';
import { autoMergeDuplicates, promoteAll, removeVendorProjects } from '../services/promote.js';
import { importHouzzProjects } from '../services/houzz.js';
import { runFollowUps, resolveFollowUps } from '../services/followups.js';
import { runReport } from '../services/report.js';
import { runDigest } from '../services/digest.js';
import { advanceActiveTasks, backfillTasks, mergeDuplicateTasks, reviewOpenTasks } from '../services/tasks.js';
import { sweepJobs } from '../services/mediaJobs.js';
import { keepGoogleAlive } from '../services/googleKeepalive.js';
import { runMiddayReminder } from '../services/middayReminder.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { readIngestSettings } from '../lib/ingestSettings.js';
import { claimCronSlot } from '../lib/cronSlot.js';
import { pacificHourNow } from '../lib/pacificTime.js';

/** When the scheduled ingest last started each studio's read. */
const INGEST_RAN_FIELD = 'ingest_ran_at';
/** When the scheduled task review last started for each studio. */
const TASK_REVIEW_RAN_FIELD = 'task_review_ran_at';
/** When the midday reminder last went out for each studio. */
const MIDDAY_REMINDER_RAN_FIELD = 'midday_reminder_ran_at';
/** The Pacific hour the midday reminder is allowed to fire in. */
const MIDDAY_REMINDER_HOUR = 12;

export const opsRouter = Router();

// ── Scheduled jobs ──────────────────────────────────────────
// Vercel Cron and Supabase pg_cron call these; there is no long-running process to hold the
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
//
// Supabase pg_cron calls this every minute (migration 0022), and each studio
// is read only as often as it asked in Settings → Reading email — "Only when
// I ask" is never read here. `?force=1` reads every studio now.
cronRouter.all(
  '/ingest',
  // Reading the mail and acting on what it says are one job: a hosted cron
  // must not leave the board and the follow-up queue behind the inbox.
  asyncHandler(async (req, res) => {
    const force = req.query.force === '1';
    res.json({
      data: await forEachOrg(async (id, budgetMs) => {
        if (!force) {
          const { intervalMinutes } = await readIngestSettings(id);
          if (intervalMinutes <= 0) return { ok: true, skipped: 'on_demand_only' };
          if (!(await claimCronSlot(id, INGEST_RAN_FIELD, intervalMinutes * 60_000))) {
            return { ok: true, skipped: 'not_due' };
          }
        }
        const result = await runIngest(id, { budgetMs });
        await resolveFollowUps(id);
        await advanceActiveTasks(id);
        return result;
      }),
    });
  }),
);
// Close the tasks the mail since they were raised shows are done. Called
// every five minutes (migration 0021); each studio is reviewed only as often
// as it chose in Settings → Reading email. `?force=1` reviews every studio now.
cronRouter.all(
  '/tasks',
  asyncHandler(async (req, res) => {
    const force = req.query.force === '1';
    res.json({
      data: await forEachOrg(async (id, budgetMs) => {
        if (!force) {
          const { taskReviewMinutes } = await readIngestSettings(id);
          if (taskReviewMinutes <= 0) return { ok: true, skipped: 'off' };
          if (!(await claimCronSlot(id, TASK_REVIEW_RAN_FIELD, taskReviewMinutes * 60_000))) {
            return { ok: true, skipped: 'not_due' };
          }
        }
        return reviewOpenTasks(id, { budgetMs });
      }),
    });
  }),
);
// Once a day, at noon Pacific (migration 0024). Polled every 15 minutes
// like the others; the Pacific-hour check is the real gate, and
// claimCronSlot's ~23h window keeps a studio from getting it twice in the
// same hour without drifting across the PST/PDT change, since the gate is
// the wall-clock hour rather than a fixed UTC cron time. `?force=1` sends
// now regardless of the hour or the last send.
cronRouter.all(
  '/midday-reminder',
  asyncHandler(async (req, res) => {
    const force = req.query.force === '1';
    res.json({
      data: await forEachOrg(async (id) => {
        if (!force) {
          if (pacificHourNow() !== MIDDAY_REMINDER_HOUR) return { ok: true, skipped: 'not_midday' };
          if (!(await claimCronSlot(id, MIDDAY_REMINDER_RAN_FIELD, 23 * 3600_000))) {
            return { ok: true, skipped: 'already_sent' };
          }
        }
        return runMiddayReminder(id);
      }),
    });
  }),
);
cronRouter.all('/follow-ups', asyncHandler(async (_req, res) => res.json({ data: await forEachOrg((id) => runFollowUps(id)) })));
cronRouter.all('/report', asyncHandler(async (_req, res) => res.json({ data: await forEachOrg((id) => runReport(id)) })));
cronRouter.all('/digest', asyncHandler(async (_req, res) => res.json({ data: await forEachOrg((id) => runDigest(id)) })));
// Video that nobody is watching. A clip finishes a minute or two after the
// request that started it has gone, and the provider's URL for it is
// temporary — without this, a person who asked and then closed the tab
// would have paid for something that was never fetched.
cronRouter.all('/media', asyncHandler(async (_req, res) => res.json({ data: await forEachOrg((id) => sweepJobs(id)) })));

// Every connected Google account refreshed, so none lapses from disuse and
// a revoked one shows up on the Team screen. Not per-org: one pass covers all.
cronRouter.all('/google-keepalive', asyncHandler(async (_req, res) => res.json({ data: await keepGoogleAlive() })));

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
    // A person is waiting on this one, so it gets the short budget and
    // reports what is left rather than holding the connection open.
    const result = await backfillTasks(req.auth!.orgId, { budgetMs: JOB_BUDGET_MS });
    // Tasks raised from old mail are often already under way: advance them
    // in the same pass rather than showing a board of stale Open cards.
    const advanced = await advanceActiveTasks(req.auth!.orgId);
    res.json({ data: { ...result, advanced } });
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

// File email that has no project using what its attachments already said.
// No Claude calls; runs after every complete reading pass as well.
opsRouter.post(
  '/refile-emails',
  requireRole('principal', 'coordinator'),
  asyncHandler(async (req, res) => {
    if (!req.auth!.orgId) return res.status(400).json({ error: 'No organization for user' });
    res.json({ data: await refileFromAttachments(req.auth!.orgId) });
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

// Run the hourly task review now, rather than waiting for the hour.
opsRouter.post(
  '/review-tasks',
  requireRole('principal', 'coordinator'),
  asyncHandler(async (req, res) => {
    if (!req.auth!.orgId) return res.status(400).json({ error: 'No organization for user' });
    res.json({ data: await reviewOpenTasks(req.auth!.orgId, { budgetMs: JOB_BUDGET_MS }) });
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
    await resolveFollowUps(req.auth!.orgId);
    const advanced = await advanceActiveTasks(req.auth!.orgId);
    res.json({ data: { ...result, advanced } });
  }),
);
