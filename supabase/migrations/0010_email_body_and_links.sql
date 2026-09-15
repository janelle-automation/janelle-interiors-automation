-- ============================================================
--  0010 · Keep the email, not just the summary
--
--  Ingestion fetched each message body, handed it to Claude,
--  and threw it away — only Gmail's ~100 character `snippet`
--  was stored. Anything the extraction did not happen to pull
--  out was then unrecoverable: the assistant was asked for the
--  Canva link in a designer's email, and could only answer that
--  the system had not parsed one, because the text containing
--  it no longer existed anywhere.
--
--  Links get a column of their own rather than being re-read
--  out of the body each time. They are what people actually ask
--  for — a Canva board, a Drive folder, a tracking page — and a
--  short list of URLs can be handed to the assistant for almost
--  no tokens, where the whole body cannot.
-- ============================================================

-- The readable text of the message, capped on write. Enough to
-- answer a question about what someone actually said.
alter table emails add column if not exists body_text text;

-- [{ "url": "...", "host": "canva.link" }] — extracted with a
-- regex on ingest, so it costs nothing and cannot hallucinate.
alter table emails add column if not exists links jsonb not null default '[]'::jsonb;
