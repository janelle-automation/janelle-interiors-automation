-- ============================================================
--  0002 · Tasks
--  Internal work items raised from email by the ingest pipeline
--  and assigned to a person by role.
-- ============================================================

do $$ begin
  create type task_kind as enum
    ('quote_request','order_followup','client_approval','spec_review','scheduling','admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type task_status as enum ('open','in_progress','blocked','done','cancelled');
exception when duplicate_object then null; end $$;

create table if not exists tasks (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  title           text not null,
  detail          text,
  kind            task_kind not null default 'admin',
  status          task_status not null default 'open',
  assigned_to     uuid references profiles(id) on delete set null,
  assigned_role   user_role,                                   -- role the rule targeted
  project_id      uuid references projects(id) on delete set null,
  vendor_id       uuid references vendors(id) on delete set null,
  source_email_id uuid references emails(id) on delete cascade, -- null for manual tasks
  due_date        date,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_tasks_org      on tasks(org_id);
create index if not exists idx_tasks_status   on tasks(org_id, status);
create index if not exists idx_tasks_assignee on tasks(org_id, assigned_to);

-- One task per source email, so re-promoting never duplicates work.
create unique index if not exists uq_tasks_source_email
  on tasks(org_id, source_email_id) where source_email_id is not null;

-- Keep updated_at current, matching every other mutable table.
drop trigger if exists trg_tasks_updated on tasks;
create trigger trg_tasks_updated before update on tasks
  for each row execute function set_updated_at();

-- Org scoping. Migration 0004 replaces this with per-verb, role-aware
-- policies; this keeps the table protected in the meantime, so the schema
-- is never left readable across orgs between migrations.
alter table tasks enable row level security;
drop policy if exists tasks_org_all on tasks;
create policy tasks_org_all on tasks
  for all using (org_id = current_org_id())
  with check (org_id = current_org_id());
