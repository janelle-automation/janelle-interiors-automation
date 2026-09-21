-- ────────────────────────────────────────────────────────────
--  0014 — media_jobs
--
--  Renderings and short video from Grok (xAI).
--
--  An image is drawn inside the request that asked for it and needs no
--  row here to be delivered — it gets one anyway, so "what have we made,
--  and what did it cost" has a single place to look.
--
--  A video cannot be: the provider takes the job, hands back a request id
--  and finishes a minute or two later, long after the serverless function
--  that started it has been killed. This table is what survives in
--  between, and what the cron sweep reads so that a clip is not lost when
--  the person who asked for it closes the tab.
-- ────────────────────────────────────────────────────────────

create table if not exists media_jobs (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  user_id       uuid not null references profiles(id) on delete cascade,
  kind          text not null check (kind in ('image','video')),
  status        text not null default 'pending'
                check (status in ('pending','done','failed','expired')),
  provider      text not null default 'xai',
  model         text not null,
  -- The provider's own id, polled until it reports done.
  request_id    text,
  prompt        text not null,
  project_id    uuid references projects(id) on delete set null,
  -- Asked for, then what was actually billed once the clip came back.
  seconds       numeric,
  -- Where the bytes ended up in the assistant-uploads bucket. The
  -- provider's own URL is temporary and is never stored.
  storage_path  text,
  mime_type     text,
  bytes         bigint,
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  polled_at     timestamptz
);

create index if not exists idx_media_jobs_org on media_jobs(org_id, created_at desc);
create index if not exists idx_media_jobs_mine on media_jobs(org_id, user_id, created_at desc);
-- The sweep reads only what is unfinished, so the index covers only that.
create index if not exists idx_media_jobs_pending on media_jobs(created_at) where status = 'pending';

-- Same org-scoped policy the baseline stamps on every operational table.
alter table media_jobs enable row level security;
drop policy if exists media_jobs_org_all on media_jobs;
create policy media_jobs_org_all on media_jobs
  for all using (org_id = current_org_id())
  with check (org_id = current_org_id());
