-- ============================================================
--  0032 · Who finished the task
--
--  Carissa asked, on 7 Oct 2026, whether she could mark tasks
--  as completed. She could — the board has had a one-click
--  tick since it was built. The question nobody could answer
--  was the one asked straight after: WHICH ones had she
--  already closed? 0015 records WHEN a task was finished and,
--  when the reading pass closed it, WHY. It never recorded who,
--  and `PATCH /tasks/:id` wrote nothing to activity_log, so a
--  person closing a task left no trace at all. Three months of
--  completions are attributable to nobody.
--
--  completed_by  the person who moved it to Done. Null when the
--                system closed it — read it against
--                completion_note, which is the system's own
--                signature:
--
--                  completed_by set                → that person closed it
--                  null + completion_note set      → the system closed it
--                  null + completion_note null     → closed before this
--                                                    migration; unknowable
--
--  DELIBERATELY NOT A FOREIGN KEY. Two reasons, either enough:
--
--  1. PostgREST resolves the implicit `profiles(...)` embed on
--     tasks through the single FK tasks_assigned_to_fkey. A
--     second FK to profiles makes every one of those embeds
--     ambiguous (PGRST201) — the board list, the task detail
--     panel, the subtask list, Slack sync and the assistant all
--     break the moment this migration runs, including the code
--     already deployed. columns.ts guards new code against an
--     old schema; nothing guards old code against a new one.
--  2. `on delete set null` would erase the audit fact this
--     column exists to keep. When someone leaves the studio,
--     who closed the work is exactly what we still want to know.
--
--  The name is resolved from the team roster, which every screen
--  that shows an assignee already loads, and activity_log keeps
--  the durable copy.
-- ============================================================

alter table tasks add column if not exists completed_by uuid;

comment on column tasks.completed_by is
  'Profile id of the person who moved this task to Done. Null when the system closed it (see completion_note) or when it was closed before migration 0032. Intentionally not a foreign key — see the migration.';

-- No backfill. Nothing in the database records who closed the
-- existing Done tasks, and guessing from assigned_to would put a
-- name on work the owner may never have touched. An honest null
-- beats a plausible lie in an audit column.

-- Reopening a task clears it, exactly as 0015 clears completed_at
-- and completion_note: a name saying who finished the work would
-- be false once someone has said the work is not finished.
create or replace function tasks_track_completion() returns trigger
language plpgsql as $$
begin
  if new.status = 'done' then
    if tg_op = 'INSERT' then
      new.completed_at := coalesce(new.completed_at, now());
    elsif old.status is distinct from 'done' then
      new.completed_at := coalesce(new.completed_at, now());
    end if;
  else
    new.completed_at := null;
    new.completion_note := null;
    new.completed_by := null;
  end if;
  return new;
end $$;

drop trigger if exists trg_tasks_completion on tasks;
create trigger trg_tasks_completion before insert or update of status on tasks
  for each row execute function tasks_track_completion();

-- "What did this person finish, and when" — the question that
-- started this. Partial, like 0015's index: only Done rows have it.
create index if not exists idx_tasks_completed_by
  on tasks(org_id, completed_by, completed_at desc)
  where status = 'done' and completed_by is not null;
