-- ============================================================
--  0017 · Putting a follow-up down without killing it
--
--  A nudge had two ends: chase it, or dismiss it forever. So the
--  honest answer to most of them — "I know, the vendor is back
--  on Monday" — had no button, and the studio either dismissed
--  something it still wanted, or left it open and learned to
--  scroll past the queue. A queue people scroll past is the same
--  as no queue.
--
--  snoozed_until  hidden from the review queue and skipped by the
--                 nightly engine until this moment passes, then
--                 it comes back on its own.
--  note           why, in the person's own words. Kept for a
--                 dismissal too: "not our vendor any more" is
--                 worth having the next time the name comes up.
-- ============================================================

alter table follow_ups add column if not exists snoozed_until timestamptz;
alter table follow_ups add column if not exists note text;

-- The nightly scan asks "what is awake and still open" on every pass, for
-- every studio, and that is the only question this index has to answer.
create index if not exists idx_follow_ups_awake
  on follow_ups(org_id, status, snoozed_until);

-- Coming back from a snooze is not a new event: the nudge is the same one,
-- with the same history. Clearing the stamp on wake keeps the row honest
-- rather than leaving a past date sitting in it forever.
create or replace function follow_ups_wake() returns trigger
language plpgsql as $$
begin
  if new.snoozed_until is not null and new.snoozed_until <= now() then
    new.snoozed_until := null;
  end if;
  return new;
end $$;

drop trigger if exists trg_follow_ups_wake on follow_ups;
create trigger trg_follow_ups_wake before update on follow_ups
  for each row execute function follow_ups_wake();
