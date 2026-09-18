-- ============================================================
--  Seed data — the PROMPT LIBRARY only. No demo vendors, projects,
--  or purchase orders: real records come from live ingestion.
--  Idempotent and safe to run once on a fresh database.
-- ============================================================

do $$
declare
  org uuid;
begin
  -- Reuse an existing organization if one exists (e.g. created when
  -- the first user signs in); otherwise create the studio org.
  select id into org from organizations order by created_at limit 1;
  if org is null then
    insert into organizations (name, settings)
    values ('Janelle Interiors', jsonb_build_object(
      'vendor_silence_days', 3,
      'client_approval_days', 5,
      'report_day', 'monday'
    ))
    returning id into org;
  end if;

  -- Prompt library — only insert if this org has no prompts yet.
  if not exists (select 1 from prompts where org_id = org) then
    insert into prompts (org_id, title, category, description, template, variables) values
      (org, 'Concept narrative', 'design',
       'Turn a brief and mood into a client-ready concept paragraph.',
       'Write a warm, confident concept narrative for {{project}}. Client: {{client}}. Mood and materials: {{mood}}. Keep it to two short paragraphs in the studio voice.',
       '[{"key":"project","label":"Project","required":true},{"key":"client","label":"Client","required":true},{"key":"mood","label":"Mood & materials","required":true}]'),

      (org, 'Material & finish spec', 'design',
       'Draft a structured spec entry for a single item.',
       'Draft a material/finish specification for {{item}} on {{project}}. Include material, finish, dimensions, and any note the maker needs. Flag anything still unknown.',
       '[{"key":"item","label":"Item","required":true},{"key":"project","label":"Project","required":true}]'),

      -- 'Purchase order draft' and 'Vendor option comparison' used to sit here.
      -- They now live in scripts/prompt-library.mjs with the rest of the
      -- procurement library, because a purchase order needs an order number,
      -- a sidemark and a ship-to, and two copies of that prompt drift apart.
      -- Load them with `npm run seed-prompts`.

      (org, 'Client approval request', 'client',
       'Ask the client to approve a selection, clearly and briefly.',
       'Write a short approval request to {{client}} for {{item}} on {{project}}. State the decision needed, the deadline {{deadline}}, and what happens next.',
       '[{"key":"client","label":"Client","required":true},{"key":"item","label":"Item","required":true},{"key":"project","label":"Project","required":true},{"key":"deadline","label":"Deadline","required":false}]'),

      (org, 'Weekly client update', 'client',
       'A friendly status note to the client.',
       'Write a brief weekly update to {{client}} for {{project}}. Cover what moved this week, what we are waiting on from them, and the next milestone. Warm and concise.',
       '[{"key":"client","label":"Client","required":true},{"key":"project","label":"Project","required":true}]'),

      (org, 'Meeting notes to actions', 'admin',
       'Convert rough notes into owners and next steps.',
       'Turn these meeting notes into a tidy summary with clear action items, each with an owner and due date:\n{{notes}}',
       '[{"key":"notes","label":"Raw notes","required":true}]'),

      (org, 'Project status summary', 'admin',
       'A one-paragraph internal status for a project.',
       'Summarize the current status of {{project}} in one paragraph for the internal stand-up: stage, blockers, and what needs a decision.',
       '[{"key":"project","label":"Project","required":true}]');
  end if;

  raise notice 'Prompt library ensured for organization %', org;
end $$;
