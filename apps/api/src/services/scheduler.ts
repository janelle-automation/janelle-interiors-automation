import cron from 'node-cron';
import { supabaseAdmin } from '../lib/supabase.js';
import { runFollowUps } from './followups.js';
import { runReport } from './report.js';
import { runIngest } from './ingest.js';
import { runDigest } from './digest.js';

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

// How often to poll for new email + Drive activity.
// NOTE: 6-field cron includes a seconds field. Ingestion is guarded so
// ticks that land while a run is still in progress are skipped, which
// keeps a fast interval from stacking overlapping runs.
const INGEST_CRON = '*/5 * * * * *'; // every 5 seconds
let ingestRunning = false;

/**
 * Register the background jobs. No-op until Supabase is configured, so
 * it is always safe to call at startup.
 *   • every 5s      — ingest new email + Drive activity (non-overlapping)
 *   • nightly 02:00 — raise follow-ups and draft nudges
 *   • Monday 07:00  — generate the weekly report
 */
export function startScheduler(): void {
  if (!supabaseAdmin) {
    console.log('  ▸ Scheduler idle (Supabase not configured)');
    return;
  }

  cron.schedule(INGEST_CRON, () => {
    if (ingestRunning) return; // skip while a run is already in progress
    ingestRunning = true;
    void forEachOrg((id) => runIngest(id), 'ingest').finally(() => {
      ingestRunning = false;
    });
  });

  cron.schedule('0 2 * * *', () => {
    void forEachOrg((id) => runFollowUps(id), 'followups');
  });

  // Morning digest, every day — the push that means nobody has to log in.
  // Offset past the weekly report so Monday does not run both at once.
  cron.schedule('5 7 * * *', () => {
    void forEachOrg((id) => runDigest(id), 'digest');
  });

  cron.schedule('0 7 * * 1', () => {
    void forEachOrg((id) => runReport(id), 'report');
  });

  console.log(
    `  ▸ Scheduler started (ingest ${INGEST_CRON} · follow-ups 02:00 · digest 07:05 · report Mon 07:00)`,
  );
}
