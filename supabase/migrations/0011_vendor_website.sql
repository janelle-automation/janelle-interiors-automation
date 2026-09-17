-- ============================================================
--  0011 · Where a vendor actually lives
--
--  Vendors arrived only as a by-product of ingestion: a name
--  lifted off a quote and whatever address happened to send it.
--  There was nowhere to record that Houzz is houzz.com, so the
--  one fact you need to go place an order — the site itself —
--  lived in someone's bookmarks instead of the directory.
--
--  The studio can now add a vendor by hand, which makes a
--  second gap matter. `upsertVendor` in services/promote.ts
--  dedupes on a normalized name, but nothing stopped a person
--  typing a vendor the ingest had already created. The name is
--  the only handle anyone has on a vendor, so it is the thing
--  that has to stay unique.
-- ============================================================

-- The vendor's own site. Stored as entered; the API normalizes
-- a bare "houzz.com" to a URL before it gets here.
alter table vendors add column if not exists website text;

-- One row per vendor name, case-insensitively, within an org.
--
-- Guarded: this schema never enforced it, so a database that has
-- been ingesting for a while may already hold duplicates that a
-- plain CREATE would choke on. Merging them is not safe to do
-- unattended — purchase_orders.vendor_id points at one of the
-- pair, and picking the survivor is a judgement call — so when
-- duplicates exist the index is skipped and the migration says
-- so rather than failing the whole run.
do $$
declare
  dupes int;
begin
  select count(*) into dupes from (
    select 1 from vendors group by org_id, lower(trim(name)) having count(*) > 1
  ) d;

  if dupes > 0 then
    raise warning
      'vendors: % duplicate name group(s) found — unique index NOT created. Merge them, then re-run this file.',
      dupes;
  else
    execute 'create unique index if not exists uq_vendors_org_name on vendors (org_id, lower(trim(name)))';
  end if;
end $$;
