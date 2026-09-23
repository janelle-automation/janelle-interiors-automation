-- ============================================================
--  0019 · One message, however many mailboxes it lands in
--
--  Mail was deduped on gmail_id, which is Gmail's id for a
--  message IN ONE MAILBOX. That was sufficient while one shared
--  address fed the studio.
--
--  With members connecting their own Google it stops working
--  entirely: a vendor who writes to systems@ and copies Brianna
--  produces the SAME message with a DIFFERENT gmail_id in each
--  mailbox, so the studio stored it twice, paid Claude to read
--  it twice, and risked raising the same task twice.
--
--  message_id is the RFC 5322 Message-ID the sender stamped on
--  it. It is identical in every mailbox it reaches, which makes
--  it the only honest answer to "have we already seen this?".
--
--  Deliberately NOT unique. A personal copy has to exist as its
--  own row or its owner could not see it — row security hides
--  another member's copy from them (0018). The index makes the
--  check cheap; the reading pass decides what to do about it.
-- ============================================================

alter table emails add column if not exists message_id text;

create index if not exists idx_emails_message on emails(org_id, message_id)
  where message_id is not null;
