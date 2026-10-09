-- ============================================================
--  0037 · One row per sign-in, not one per page load
--
--  The browser decided whether a sign-in had already been
--  recorded, by remembering the last one in localStorage. That
--  is the wrong place to keep it. localStorage is per origin and
--  per profile, it is cleared by anyone clearing site data, and
--  it is simply absent in a private window — so the same session
--  was filed again and again. Three "sign-ins" were recorded on
--  a day when nobody signed in at all; every one of them was one
--  Supabase session, three page loads.
--
--  A sign-in IS a session. Supabase mints exactly one session per
--  authentication and names it in every access token it issues,
--  so the session id is the natural identity of the event — and
--  unlike a browser's memory of itself, it cannot be lost.
--
--  The partial unique index is the real guard. Two tabs restoring
--  the same session at once would both look, both see nothing and
--  both insert; a check in application code cannot close that,
--  and the database can.
-- ============================================================

alter table login_events add column if not exists session_id uuid;

comment on column login_events.session_id is
  'The Supabase session this sign-in created, from the access token. One success per session. Null on failures (no session exists) and on rows written before 0037.';

/*
 * One successful row per session.
 *
 * Partial, on two counts. Failures have no session and would all collide
 * on null. And rows from before this migration have no session id either,
 * so a plain unique index could not be created at all without first
 * inventing values for them.
 */
create unique index if not exists idx_login_events_one_per_session
  on login_events(session_id)
  where session_id is not null and outcome = 'success';

-- The screen reads newest-first within an org; this one is for the dedupe
-- lookup, which asks only about a single session.
create index if not exists idx_login_events_session
  on login_events(session_id)
  where session_id is not null;
