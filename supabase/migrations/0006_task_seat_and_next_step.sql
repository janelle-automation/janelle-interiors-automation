-- ============================================================
--  0006 · Seat ownership + the Tasks SOP six questions
--  The studio's Tasks SOP requires every task to answer, in
--  30 seconds: what, where, status, next step, who, when.
--  Title/status/assignee/due date covered four of those;
--  "where" and "next step" had nowhere to live.
-- ============================================================

do $$ begin
  create type task_seat as enum
    ('owner','coo','operations','pm_support','technical_production','hotel_ffe','design');
exception when duplicate_object then null; end $$;

-- Which named seat owns the outcome. More specific than assigned_role:
-- Operations and PM support are both coordination, but only one owns POs.
alter table tasks add column if not exists seat task_seat;

-- "Next step" — the single concrete action. A task without one fails the
-- studio's own review, so it is stored rather than buried in the detail.
alter table tasks add column if not exists next_step text;

create index if not exists idx_tasks_seat on tasks(org_id, seat);
