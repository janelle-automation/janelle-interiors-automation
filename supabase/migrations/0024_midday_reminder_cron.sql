-- ============================================================
--  0024 · The midday task reminder, scheduled by Supabase
--
--  Same mechanism as 0021/0022 (run those first — this needs
--  public.call_cron_endpoint and the app_url / cron_secret Vault secrets).
--
--  Polled every 15 minutes, same as the others on the Hobby plan. The
--  endpoint itself decides whether to actually send: only in the 9am or
--  5pm Pacific hour, and only once per studio per hour-slot (see
--  MIDDAY_REMINDER_RAN_FIELD / claimCronSlot in ops.ts). Anchoring on the
--  Pacific wall-clock hour rather than a fixed UTC cron time is what keeps
--  this at 9am/5pm Pacific across the PST/PDT change, so this schedule
--  never needs editing for daylight saving.
-- ============================================================

select cron.unschedule(jobid) from cron.job where jobname = 'midday-reminder';
select cron.schedule('midday-reminder', '*/15 * * * *', $$select public.call_cron_endpoint('midday-reminder')$$);
