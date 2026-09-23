-- ============================================================
--  0020 · The shared mailbox belongs to the shared mailbox
--
--  0018 gave mail an owner and left everything already read
--  unowned, so it stayed readable by the whole studio. The
--  reasoning was that systems@ is the studio's own address and
--  its history is the studio's history.
--
--  In practice that is not how it lands. Somebody invited
--  today signs in and is shown months of correspondence they
--  had no part in — every quote, every client thread, every
--  reply drafted for somebody else — before they have
--  contributed a single message of their own.
--
--  So systems@ is treated as what it is: one mailbox, with one
--  owner. Its account still sees all of it, and anyone signing
--  in as the studio address still sees the whole history.
--  Everyone else sees their own mail, once they connect it.
--
--  Nothing is deleted and nothing moves. Only who may read it
--  changes, through the policies 0018 already installed.
-- ============================================================

update emails e
   set owner_id = p.id
  from profiles p
 where p.email = 'systems@janelleinteriors.com'
   and e.org_id = p.org_id
   and e.owner_id is null;

-- Reply drafts the reading pass wrote off that mailbox go with it. A draft
-- somebody saved by hand has `created_by` set and is left alone — it is
-- their own work, not the shared mailbox's.
update drafts d
   set owner_id = p.id
  from profiles p
 where p.email = 'systems@janelleinteriors.com'
   and d.org_id = p.org_id
   and d.owner_id is null
   and d.created_by is null;
