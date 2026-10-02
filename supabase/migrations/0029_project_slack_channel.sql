-- ============================================================
--  0029 · A project's Slack channel
--
--  Which channel a project's task and follow-up updates are posted to.
--  Null means "work it out": a channel whose name matches the project's
--  (see normalizeChannelName in services/slack.ts), and failing that the
--  studio's default channel from Settings → Slack.
--
--  Stored as typed by an admin — a channel name or a channel ID — and
--  resolved at post time, so a renamed channel needs no migration.
-- ============================================================

alter table projects add column if not exists slack_channel text;
