-- ============================================================
--  0003 · Morning digest + the SLA follow-up types
--  The push side of the system: what is overdue, who owns it,
--  and what needs the principal — assembled every morning so
--  nobody has to log in to find out.
-- ============================================================

-- The `do $$ ... exception when duplicate_object` idiom used for enums in
-- 0001 only guards CREATE; it cannot extend an existing type. These two
-- follow-up types come from the studio's own service levels:
--   · a quote unresolved beyond 2 days  → tell the client where it stands
--   · a client left waiting beyond 24h  → nudge the owner internally
--
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block on some
-- PostgreSQL versions, so the migration runner executes this file outside
-- one (see scripts/db-apply.mjs).
alter type follow_up_type add value if not exists 'quote_overdue';
alter type follow_up_type add value if not exists 'client_waiting';

create table if not exists digests (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  digest_date   date not null,
  figures       jsonb,                                     -- counts + the rows behind them
  narrative     text,                                      -- the short human summary
  escalations   jsonb not null default '[]'::jsonb,        -- items needing the principal
  draft_id      uuid,                                      -- drafts row, when one was prepared
  created_at    timestamptz not null default now()
);

-- One digest per org per day; the generator upserts on this.
create unique index if not exists uq_digests_date on digests(org_id, digest_date);

-- Org scoping; superseded by the per-verb policies in 0004.
alter table digests enable row level security;
drop policy if exists digests_org_all on digests;
create policy digests_org_all on digests
  for all using (org_id = current_org_id())
  with check (org_id = current_org_id());
