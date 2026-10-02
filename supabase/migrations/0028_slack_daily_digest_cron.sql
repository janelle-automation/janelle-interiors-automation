-- ============================================================
--  0028 · The Slack daily reminder, scheduled by Supabase
--
--  Same mechanism as 0021/0024 (needs public.call_cron_endpoint and
--  the app_url / cron_secret Vault secrets).
--
--  Polled every 15 minutes; the endpoint posts only in the 9am Pacific
--  hour and only once a day per studio (SLACK_DIGEST_* in ops.ts), so the
--  schedule never needs editing for the PST/PDT change.
-- ============================================================

select cron.unschedule(jobid) from cron.job where jobname = 'slack-digest';
select cron.schedule('slack-digest', '*/15 * * * *', $$select public.call_cron_endpoint('slack-digest')$$);
