/**
 * The rules both clocks share: the cron endpoints in routes/ops.ts (called
 * by Supabase pg_cron when hosted on Vercel) and services/scheduler.ts
 * (node-cron, when the API runs as a long-lived server). Keeping them here
 * means a studio gets the same behaviour whichever clock is driving it, and
 * the claim fields agree, so the two never double up on a job.
 */

/** When the scheduled ingest last started each studio's read. */
export const INGEST_RAN_FIELD = 'ingest_ran_at';
/** When the scheduled task review last started for each studio. */
export const TASK_REVIEW_RAN_FIELD = 'task_review_ran_at';
/** When the task reminder email last went out for each studio. */
export const MIDDAY_REMINDER_RAN_FIELD = 'midday_reminder_ran_at';
/** The Pacific hours the task reminder email is allowed to fire in — morning and end of day. */
export const MIDDAY_REMINDER_HOURS = [9, 17];
/**
 * The claim cooldown between sends. Shorter than the 8h gap between the two
 * daily hours above (so the evening send isn't blocked by the morning one),
 * longer than the ~1h a Pacific hour stays current across the polls (so one
 * hour's window can't claim twice).
 */
export const MIDDAY_REMINDER_COOLDOWN_MS = 4 * 3600_000;
/** When the Slack daily reminder last went out for each studio. */
export const SLACK_DIGEST_RAN_FIELD = 'slack_digest_ran_at';
/** The Pacific hour the Slack daily reminder posts in — the start of the working day. */
export const SLACK_DIGEST_HOUR = 9;
/** Once a day: longer than any hour's window, shorter than the day, so it never skips one. */
export const SLACK_DIGEST_COOLDOWN_MS = 20 * 3600_000;
/** When the completed / pending / overdue Slack reports last went out. */
export const SLACK_REPORT_RAN_FIELD = 'slack_report_ran_at';
/** 9am, midday and 5pm Pacific. */
export const SLACK_REPORT_HOURS = [9, 12, 17];
/** Longer than the hour a slot stays current, shorter than the 3h between slots. */
export const SLACK_REPORT_COOLDOWN_MS = 2 * 3600_000;
