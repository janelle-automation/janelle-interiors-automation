-- ============================================================
--  0007 · Dynamic module access, enforced in the database
--
--  OPTIONAL HARDENING — the Permissions screen already works without
--  this. 0004 hard-coded who may write what in a SQL CASE that had to
--  be kept in step with a TypeScript table by hand, so granting one
--  extra module meant a code change and a deploy.
--
--  The grants themselves live in `organizations.settings ->
--  'role_permissions'`: a JSON map keyed "role:resource:action", written
--  by the API through the ordinary Supabase connection. No new table, no
--  second database credential, editable the moment the app runs.
--
--  What this migration adds is the SECOND enforcement layer: it teaches
--  row-level security to read those same grants, so a module the UI has
--  taken away is one Postgres also refuses. Until it is applied the API
--  still enforces every grant — the database just falls back to the
--  static defaults from 0004.
-- ============================================================

-- ────────────────────────────────────────────────────────────
--  Let a principal change other people's roles.
--
--  0001 gave `profiles` only `profiles_update_self` (id = auth.uid()), so
--  a principal updating someone else's row matched nothing at all — the
--  role dropdown on Team & Roles silently changed nobody. The API now does
--  that write with the service-role key, which is what makes the screen
--  work today; this policy makes the database agree, so the rule holds even
--  for a direct client call.
-- ────────────────────────────────────────────────────────────
drop policy if exists profiles_update_by_principal on profiles;
create policy profiles_update_by_principal on profiles
  for update using (
    org_id = current_org_id() and current_user_role() = 'principal'
  )
  with check (
    org_id = current_org_id() and current_user_role() = 'principal'
  );

-- ────────────────────────────────────────────────────────────
--  Table → module. Several tables belong to one module: line items are
--  part of a purchase order, and nobody thinks of them separately.
--  A null means "not a module" — prompt runs and the audit log are
--  written as a side effect of using the system and stay open to any
--  member, exactly as they were in 0004.
-- ────────────────────────────────────────────────────────────
create or replace function resource_for_table(tbl text)
returns text language sql immutable as $fn$
  select case tbl
    when 'projects'        then 'projects'
    when 'spec_gaps'       then 'spec_gaps'
    when 'vendors'         then 'vendors'
    when 'purchase_orders' then 'purchase_orders'
    when 'line_items'      then 'purchase_orders'
    when 'documents'       then 'documents'
    when 'emails'          then 'emails'
    when 'tasks'           then 'tasks'
    when 'follow_ups'      then 'follow_ups'
    when 'drafts'          then 'drafts'
    when 'prompts'         then 'prompts'
    when 'reports'         then 'reports'
    when 'digests'         then 'digests'
    else null
  end;
$fn$;

-- The default matrix — the exact mirror of WRITERS / can() in
-- packages/shared/src/index.ts. CHANGE BOTH TOGETHER.
create or replace function default_can(r user_role, res text, act text)
returns boolean language sql immutable as $fn$
  select case
    when r is null then false
    -- Reads stay open to the whole org: a five-person studio needs to see
    -- its own work, and that visibility is the point of the system.
    when act = 'read' then true
    -- Deleting is destructive and rare: the two accountable roles only,
    -- and only where they could write in the first place.
    when act = 'delete' and r not in ('principal', 'coordinator') then false
    else case res
      when 'projects'        then r in ('principal','coordinator','designer')
      when 'spec_gaps'       then r in ('principal','coordinator','designer','procurement','assistant')
      when 'vendors'         then r in ('principal','coordinator','procurement')
      when 'purchase_orders' then r in ('principal','coordinator','procurement')
      when 'documents'       then r in ('principal','coordinator','designer','procurement','assistant')
      when 'emails'          then r in ('principal','coordinator')
      when 'tasks'           then r in ('principal','coordinator','designer','procurement','assistant')
      when 'follow_ups'      then r in ('principal','coordinator','procurement')
      when 'drafts'          then r in ('principal','coordinator','designer','procurement','assistant')
      when 'prompts'         then r in ('principal','coordinator','designer')
      when 'reports'         then r in ('principal','coordinator')
      when 'digests'         then r in ('principal','coordinator')
      when 'team'            then r = 'principal'
      when 'settings'        then r = 'principal'
      when 'ops'             then r in ('principal','coordinator')
      else false
    end
  end;
$fn$;

-- Cells that may never be revoked, so a studio cannot lock itself out of
-- its own permission screen. Mirrors isLockedPermission() in shared.
create or replace function permission_is_locked(r user_role, res text, act text)
returns boolean language sql immutable as $fn$
  select act = 'read' or (r = 'principal' and res in ('team', 'settings'));
$fn$;

-- The studio's own answer for one cell, or null where it has not set one.
-- Reads the same JSON the Permissions screen writes.
create or replace function permission_override(r user_role, res text, act text)
returns boolean language sql stable security definer set search_path = public as $fn$
  select (o.settings -> 'role_permissions' ->> (r::text || ':' || res || ':' || act))::boolean
    from organizations o
   where o.id = current_org_id();
$fn$;

-- The live answer: the studio's override where it has one, else the default.
create or replace function can_act(tbl text, act text)
returns boolean language sql stable security definer set search_path = public as $fn$
  select case
    when current_user_role() is null then false
    when resource_for_table(tbl) is null then true  -- prompt runs, audit log
    when permission_is_locked(current_user_role(), resource_for_table(tbl), act)
      then default_can(current_user_role(), resource_for_table(tbl), act)
    else coalesce(
      permission_override(current_user_role(), resource_for_table(tbl), act),
      default_can(current_user_role(), resource_for_table(tbl), act))
  end;
$fn$;

-- Kept so anything still calling the 0004 helper keeps working, now
-- answering from the same dynamic source.
create or replace function can_write(tbl text)
returns boolean language sql stable security definer set search_path = public as $fn$
  select can_act(tbl, 'update');
$fn$;

-- ────────────────────────────────────────────────────────────
--  Re-issue the per-verb policies against can_act, so granting or
--  revoking a module takes effect in the database and not just the UI.
--  The services still run under the service-role key and bypass all of
--  this: the agent must write regardless of who is signed in.
-- ────────────────────────────────────────────────────────────
do $mig$
declare t text;
begin
  foreach t in array array[
    'projects','vendors','purchase_orders','line_items','documents','emails',
    'follow_ups','drafts','spec_gaps','reports','prompts','prompt_runs','activity_log',
    'tasks','digests'
  ] loop
    execute format('drop policy if exists %1$s_org_select on %1$s;', t);
    execute format('drop policy if exists %1$s_org_insert on %1$s;', t);
    execute format('drop policy if exists %1$s_org_update on %1$s;', t);
    execute format('drop policy if exists %1$s_org_delete on %1$s;', t);

    execute format(
      'create policy %1$s_org_select on %1$s
         for select using (org_id = current_org_id() and can_act(%1$L, ''read''));', t);
    execute format(
      'create policy %1$s_org_insert on %1$s
         for insert with check (org_id = current_org_id() and can_act(%1$L, ''create''));', t);
    execute format(
      'create policy %1$s_org_update on %1$s
         for update using (org_id = current_org_id() and can_act(%1$L, ''update''))
         with check (org_id = current_org_id() and can_act(%1$L, ''update''));', t);
    execute format(
      'create policy %1$s_org_delete on %1$s
         for delete using (org_id = current_org_id() and can_act(%1$L, ''delete''));', t);
  end loop;
end $mig$;
