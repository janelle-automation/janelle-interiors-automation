-- ============================================================
--  0034 · Who signed in, when, how — and who could not
--
--  Asked for after a sign-in that did not work: the client could
--  not get in with "Continue with Google" and there was nowhere
--  to look. Supabase knows, but its `auth` schema is not exposed
--  to the API, and what it records is only what SUCCEEDED — a
--  refused attempt leaves no row anywhere. So the two questions
--  the studio actually asks ("has she ever got in this way?" and
--  "what did it say when she tried?") both had no answer.
--
--  This table answers both. The app writes a row per attempt,
--  success or failure, with the method and — on a failure — what
--  the person was told. The read is Settings → Login history.
--
--  Nullable org_id and user_id on purpose: the most interesting
--  row in here is a failed attempt by an address that matches
--  nobody, which is exactly the row a NOT NULL would refuse.
--
--  Nothing prunes it. A five-person studio writes a handful of
--  rows a day; when that stops being true, delete by created_at.
-- ============================================================

create table if not exists login_events (
  id         uuid primary key default gen_random_uuid(),
  -- Null when the attempt could not be tied to anyone: a wrong address, or
  -- a real one belonging to no profile yet.
  org_id     uuid references organizations(id) on delete cascade,
  user_id    uuid references profiles(id) on delete set null,
  -- What was typed, lowercased. Kept even when user_id resolves, because a
  -- deleted profile must not take the evidence of the attempt with it.
  email      text,
  -- How they tried to get in. 'unknown' covers a provider we do not name
  -- yet, rather than rejecting the row.
  method     text not null check (method in ('password', 'google', 'recovery', 'invite', 'unknown')),
  outcome    text not null check (outcome in ('success', 'failure')),
  -- What they were told, on a failure. The whole point of the table.
  reason     text,
  ip         text,
  user_agent text,
  -- 'app' — recorded live as it happened. 'backfill' — read out of
  -- Supabase's own audit trail by this migration, so the history does not
  -- start empty on the day it ships.
  source     text not null default 'app' check (source in ('app', 'backfill')),
  created_at timestamptz not null default now()
);

-- The screen's only question: this studio's attempts, newest first.
create index if not exists idx_login_events_org_time
  on login_events(org_id, created_at desc);

-- "When did this address last get in?" — asked per person from the table,
-- and by the API when it resolves an attempt to a profile.
create index if not exists idx_login_events_email_time
  on login_events(email, created_at desc);

-- Failures are the few rows in a mostly-successful table, and they are what
-- someone opens this screen to read. Partial, so the index stays small.
create index if not exists idx_login_events_failures
  on login_events(created_at desc)
  where outcome = 'failure';

/*
 * Org-scoped like every other operational table.
 *
 * Note that this leaves the org_id IS NULL rows unreadable through RLS —
 * deliberately. An attempt that matched nobody belongs to no studio, and the
 * screen that shows it reads through the service role with the role check in
 * front of it (supervisors only), not through a policy.
 */
alter table login_events enable row level security;
drop policy if exists login_events_org_read on login_events;
create policy login_events_org_read on login_events
  for select using (org_id = current_org_id());

-- ── History, before this table existed ───────────────────────
--
-- Supabase's GoTrue writes an audit row per successful sign-in, carrying
-- the provider in `traits` and the address in `actor_username`. That is
-- months of "who got in, how" already recorded — and it is the fastest way
-- to answer the question behind this migration: whether Google sign-in has
-- EVER worked for a given person, or has never once succeeded.
--
-- Guarded and swallowed: `auth.audit_log_entries` is not part of any
-- contract, and a schema this migration cannot read must not stop the table
-- it has just created from existing.
do $$
declare
  copied integer := 0;
begin
  -- Idempotent, for the case where this file is pasted into the SQL editor
  -- rather than run by the migration runner that tracks it.
  if exists (select 1 from login_events limit 1) then
    raise notice '0034: login_events already has rows — leaving the backfill alone';
  else
    insert into login_events (org_id, user_id, email, method, outcome, ip, source, created_at)
    select p.org_id,
           p.id,
           lower(coalesce(nullif(e.payload->>'actor_username', ''), p.email)),
           -- A row with no provider named is the email/password flow; GoTrue
           -- only started carrying the trait later. `coalesce` rather than a
           -- `when null` branch, which never matches in a CASE.
           case coalesce(e.payload->'traits'->>'provider', 'email')
             when 'google' then 'google'
             when 'email'  then 'password'
             else 'unknown'
           end,
           'success',
           nullif(e.ip_address::text, ''),
           'backfill',
           e.created_at
      from auth.audit_log_entries e
      -- Left join: an audit row whose actor has since been deleted is still
      -- evidence that a sign-in happened, and still names the address.
      --
      -- The uuid cast sits inside a CASE rather than beside a regex in the
      -- same AND: a join condition's operands have no guaranteed evaluation
      -- order, so a malformed actor_id could be cast before the guard that
      -- was meant to stop it. CASE does short-circuit.
      left join profiles p
             on p.id = case
                         when e.payload->>'actor_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                         then (e.payload->>'actor_id')::uuid
                       end
     where e.payload->>'action' in ('login', 'user_signedup')
       and e.created_at > now() - interval '180 days';

    get diagnostics copied = row_count;
    raise notice '0034: backfilled % sign-in(s) from the Supabase audit trail', copied;
  end if;
exception
  when others then
    raise notice '0034: could not read auth.audit_log_entries (%) — the table starts empty, which is harmless', sqlerrm;
end $$;
