-- ============================================================
--  0018 · Each member's own mail, kept their own
--
--  Until now one mailbox fed the whole studio: systems@, a
--  shared address, read on behalf of everyone. That worked
--  because nothing in it was private — it belongs to the
--  studio, not to a person.
--
--  Letting team members connect their OWN Google changes that
--  completely. Brianna's mailbox has her bank, her doctor and
--  her family in it, and org-wide row security would have put
--  all of it in front of Carissa the moment she connected.
--
--  owner_id  null  → the shared studio mailbox, readable by the
--                    studio exactly as before.
--            uuid  → one person's own mail. Only they can read
--                    it — principals included. Oversight is not
--                    a reason to read someone's private mail,
--                    and the work itself is still shared: the
--                    tasks raised from a message stay on the
--                    board where everyone can see them.
--
--  Drafts carry the same mark. A draft is a reply that quotes
--  the thread it answers, so a shared draft off a private email
--  would hand over the very words the column exists to protect.
-- ============================================================

alter table emails add column if not exists owner_id uuid references profiles(id) on delete set null;
alter table drafts add column if not exists owner_id uuid references profiles(id) on delete set null;

-- "What is mine" is the only question these columns are asked.
create index if not exists idx_emails_owner on emails(org_id, owner_id);
create index if not exists idx_drafts_owner on drafts(org_id, owner_id);

-- Everything already read came from the shared mailbox, so it stays shared:
-- a backfill that claimed it for one person would hide the studio's own
-- history from the studio.

-- Replaces the generated org-wide policies from 0007 for these two tables.
-- The org and permission checks are kept exactly as they were and the owner
-- clause is added on top, so closing a module to a role still works.
drop policy if exists emails_org_select on emails;
create policy emails_org_select on emails
  for select using (
    org_id = current_org_id()
    and can_act('emails', 'read')
    and (owner_id is null or owner_id = auth.uid())
  );

drop policy if exists emails_org_update on emails;
create policy emails_org_update on emails
  for update using (
    org_id = current_org_id()
    and can_act('emails', 'update')
    and (owner_id is null or owner_id = auth.uid())
  );

drop policy if exists emails_org_delete on emails;
create policy emails_org_delete on emails
  for delete using (
    org_id = current_org_id()
    and can_act('emails', 'delete')
    and (owner_id is null or owner_id = auth.uid())
  );

drop policy if exists drafts_org_select on drafts;
create policy drafts_org_select on drafts
  for select using (
    org_id = current_org_id()
    and can_act('drafts', 'read')
    and (owner_id is null or owner_id = auth.uid())
  );

drop policy if exists drafts_org_update on drafts;
create policy drafts_org_update on drafts
  for update using (
    org_id = current_org_id()
    and can_act('drafts', 'update')
    and (owner_id is null or owner_id = auth.uid())
  );

drop policy if exists drafts_org_delete on drafts;
create policy drafts_org_delete on drafts
  for delete using (
    org_id = current_org_id()
    and can_act('drafts', 'delete')
    and (owner_id is null or owner_id = auth.uid())
  );
