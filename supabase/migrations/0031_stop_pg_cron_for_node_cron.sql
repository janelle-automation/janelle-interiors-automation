-- ============================================================
--  0031 · Hand the schedule from Supabase pg_cron to node-cron
--
--  RUN THIS ONLY ONCE THE SELF-HOSTED API IS LIVE (deploy/README.md).
--  Before that, pg_cron is the only clock: running it early stops
--  email reading, task review, reminders and Slack until the server
--  is up.
--
--  The self-hosted API runs services/scheduler.ts, which does every
--  job these called on Vercel. Left on, they would keep invoking the
--  old Vercel URL (app_url) for nothing — the shared claim fields stop
--  real double work, but not the wasted calls.
--
--  Going back to Vercel: re-run 0021, 0022, 0024, 0027 and 0028, which
--  schedule the jobs again.
--  cron-history-cleanup (0022) is left: it only trims pg_cron's log.
-- ============================================================

select cron.unschedule(jobid) from cron.job
 where jobname in ('email-ingest', 'task-review', 'media-sweep', 'slack-sync', 'midday-reminder', 'slack-digest',
                   'follow-ups', 'google-keepalive', 'digest', 'weekly-report', 'slack-report');
