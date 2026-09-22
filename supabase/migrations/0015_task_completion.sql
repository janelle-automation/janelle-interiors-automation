-- ============================================================
--  0015 · When a task was finished, and why the system closed it
--
--  A task only ever left the board when somebody dragged it to
--  Done. Work finished early — the vendor sent the quote, the
--  client approved — sat in Open until its date passed, and was
--  then chased as overdue. The reading pass now closes a task
--  when a new email shows its work is done, and says why.
--
--  completed_at    when it moved to Done, by anyone. The Done
--                  column is ordered by it, and "finished two
--                  days early" is read from it against due_date.
--  completion_note set only when the system closed it: which
--                  email, and the words in it that finished it.
-- ============================================================

alter table tasks add column if not exists completed_at timestamptz;
alter table tasks add column if not exists completion_note text;

-- Work already done: its last change is the best record of when.
update tasks
   set completed_at = updated_at
 where status = 'done'
   and completed_at is null;

-- Kept here rather than in each caller, so the board, Jenny and the
-- reading pass cannot disagree about it. Reopening a task clears both:
-- a note saying the system closed it would be false once a person
-- has said the work is not finished.
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
  end if;
  return new;
end $$;

drop trigger if exists trg_tasks_completion on tasks;
create trigger trg_tasks_completion before insert or update of status on tasks
  for each row execute function tasks_track_completion();

create index if not exists idx_tasks_completed on tasks(org_id, completed_at desc)
  where status = 'done';
