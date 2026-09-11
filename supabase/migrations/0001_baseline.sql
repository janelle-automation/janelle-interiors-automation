-- ============================================================
--  Janelle Interiors AI Workflow System
--  Supabase / Postgres schema  ·  Milestone M0 (Foundation)
--  Run in the Supabase SQL editor, or via `supabase db push`.
-- ============================================================

create extension if not exists "pgcrypto";

-- ────────────────────────────────────────────────────────────
--  Enumerations
-- ────────────────────────────────────────────────────────────
do $$ begin
  create type user_role as enum ('principal', 'designer', 'procurement', 'coordinator', 'assistant');
exception when duplicate_object then null; end $$;

do $$ begin
  create type project_stage as enum
    ('lead','concept','spec','approval','po','production','shipping','install','complete');
exception when duplicate_object then null; end $$;

do $$ begin
  create type po_status as enum
    ('draft','placed','confirmed','in_production','shipped','received','cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type follow_up_type as enum
    ('vendor_silence','client_approval_overdue','date_slipping','spec_gap');
exception when duplicate_object then null; end $$;

do $$ begin
  create type follow_up_status as enum ('open','drafted','sent','dismissed','done');
exception when duplicate_object then null; end $$;

do $$ begin
  create type email_class as enum
    ('vendor_quote','order_confirmation','client_approval','houzz_notification','general','unclassified');
exception when duplicate_object then null; end $$;

do $$ begin
  create type document_type as enum ('quote','purchase_order','order_confirmation','other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type prompt_category as enum ('design','procurement','client','admin');
exception when duplicate_object then null; end $$;

-- ────────────────────────────────────────────────────────────
--  updated_at trigger
-- ────────────────────────────────────────────────────────────
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ────────────────────────────────────────────────────────────
--  Core tables
-- ────────────────────────────────────────────────────────────

-- Organizations (the studio; supports multi-tenant if ever needed)
create table if not exists organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Profiles — one row per team member, linked to Supabase auth
create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  org_id      uuid not null references organizations(id) on delete cascade,
  full_name   text,
  email       text,
  role        user_role not null default 'assistant',
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_profiles_org on profiles(org_id);

-- Projects
create table if not exists projects (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  name           text not null,
  client_name    text,
  stage          project_stage not null default 'lead',
  status         text not null default 'active',           -- active | on_hold | archived
  budget         numeric(12,2),
  start_date     date,
  target_install date,
  assigned_to    uuid references profiles(id) on delete set null,
  houzz_ref      text,                                     -- id from Houzz Pro CSV import
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_projects_org   on projects(org_id);
create index if not exists idx_projects_stage on projects(org_id, stage);

-- Vendors
create table if not exists vendors (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  name        text not null,
  category    text,
  contacts    jsonb not null default '[]'::jsonb,          -- [{name,email,phone}]
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_vendors_org on vendors(org_id);

-- Purchase orders
create table if not exists purchase_orders (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  po_number     text,
  project_id    uuid references projects(id) on delete set null,
  vendor_id     uuid references vendors(id) on delete set null,
  amount        numeric(12,2),
  status        po_status not null default 'draft',
  order_date    date,
  eta           date,
  received_date date,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_po_org     on purchase_orders(org_id);
create index if not exists idx_po_project on purchase_orders(project_id);
create index if not exists idx_po_vendor  on purchase_orders(vendor_id);
-- One PO per number (when a number exists): prevents duplicate POs.
create unique index if not exists uq_po_number on purchase_orders(org_id, po_number) where po_number is not null;

-- Line items on a PO
create table if not exists line_items (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  po_id       uuid not null references purchase_orders(id) on delete cascade,
  description text not null,
  sku         text,
  qty         numeric(10,2) not null default 1,
  unit_price  numeric(12,2),
  created_at  timestamptz not null default now()
);
create index if not exists idx_line_items_po on line_items(po_id);

-- Documents parsed from Drive
create table if not exists documents (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  project_id    uuid references projects(id) on delete set null,
  po_id         uuid references purchase_orders(id) on delete set null,
  drive_file_id text,
  type          document_type not null default 'other',
  parsed_json   jsonb,
  storage_path  text,
  confidence    numeric(4,3),                              -- 0.000–1.000
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_documents_org     on documents(org_id);
create index if not exists idx_documents_project on documents(project_id);
-- One row per source file: prevents duplicate parsed documents.
create unique index if not exists uq_documents_file on documents(org_id, drive_file_id) where drive_file_id is not null;

-- Emails read from Gmail
create table if not exists emails (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  gmail_id       text,
  thread_id      text,
  from_addr      text,
  to_addr        text,
  subject        text,
  snippet        text,
  received_at    timestamptz,
  project_id     uuid references projects(id) on delete set null,
  vendor_id      uuid references vendors(id) on delete set null,
  class          email_class not null default 'unclassified',
  extracted_json jsonb,
  confidence     numeric(4,3),
  created_at     timestamptz not null default now()
);
create index if not exists idx_emails_org     on emails(org_id);
create index if not exists idx_emails_project on emails(project_id);
create unique index if not exists uq_emails_gmail on emails(org_id, gmail_id);
-- Gmail draft id of an auto-drafted reply to this email (if any).
alter table emails add column if not exists reply_draft_id text;

-- Follow-ups (nudges) raised by the nightly engine
create table if not exists follow_ups (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  type        follow_up_type not null,
  project_id  uuid references projects(id) on delete cascade,
  vendor_id   uuid references vendors(id) on delete set null,
  target      text,                                        -- email address to nudge
  reason      text,
  due_date    date,
  status      follow_up_status not null default 'open',
  draft_id    uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_follow_ups_org    on follow_ups(org_id);
create index if not exists idx_follow_ups_status on follow_ups(org_id, status);

-- Gmail drafts created from follow-ups / prompt runs
create table if not exists drafts (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  gmail_draft_id text,
  follow_up_id   uuid references follow_ups(id) on delete set null,
  subject        text,
  body_preview   text,
  created_by     uuid references profiles(id) on delete set null,
  created_at     timestamptz not null default now()
);
create index if not exists idx_drafts_org on drafts(org_id);

-- Spec gaps — items missing information before they can be ordered
create table if not exists spec_gaps (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  project_id    uuid not null references projects(id) on delete cascade,
  item          text not null,
  missing_fields text[] not null default '{}',
  resolved      boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_spec_gaps_project on spec_gaps(project_id);

-- Weekly reports
create table if not exists reports (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  week_of       date not null,
  generated_json jsonb,
  narrative     text,
  storage_path  text,
  created_at    timestamptz not null default now()
);
create unique index if not exists uq_reports_week on reports(org_id, week_of);

-- Prompt library
create table if not exists prompts (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  title       text not null,
  category    prompt_category not null,
  description text,
  template    text not null,
  variables   jsonb not null default '[]'::jsonb,          -- [{key,label,required}]
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_prompts_org on prompts(org_id, category);

-- Prompt run log
create table if not exists prompt_runs (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  prompt_id   uuid references prompts(id) on delete set null,
  project_id  uuid references projects(id) on delete set null,
  user_id     uuid references profiles(id) on delete set null,
  input       jsonb,
  output      text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_prompt_runs_org on prompt_runs(org_id);

-- Google integrations (encrypted tokens live here)
create table if not exists integrations (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id) on delete cascade,
  user_id          uuid not null references profiles(id) on delete cascade,
  provider         text not null default 'google',
  encrypted_tokens text,
  scopes           text,
  status           text not null default 'disconnected',   -- connected | disconnected | error
  connected_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, provider)
);

-- Audit log
create table if not exists activity_log (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  actor       uuid references profiles(id) on delete set null,
  action      text not null,
  entity      text,
  entity_id   uuid,
  meta        jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists idx_activity_org on activity_log(org_id, created_at desc);

-- ────────────────────────────────────────────────────────────
--  updated_at triggers
-- ────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'organizations','profiles','projects','vendors','purchase_orders',
    'documents','follow_ups','spec_gaps','prompts','integrations'
  ] loop
    execute format(
      'drop trigger if exists trg_%1$s_updated on %1$s;
       create trigger trg_%1$s_updated before update on %1$s
       for each row execute function set_updated_at();', t);
  end loop;
end $$;

-- ────────────────────────────────────────────────────────────
--  RLS helper functions
-- ────────────────────────────────────────────────────────────
create or replace function current_org_id()
returns uuid language sql stable security definer set search_path = public as $$
  select org_id from profiles where id = auth.uid();
$$;

create or replace function current_user_role()
returns user_role language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid();
$$;

-- ────────────────────────────────────────────────────────────
--  Row Level Security
--  Baseline: a user may read/write rows within their own org.
--  Tighten per-role in later milestones (e.g. billing to principal).
-- ────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'organizations','profiles','projects','vendors','purchase_orders','line_items',
    'documents','emails','follow_ups','drafts','spec_gaps','reports',
    'prompts','prompt_runs','integrations','activity_log'
  ] loop
    execute format('alter table %I enable row level security;', t);
  end loop;
end $$;

-- organizations: a member sees only their own org
drop policy if exists org_select on organizations;
create policy org_select on organizations
  for select using (id = current_org_id());
drop policy if exists org_update on organizations;
create policy org_update on organizations
  for update using (id = current_org_id() and current_user_role() = 'principal');

-- profiles: members see profiles in their org; a user updates their own row
drop policy if exists profiles_select on profiles;
create policy profiles_select on profiles
  for select using (org_id = current_org_id());
drop policy if exists profiles_update_self on profiles;
create policy profiles_update_self on profiles
  for update using (id = auth.uid());

-- Generic org-scoped policy for the operational tables
do $$
declare t text;
begin
  foreach t in array array[
    'projects','vendors','purchase_orders','line_items','documents','emails',
    'follow_ups','drafts','spec_gaps','reports','prompts','prompt_runs','activity_log'
  ] loop
    execute format('drop policy if exists %1$s_org_all on %1$s;', t);
    execute format(
      'create policy %1$s_org_all on %1$s
         for all using (org_id = current_org_id())
         with check (org_id = current_org_id());', t);
  end loop;
end $$;

-- integrations: a user only ever touches their own connection
drop policy if exists integrations_own on integrations;
create policy integrations_own on integrations
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============================================================
--  End of schema
-- ============================================================
