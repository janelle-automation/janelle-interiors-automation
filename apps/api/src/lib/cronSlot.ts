import { supabaseAdmin } from './supabase.js';

/**
 * Take a studio's turn at a scheduled job, or learn it is not due yet.
 *
 * Hosted, a job is called by an outside clock (Supabase pg_cron) at a fixed
 * pace, while each studio chooses its own interval — and a serverless
 * function remembers nothing between calls. So the last start is kept in
 * `organizations.settings[field]`.
 *
 * The read-decide-write happens in one Postgres function call
 * (`claim_cron_slot`, migration 0023), not here: reading the settings blob,
 * deciding in JS and writing it back raced every other writer of the same
 * blob (ingest's own per-mailbox cursor, the other field this function
 * guards, an admin saving Settings). Whichever wrote last, from a snapshot
 * taken before the other's write landed, silently dropped it — which is why
 * `ingest_ran_at` went missing from settings entirely despite the ingest
 * cron firing every minute for hours. A single UPDATE inside one row lock
 * has no such window: a second call for the same studio waits for the first
 * to commit, then reads what it actually wrote.
 *
 * `everyMs` is shortened by a little slack, so a clock that fires a few
 * seconds early does not push a studio back a whole interval.
 */
export async function claimCronSlot(orgId: string, field: string, everyMs: number): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const slack = Math.min(20_000, everyMs / 4);
  const { data, error } = await supabaseAdmin.rpc('claim_cron_slot', {
    p_org_id: orgId,
    p_field: field,
    p_every_ms: everyMs,
    p_slack_ms: slack,
  });
  if (error) {
    console.error(`[cron] ${field} claim failed:`, error.message);
    return false;
  }
  return data === true;
}
