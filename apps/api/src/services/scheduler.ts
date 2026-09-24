import cron from 'node-cron';
import { supabaseAdmin } from '../lib/supabase.js';
import { runFollowUps, resolveFollowUps } from './followups.js';
import { advanceActiveTasks } from './tasks.js';
import { runReport } from './report.js';
import { runIngest } from './ingest.js';
import { runDigest } from './digest.js';
import { readIngestSettings } from '../lib/ingestSettings.js';
import { sweepJobs } from './mediaJobs.js';
import { keepGoogleAlive } from './googleKeepalive.js';

async function forEachOrg(fn: (orgId: string) => Promise<unknown>, label: string) {
  if (!supabaseAdmin) return;
  const { data: orgs } = await supabaseAdmin.from('organizations').select('id');
  for (const org of orgs ?? []) {
    try {
      await fn((org as { id: string }).id);
    } catch (err) {
      console.error(`[scheduler] ${label} failed for org ${(org as { id: string }).id}:`, (err as Error).message);
    }
  }
}

/**
 * The ingest tick fires every minute; each studio is then read only as
 * often as it has asked to be (Settings → Reading email, default every
 * 10 minutes, and "Only when I ask" turns it off entirely).
 *
 * This used to be a hard-coded six-field cron firing every five seconds.
 * That is a lot of Gmail and Supabase traffic, and since every NEW email costs
 * a Claude call to read, a busy inbox turned into a bill nobody chose.
 * Re-reading the setting each tick means a change takes effect within the
 * minute, with no restart.
 */
const INGEST_TICK = '* * * * *'; // every minute; the studio decides the rest
let ingestRunning = false;

/** One media sweep at a time: they poll a provider and can overlap. */
let mediaRunning = false;

/** When each org was last read, so an interval can be honoured. */
const lastIngest = new Map<string, number>();

async function ingestDueOrgs(): Promise<void> {
  if (!supabaseAdmin) return;
  const { data: orgs } = await supabaseAdmin.from('organizations').select('id');

  for (const org of orgs ?? []) {
    const orgId = (org as { id: string }).id;
    try {
      const { intervalMinutes } = await readIngestSettings(orgId);
      if (intervalMinutes <= 0) continue; // reading on demand only

      const last = lastIngest.get(orgId) ?? 0;
      if (Date.now() - last < intervalMinutes * 60_000) continue;

      lastIngest.set(orgId, Date.now());
      await runIngest(orgId);

      // Straight after reading the mail, while the replies that answer a
      // nudge are the newest thing in the system. Waiting for the 2am engine
      // meant a follow-up settled at nine in the morning sat in the review
      // queue all day.
      await resolveFollowUps(orgId);

      // Same moment, same reason: a thread that moved since a task was
      // raised means somebody is on it, and the board should show that
      // without being told.
      await advanceActiveTasks(orgId);
    } catch (err) {
      console.error(`[scheduler] ingest failed for org ${orgId}:`, (err as Error).message);
    }
  }
}

/**
 * Register the background jobs. No-op until Supabase is configured, so
 * it is always safe to call at startup.
 *   • every minute  — read email for any studio whose interval is due
 *   • nightly 02:00 — raise follow-ups and draft nudges
 *   • Monday 07:00  — generate the weekly report
 */
export function startScheduler(): void {
  if (!supabaseAdmin) {
    console.log('  ▸ Scheduler idle (Supabase not configured)');
    return;
  }

  cron.schedule(INGEST_TICK, () => {
    if (ingestRunning) return; // skip while a run is already in progress
    ingestRunning = true;
    void ingestDueOrgs().finally(() => {
      ingestRunning = false;
    });
  });

  cron.schedule('0 2 * * *', () => {
    void forEachOrg((id) => runFollowUps(id), 'followups');
  });

  // Video finishes a minute or two after the request that started it, and
  // the provider's URL for a finished clip is temporary. A person watching
  // the screen polls it themselves; this is for the one who closed the tab.
  cron.schedule('*/2 * * * *', () => {
    if (mediaRunning) return;
    mediaRunning = true;
    void forEachOrg((id) => sweepJobs(id), 'media').finally(() => {
      mediaRunning = false;
    });
  });

  // Morning digest, every day — the push that means nobody has to log in.
  // Offset past the weekly report so Monday does not run both at once.
  cron.schedule('5 7 * * *', () => {
    void forEachOrg((id) => runDigest(id), 'digest');
  });

  cron.schedule('0 7 * * 1', () => {
    void forEachOrg((id) => runReport(id), 'report');
  });

  // Every Google connection refreshed, so none sits idle until Google
  // expires it — and a revoked one is found by this, not by a failed read.
  const keepalive = () =>
    void keepGoogleAlive()
      .then((r) => console.log(`[google] keep-alive: ${r.healthy}/${r.checked} healthy, ${r.needReconnect} need reconnect, ${r.transient} retry later`))
      .catch((err) => console.error('[google] keep-alive failed:', (err as Error).message));
  cron.schedule('15 */6 * * *', keepalive);
  keepalive();

  console.log(
    '  ▸ Scheduler started (email: per-studio interval · follow-ups 02:00 · digest 07:05 · report Mon 07:00 · media every 2 min · Google keep-alive every 6h)',
  );
}
