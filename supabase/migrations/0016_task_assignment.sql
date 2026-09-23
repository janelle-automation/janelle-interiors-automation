-- ============================================================
--  0016 · When a task landed on someone
--
--  Work was only ever chased once it was LATE. Nothing told a
--  person that something had just become theirs, so a task
--  raised from Tuesday's email sat unseen until Friday's due
--  date passed and the overdue nudge finally went out. The
--  studio was being told about failures instead of about work.
--
--  created_at cannot answer this: a task reassigned from one
--  person to another is new to the person receiving it, and its
--  creation date belongs to a decision they had no part in.
--
--  assigned_at  when the CURRENT owner got it. Null while the
--               task is unowned, and reset every time it moves,
--               so "new for you" means new for whoever holds it
--               now rather than new to the board.
-- ============================================================

alter table tasks add column if not exists assigned_at timestamptz;

-- Work already on someone's plate: the day it was raised is the
-- closest record of when they got it, and it keeps every existing
-- task out of "just assigned" on the first load after deploying.
update tasks
   set assigned_at = created_at
 where assigned_to is not null
   and assigned_at is null;

-- In a trigger rather than in each caller, like completion in 0015:
-- ingest raises tasks, the board reassigns them, Jenny reassigns them
-- and a backfill writes them in bulk. Four writers cannot be relied on
-- to agree, and the one that forgets is the one that silently breaks
-- the reminder.
create or replace function tasks_track_assignment() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.assigned_to is not null then
      new.assigned_at := coalesce(new.assigned_at, now());
    end if;
  elsif new.assigned_to is distinct from old.assigned_to then
    -- Unassigning clears it: an ownerless task is new to nobody.
    new.assigned_at := case when new.assigned_to is null then null else now() end;
  end if;
  return new;
end $$;

drop trigger if exists trg_tasks_assignment on tasks;
create trigger trg_tasks_assignment before insert or update of assigned_to on tasks
  for each row execute function tasks_track_assignment();

-- "What is new for me" is the reminder's only question of this column.
create index if not exists idx_tasks_assigned_at on tasks(org_id, assigned_to, assigned_at desc)
  where assigned_to is not null;
