-- ============================================================
--  0012 · The VIEW column becomes a decision, not a label
--
--  0007 locked every `read` cell: permission_is_locked() returned true for
--  any read, so the studio's own override was ignored and the Permissions
--  screen greyed the entire VIEW column out. The lock exists to stop a
--  studio locking itself out of its own permission screen — and the only
--  cells that can actually do that are the principal's own team and
--  settings rows, which stay locked here for every verb.
--
--  Mirrors isLockedPermission() in packages/shared/src/index.ts. Change both.
-- ============================================================

create or replace function permission_is_locked(r user_role, res text, act text)
returns boolean language sql immutable as $fn$
  select r = 'principal' and res in ('team', 'settings');
$fn$;

-- `act` is no longer read. Kept in the signature because can_act() calls it
-- with three arguments and the policies built in 0007 call can_act().
comment on function permission_is_locked(user_role, text, text) is
  'Cells a studio may never revoke: the principal''s own team and settings. '
  'The act argument is accepted and ignored — every verb of those two is locked.';
