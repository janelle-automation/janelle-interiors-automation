-- ============================================================
--  0009 · A seat for each person, and the task-hygiene events
--
--  "Team Roles Scorecards v3 — Named Seats" routes work by SEAT.
--  Auth routes by ROLE, which is coarser: Operations and PM
--  support are both coordination, but only one owns POs. Tasks
--  have carried a seat since 0006 — people never have, so a
--  person could not be checked against the seat that owns an
--  outcome.
--
--  The seat this unblocks is PM support. That seat owns "pushing
--  tasks so each has ONE owner, a due date and a next step, and
--  chasing overdue and unassigned tasks", but its role is
--  assistant, and reassigning someone else's task is gated on
--  principal/coordinator. Widening that gate by role would have
--  handed the same power to Technical production, whose seat says
--  explicitly it must not be "Lead Designer or PM". Only a seat
--  can tell those two apart.
-- ============================================================

-- Which named seat this person holds. Null is normal: the roles
-- document names a person for every seat except the vacant COO,
-- but a new teammate has none until someone assigns it.
alter table profiles add column if not exists seat task_seat;

create index if not exists idx_profiles_seat on profiles(org_id, seat);

-- ── Task hygiene events ─────────────────────────────────────
-- The follow-up engine chased work that was late. It had nothing
-- for work that was never properly formed — no owner, no next
-- step, no due date — which is exactly what the PM support seat
-- owns. These three make that ownership actionable.
--
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block
-- on some PostgreSQL versions; the runner applies this file
-- outside one.
alter type follow_up_type add value if not exists 'task_unowned';
alter type follow_up_type add value if not exists 'task_no_next_step';
alter type follow_up_type add value if not exists 'task_no_due_date';
