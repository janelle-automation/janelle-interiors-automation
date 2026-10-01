-- ============================================================
--  0026 · Task categories
--
--  A task's KIND says what is being done (chase a quote, book a
--  delivery); its CATEGORY says which part of the studio it
--  belongs to, so the list can be read as Design, FF&E,
--  Procurement & shipping, or Admin & operations. The ingest AI
--  picks it from the email; anyone can change it on the card.
--
--  Null is allowed and means "not categorised yet": the app then
--  falls back to a category worked out from seat and kind, so
--  nothing has to be backfilled by hand to look right.
-- ============================================================

alter table tasks add column if not exists category text;

do $$ begin
  alter table tasks add constraint tasks_category_check
    check (category is null or category in ('design','ffe','procurement','admin'));
exception when duplicate_object then null; end $$;

-- Existing work gets the same answer the app's fallback would give.
update tasks set category = case
    when seat::text = 'design'    then 'design'
    when seat::text = 'hotel_ffe' then 'ffe'
    when kind::text in ('spec_review','client_approval') then 'design'
    when kind::text = 'quote_request' then 'ffe'
    when kind::text in ('order_followup','scheduling') then 'procurement'
    else 'admin'
  end
 where category is null;

create index if not exists idx_tasks_category on tasks(org_id, category);
