-- ============================================================
--  0013 · Where a project is, and what the studio calls its state
--
--  The studio's live work has been tracked in a Google Sheet
--  ("Janelle Interior: Project List"), not in here. Bringing
--  those 27 projects across turned up two columns the schema
--  has nowhere to put:
--
--  LOCATION. Ojai, Ventura, Oxnard, New York. The sheet has it
--  for most projects and the schema has it for none, so it was
--  either a new column or a sentence in `notes` that nothing
--  could filter on. Projects cluster hard by town here — a
--  dozen of them are the same Ojai hotel — so "show me Ojai"
--  is a question worth being able to ask.
--
--  SHEET STATUS. The sheet says Open or In Progress. The
--  pipeline enum says lead → concept → spec → approval → po →
--  production → shipping → install → complete. These are not
--  the same vocabulary and neither is a subset of the other:
--  "In Progress" covers everything from a spec still being
--  drawn to furniture on a truck. Guessing a stage per project
--  would have written 27 plausible-looking wrong answers into
--  the pipeline view.
--
--  So the sheet's own word is kept verbatim and `stage` is left
--  at its 'lead' default, to be set by a person who knows which
--  project is actually where. Once every project has a real
--  stage this column is dead weight and can be dropped; until
--  then it is the only honest record of what the studio said.
-- ============================================================

-- As the sheet writes it: "Ojai, CA", "Ojai, California",
-- "Ventura, California". Not normalized on the way in — the
-- studio's own spelling is what someone will search for, and
-- collapsing "CA" and "California" is a decision for whoever
-- builds that search, not for the import.
alter table projects add column if not exists location text;

-- 'Open' or 'In Progress', exactly as the sheet has it. Null
-- for any project that did not come from the sheet.
alter table projects add column if not exists sheet_status text;

-- The import matches on name to avoid duplicating a project on
-- a re-run, so the name has to actually be unique within a
-- studio. Guarded the same way 0011 guards vendors: this was
-- never enforced, ingestion has been creating projects from
-- email for months, and a plain CREATE would fail the whole
-- migration on a database that already holds a duplicate pair.
-- Merging them is a judgement call (tasks, POs and spec gaps
-- all point at one of the pair) so it is left to a person.
do $$
declare
  dupes int;
begin
  select count(*) into dupes from (
    select 1 from projects group by org_id, lower(trim(name)) having count(*) > 1
  ) d;

  if dupes > 0 then
    raise warning
      'projects: % duplicate name group(s) found — unique index NOT created. Merge them, then re-run this file.',
      dupes;
  else
    execute 'create unique index if not exists uq_projects_org_name on projects (org_id, lower(trim(name)))';
  end if;
end $$;
