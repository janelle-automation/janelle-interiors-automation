-- ============================================================
--  0035 · Where the sign-in came from
--
--  The history answered who, when and how, and showed a raw IP
--  for "where" — which is not an answer anybody can read. An
--  address means nothing at a glance; a city and a country are
--  what tell a principal that a sign-in is ordinary, or that it
--  is not.
--
--  Resolved once, when the attempt is recorded, and kept. Not
--  looked up when the screen is opened: a history that has to
--  call an outside service to render is a history that changes
--  its mind when the service dies, and re-resolving an address
--  months later answers where that address is NOW rather than
--  where it was. The row is evidence; it is written once.
--
--  The IP column stays. It is no longer shown, but it is the
--  thing a real investigation needs, and dropping it would
--  throw away what the location was derived FROM.
-- ============================================================

alter table login_events add column if not exists city text;
alter table login_events add column if not exists region text;
alter table login_events add column if not exists country text;
-- Two letters, for a flag or a filter later. Kept apart from the name so
-- neither has to be parsed back out of the other.
alter table login_events add column if not exists country_code text;

comment on column login_events.city is
  'Resolved from ip when the attempt was recorded, never afterwards. Null for a private or loopback address, and when the lookup failed.';
