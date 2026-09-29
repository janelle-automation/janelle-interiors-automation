-- A draft's real Gmail message id, alongside the Gmail draft id (gmail_draft_id)
-- baseline already carries. The draft id lets the app update or delete the
-- live draft later; the message id is what a "#all/<id>" link opens, so
-- "Open in Gmail" can point at the actual draft instead of a blank compose
-- window with no thread and no history behind it.
alter table drafts add column if not exists gmail_message_id text;
