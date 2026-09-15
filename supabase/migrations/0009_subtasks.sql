-- ============================================================
--  0009 · Subtasks
--
--  A task raised from an email is usually one line of a larger
--  ask — "approve the proposal" really means review the Canva,
--  check the fabric, then reply. Until now the only way to
--  record those steps was to bury them in `detail`, where
--  nothing could be assigned, dated or closed individually.
--
--  Modelled as a task owning tasks rather than a separate
--  table: a subtask needs every column a task already has —
--  an owner, a status, a due date, a next step — and a second
--  table would have grown into a copy of this one.
-- ============================================================

alter table tasks add column if not exists parent_task_id uuid
  references tasks(id) on delete cascade;

-- Closing a parent takes its subtasks with it, which is why the
-- cascade above is right: a subtask has no meaning on its own.
create index if not exists idx_tasks_parent on tasks(org_id, parent_task_id);
