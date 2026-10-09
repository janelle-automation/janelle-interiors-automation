-- ============================================================
--  0036 · Where the address itself came from
--
--  0035 resolved a city from the IP the API observed. That works
--  in production, where nginx forwards the caller's address —
--  and not at all anywhere the API is reached directly, where
--  every sign-in observes ::1 and the Location column reads
--  "Same machine" forever.
--
--  So the browser may now report its own public address, and the
--  API falls back to it when what IT saw was loopback or a
--  private LAN address. That is a weaker fact: the server
--  watched the connection arrive, whereas the browser merely
--  says where it is. A five-person studio's sign-in log can
--  carry a client-asserted address — it cannot carry one
--  SILENTLY, because an audit row that does not say how it knows
--  something is worth less than no row.
--
--  Hence this column. 'server' — observed on the connection,
--  trustworthy. 'client' — reported by the browser, plausible.
-- ============================================================

alter table login_events add column if not exists ip_source text
  check (ip_source is null or ip_source in ('server', 'client'));

comment on column login_events.ip_source is
  'server = the API observed this address on the connection. client = the browser reported it, used only when the observed address was private or loopback. Null for rows written before 0036.';
