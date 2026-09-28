-- ============================================================
--  0023 · Atomic writes to organizations.settings
--
--  claimCronSlot, advanceIngestCursor and saveReviewMarks (tasks.ts) each
--  used to read the whole settings blob, patch one key in JS, and write the
--  whole blob back. With ingest firing every minute (the studio's own
--  Settings choice) and up to seven connected mailboxes read in the same
--  pass, two of these routinely land close enough together that the later
--  write — built from a snapshot taken before the earlier one committed —
--  overwrites it, silently dropping the key the earlier write had just
--  added. That is why `ingest_ran_at` was missing from settings entirely
--  despite the cron firing for hours, and why only one of seven mailboxes'
--  `ingest_cursors` entries had ever survived, four days stale: with no
--  watermark ever persisting, every pass re-listed the same backlog and
--  never got past it.
--
--  These three functions do the same job in one UPDATE each, so the row's
--  current value at write time is whatever Postgres actually committed
--  last, not a copy read moments before by the code that lost the race.
-- ============================================================

-- An unconditional shallow merge: existing keys are kept, the patch's keys
-- win. Used for a single top-level field (task_reviewed_at's whole map is
-- rebuilt in one call, so a shallow merge is exactly what it needs).
create or replace function public.merge_org_settings(p_org_id uuid, p_patch jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.organizations
  set settings = coalesce(settings, '{}'::jsonb) || p_patch
  where id = p_org_id;
$$;

revoke all on function public.merge_org_settings(uuid, jsonb) from public, anon, authenticated;

-- One mailbox's watermark, merged into the ingest_cursors map without
-- disturbing any other mailbox's entry or any other top-level key.
create or replace function public.set_ingest_cursor(p_org_id uuid, p_user_id text, p_iso text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.organizations
  set settings = jsonb_set(
    coalesce(settings, '{}'::jsonb),
    array['ingest_cursors'],
    coalesce(settings -> 'ingest_cursors', '{}'::jsonb) || jsonb_build_object(p_user_id, p_iso),
    true
  )
  where id = p_org_id;
$$;

revoke all on function public.set_ingest_cursor(uuid, text, text) from public, anon, authenticated;

-- Take a studio's turn at a scheduled job, or learn it is not due yet —
-- the read-and-decide and the write happen inside one row lock, so a
-- second call for the same studio waits for the first to commit instead of
-- deciding from a timestamp the first is about to replace.
create or replace function public.claim_cron_slot(p_org_id uuid, p_field text, p_every_ms bigint, p_slack_ms bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  last_val text;
  last_ms  bigint;
begin
  select settings ->> p_field into last_val
  from public.organizations
  where id = p_org_id
  for update;

  if last_val is not null then
    last_ms := (extract(epoch from last_val::timestamptz) * 1000)::bigint;
    if (extract(epoch from now()) * 1000)::bigint - last_ms < p_every_ms - p_slack_ms then
      return false;
    end if;
  end if;

  update public.organizations
  set settings = coalesce(settings, '{}'::jsonb)
    || jsonb_build_object(p_field, to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  where id = p_org_id;

  return true;
end;
$$;

revoke all on function public.claim_cron_slot(uuid, text, bigint, bigint) from public, anon, authenticated;
