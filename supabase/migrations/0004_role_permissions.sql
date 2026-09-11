-- ============================================================
--  0004 · Role-aware permissions
--  Replaces the permissive `<table>_org_all` policy from 0001,
--  which let any member of an org write any table — an assistant
--  could delete a purchase order.
--
--  Reads stay open to the whole org: a five-person studio needs
--  to see its own work, and that visibility is the point of the
--  system. What is restricted is changing money, changing other
--  people's assignments, and changing the studio's rules.
-- ============================================================

-- Mirrors the WRITERS table in packages/shared/src/index.ts.
-- CHANGE BOTH TOGETHER, or the UI will offer actions the database refuses.
create or replace function can_write(tbl text)
returns boolean language sql stable security definer set search_path = public as $$
  select case tbl
    when 'projects'        then current_user_role() in ('principal','coordinator','designer')
    when 'vendors'         then current_user_role() in ('principal','coordinator','procurement')
    when 'purchase_orders' then current_user_role() in ('principal','coordinator','procurement')
    when 'line_items'      then current_user_role() in ('principal','coordinator','procurement')
    when 'spec_gaps'       then current_user_role() in ('principal','coordinator','designer','procurement')
    when 'emails'          then current_user_role() in ('principal','coordinator')
    when 'follow_ups'      then current_user_role() in ('principal','coordinator')
    when 'reports'         then current_user_role() in ('principal','coordinator')
    when 'digests'         then current_user_role() in ('principal','coordinator')
    when 'prompts'         then current_user_role() in ('principal','coordinator','designer')
    else current_user_role() is not null   -- tasks, drafts, documents, prompt_runs, activity_log
  end;
$$;

-- Org-scoped policies, split by verb so writes can be role-gated.
-- NOTE: the services run under the Supabase service-role key and bypass RLS
-- entirely, so ingestion, follow-ups, the digest and the weekly report are
-- unaffected by these restrictions — the agent must write regardless of who
-- happens to be signed in.
do $$
declare t text;
begin
  foreach t in array array[
    'projects','vendors','purchase_orders','line_items','documents','emails',
    'follow_ups','drafts','spec_gaps','reports','prompts','prompt_runs','activity_log',
    'tasks','digests'
  ] loop
    -- Drop the permissive policy from 0001-0003 and any previous run of
    -- this migration, so the block stays re-runnable.
    execute format('drop policy if exists %1$s_org_all on %1$s;', t);
    execute format('drop policy if exists %1$s_org_select on %1$s;', t);
    execute format('drop policy if exists %1$s_org_insert on %1$s;', t);
    execute format('drop policy if exists %1$s_org_update on %1$s;', t);
    execute format('drop policy if exists %1$s_org_delete on %1$s;', t);

    execute format(
      'create policy %1$s_org_select on %1$s
         for select using (org_id = current_org_id());', t);
    execute format(
      'create policy %1$s_org_insert on %1$s
         for insert with check (org_id = current_org_id() and can_write(%1$L));', t);
    execute format(
      'create policy %1$s_org_update on %1$s
         for update using (org_id = current_org_id() and can_write(%1$L))
         with check (org_id = current_org_id() and can_write(%1$L));', t);
    -- Deletion is destructive and rare: the two accountable roles only.
    execute format(
      'create policy %1$s_org_delete on %1$s
         for delete using (
           org_id = current_org_id()
           and can_write(%1$L)
           and current_user_role() in (''principal'',''coordinator'')
         );', t);
  end loop;
end $$;
