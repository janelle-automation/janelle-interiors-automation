-- ============================================================
--  0033 · Comments on a task, and the end of subtasks
--
--  The task panel offered "Add a step…" and nothing else. A task
--  raised from an email is a conversation — who is chasing it,
--  what the vendor said on the phone, who needs to pick it up —
--  and none of that had anywhere to go except `detail`, which is
--  the extractor's field and is overwritten when the mail is
--  re-read. So the studio talked about tasks in Slack and email,
--  where the task could not see it.
--
--  Two tables rather than a `mentions uuid[]` column on the
--  comment: "what have I been pulled into, and have I seen it"
--  is a per-person question with per-person state, and an array
--  cannot hold a read mark. A row can.
--
--  SUBTASKS ARE REMOVED. Asked for explicitly on 2026-10-08; the
--  section is replaced by comments. The rows go, the column goes.
--  This is not reversible — hence the archive below, which copies
--  every deleted row into activity_log first so the trail exists
--  even though the work does not.
-- ============================================================

create table if not exists task_comments (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  task_id    uuid not null references tasks(id) on delete cascade,
  -- The comment outlives the account: someone leaving the studio must not
  -- silently rewrite the history of a job. Null reads as "a former member".
  author     uuid references profiles(id) on delete set null,
  body       text not null check (length(btrim(body)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The panel reads one task's thread, oldest first.
create index if not exists idx_task_comments_task on task_comments(org_id, task_id, created_at);

/*
 * Who was pulled in, and whether they have looked.
 *
 * Its own table so the bell can ask one indexed question — "my rows where
 * read_at is null" — instead of scanning every comment in the studio for an
 * id inside an array.
 */
create table if not exists task_comment_mentions (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  comment_id uuid not null references task_comments(id) on delete cascade,
  task_id    uuid not null references tasks(id) on delete cascade,
  user_id    uuid not null references profiles(id) on delete cascade,
  read_at    timestamptz,
  created_at timestamptz not null default now(),
  -- Naming someone twice in one comment is one mention, not two.
  unique (comment_id, user_id)
);

-- The bell's only question. Partial: a mention already read is of no
-- interest to it, and most of them will be read.
create index if not exists idx_task_mentions_unread
  on task_comment_mentions(org_id, user_id, created_at desc)
  where read_at is null;

-- Same org-scoped policy the baseline stamps on every operational table.
alter table task_comments enable row level security;
drop policy if exists task_comments_org_all on task_comments;
create policy task_comments_org_all on task_comments
  for all using (org_id = current_org_id())
  with check (org_id = current_org_id());

alter table task_comment_mentions enable row level security;
drop policy if exists task_comment_mentions_org_all on task_comment_mentions;
create policy task_comment_mentions_org_all on task_comment_mentions
  for all using (org_id = current_org_id())
  with check (org_id = current_org_id());

-- Keep updated_at current, matching every other mutable table.
drop trigger if exists trg_task_comments_updated on task_comments;
create trigger trg_task_comments_updated before update on task_comments
  for each row execute function set_updated_at();

-- ── Subtasks, removed ────────────────────────────────────────
--
-- Guarded on the column existing so this migration is safe to run against
-- a database that never had 0009 applied.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'tasks'
       and column_name = 'parent_task_id'
  ) then
    -- The trail, written before the rows go. One entry per org, holding
    -- every subtask's title and parent, so "what was deleted on the 8th"
    -- has an answer that does not depend on a backup.
    insert into activity_log (org_id, action, entity, meta)
    select t.org_id,
           'tasks.subtasks_removed',
           'tasks',
           jsonb_build_object(
             'count', count(*),
             'migration', '0033',
             'rows', jsonb_agg(jsonb_build_object(
               'id', t.id, 'title', t.title, 'status', t.status,
               'parent_task_id', t.parent_task_id, 'assigned_to', t.assigned_to,
               'due_date', t.due_date, 'created_at', t.created_at))
           )
      from tasks t
     where t.parent_task_id is not null
     group by t.org_id;

    delete from tasks where parent_task_id is not null;

    drop index if exists idx_tasks_parent;
    alter table tasks drop column parent_task_id;
  end if;
end $$;
