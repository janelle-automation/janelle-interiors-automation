-- ============================================================
--  0022 · Email reading and the media sweep, scheduled by Supabase
--
--  Same mechanism as 0021 (run that first — it creates
--  public.call_cron_endpoint and reads the app_url / cron_secret
--  Vault secrets).
--
--  email-ingest  every minute. The endpoint reads each studio only
--                as often as the admin chose in Settings → Reading
--                email → "Check for new email"
--                (default every 10 minutes; "Only when I ask" is
--                never read), so most calls do nothing and cost
--                nothing. Every minute is only so the fastest
--                setting is honoured.
--
--  media-sweep   every 2 minutes. Fetches finished video clips
--                nobody is watching before the provider's link
--                expires. Nothing pending, nothing done.
-- ============================================================

select cron.unschedule(jobid) from cron.job where jobname in ('email-ingest', 'media-sweep');

select cron.schedule('email-ingest', '* * * * *',   $$select public.call_cron_endpoint('ingest')$$);
select cron.schedule('media-sweep',  '*/2 * * * *', $$select public.call_cron_endpoint('media')$$);

-- pg_cron and pg_net each keep a row per run; a job every minute would
-- grow them without end. Keep a week of history, cleared nightly.
select cron.unschedule(jobid) from cron.job where jobname = 'cron-history-cleanup';
select cron.schedule('cron-history-cleanup', '40 3 * * *', $$
  delete from cron.job_run_details where end_time < now() - interval '7 days';
$$);
