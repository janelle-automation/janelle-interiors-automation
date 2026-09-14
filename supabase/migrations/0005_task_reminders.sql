-- ============================================================
--  0005 · Reminders on internal work
--  Follow-ups until now chased vendors and clients. These two
--  types chase the studio's own people: a nudge to whoever owns
--  an overdue task, and an escalation to the principal when the
--  nudge has been ignored.
-- ============================================================

-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block on some
-- PostgreSQL versions; the runner applies this file outside one.
alter type follow_up_type add value if not exists 'task_overdue';
alter type follow_up_type add value if not exists 'task_escalation';

-- Which task a follow-up is chasing, so a reminder is not raised twice for
-- the same work and the UI can link back to it.
alter table follow_ups add column if not exists task_id uuid references tasks(id) on delete cascade;
create index if not exists idx_follow_ups_task on follow_ups(org_id, task_id);

-- When the owner was last nudged about a task, so reminders repeat on a
-- cadence instead of firing every night.
alter table tasks add column if not exists reminded_at timestamptz;
alter table tasks add column if not exists reminder_count integer not null default 0;
