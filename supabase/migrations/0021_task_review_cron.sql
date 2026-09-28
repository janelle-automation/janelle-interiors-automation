-- ============================================================
--  0021 · The task review, scheduled by Supabase
--
--  Vercel's Hobby plan allows a cron at most once a day, and a
--  serverless function has no process alive to hold a node-cron
--  timer. So the database keeps the clock: pg_cron fires every
--  five minutes and pg_net calls the app's own
--  /api/ops/cron/tasks endpoint, exactly as any cron would.
--
--  How often a studio is actually reviewed is NOT set here. It is
--  the admin's choice in Settings → Reading email → "Close
--  finished tasks" (default every hour, or Off); the endpoint
--  skips a studio that is not due. Changing it needs no SQL.
--
--  The address and the secret are NOT in this file. They live in
--  Supabase Vault and are read at call time, so this migration
--  is safe to commit. Set them once in the SQL editor:
--
--    select vault.create_secret('https://janelle-interiors-automation.vercel.app', 'app_url');
--    select vault.create_secret('<the CRON_SECRET value on Vercel>', 'cron_secret');
--
--  Until both exist every run is a logged warning and nothing
--  else. To change one later: vault.update_secret(id, new_value).
--
--  Other jobs can use the same function, e.g. every 10 minutes:
--    select cron.schedule('email-ingest', '*/10 * * * *',
--      $$select public.call_cron_endpoint('ingest')$$);
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Calls one /api/ops/cron/<path> endpoint. Asynchronous: pg_net sends
-- the request and records the answer in net._http_response.
create or replace function public.call_cron_endpoint(path text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  base   text;
  secret text;
begin
  select decrypted_secret into base   from vault.decrypted_secrets where name = 'app_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'cron_secret';
  if base is null or secret is null then
    raise warning 'call_cron_endpoint(%): set the app_url and cron_secret Vault secrets', path;
    return null;
  end if;

  return net.http_get(
    url                  := rtrim(base, '/') || '/api/ops/cron/' || path,
    headers              := jsonb_build_object('Authorization', 'Bearer ' || secret),
    -- The function may take up to its 60s maxDuration; do not hang up first.
    timeout_milliseconds := 60000
  );
end;
$$;

-- Only the scheduler (running as postgres) calls it; never the API roles.
revoke all on function public.call_cron_endpoint(text) from public, anon, authenticated;

-- Re-running the migration replaces the job instead of adding a second.
select cron.unschedule(jobid) from cron.job where jobname in ('hourly-task-review', 'task-review');
select cron.schedule('task-review', '*/5 * * * *', $$select public.call_cron_endpoint('tasks')$$);
