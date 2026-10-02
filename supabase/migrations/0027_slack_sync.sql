-- ============================================================
--  0027 · Slack sync
--
--  Which Slack message stands for which task or follow-up, so the
--  sync can update the same thread instead of posting a new message
--  every time something changes.
--
--  One row per task / follow-up. The row is inserted BEFORE the message
--  is sent (message_ts null) — the unique key is what stops a cron run
--  and a "Sync now" click that overlap from announcing the same task
--  twice. The sync deletes a row whose send failed.
--
--  The Slack token and channel live in organizations.settings like every
--  other key (encrypted, written through merge_org_settings), not here.
-- ============================================================

create table if not exists slack_posts (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  entity      text not null check (entity in ('task', 'follow_up')),
  entity_id   uuid not null,
  channel     text not null,            -- Slack channel ID (chat.update needs the ID, not the name)
  message_ts  text,                     -- null until the message has actually been sent
  thread_ts   text,                     -- the message a reply belongs under, when it is one
  last_state  jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, entity, entity_id)
);

create index if not exists idx_slack_posts_org on slack_posts(org_id);

drop trigger if exists trg_slack_posts_updated on slack_posts;
create trigger trg_slack_posts_updated before update on slack_posts
  for each row execute function set_updated_at();

-- Read-only for the org; only the server (service role) writes.
alter table slack_posts enable row level security;
drop policy if exists slack_posts_org_read on slack_posts;
create policy slack_posts_org_read on slack_posts
  for select using (org_id = current_org_id());

-- Polled every 5 minutes, like the task review (0021). The endpoint does
-- nothing for a studio that has not connected Slack.
select cron.unschedule(jobid) from cron.job where jobname = 'slack-sync';
select cron.schedule('slack-sync', '*/5 * * * *', $$select public.call_cron_endpoint('slack-sync')$$);
