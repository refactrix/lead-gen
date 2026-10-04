-- Lead finder (leadfinder.js): OpenStreetMap search areas and multi-country
-- leads. Run in the SQL editor of the leads Supabase project.
-- Safe to re-run. Runs as one transaction, so a failure changes nothing.

begin;

-- 1. Where each lead came from. Existing rows came from Google Maps.
alter table public.leads
  add column if not exists source    text not null default 'google_maps',
  add column if not exists source_id text;   -- e.g. 'node/249231445' for OpenStreetMap

-- OpenStreetMap leads have no Google Maps URL
alter table public.leads alter column google_maps_url drop not null;
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'leads' and column_name = 'google_maps_url_normalized'
  ) then
    execute 'alter table public.leads alter column google_maps_url_normalized drop not null';
  end if;
end $$;

create unique index if not exists leads_source_source_id_key
  on public.leads (source, source_id) where source_id is not null;

-- 2. Country as an ISO 3166-1 alpha-2 code ('GB'). Every existing lead is in
--    the UK. emailgen.js and sendapproved.js only handle countries listed in
--    countries.js, so a lead without a country would never be emailed.
update public.leads
set country = 'GB'
where country is null
   or upper(trim(country)) in ('UK', 'GB', 'UNITED KINGDOM', 'GREAT BRITAIN', 'ENGLAND', 'SCOTLAND', 'WALES', 'NORTHERN IRELAND');

-- 3. Search areas, managed on the admin's Automation page.
create table if not exists public.lead_targets (
  id             bigint generated always as identity primary key,
  country        text not null check (country ~ '^[A-Z]{2}$'),
  area           text not null,                 -- place name, e.g. 'Manchester'
  category       text not null,                 -- key from categories.js
  enabled        boolean not null default true,
  priority       int not null default 100,      -- lower runs first among areas never searched
  osm_area_id    bigint,                        -- found once by name; set by hand to fix a wrong match
  resolved_name  text,                          -- what the name matched, to check it is the right place
  last_run_at    timestamptz,
  exhausted_at   timestamptz,                   -- every place checked; searched again after 90 days
  leads_found    int not null default 0,
  places_checked int not null default 0,
  last_error     text,
  created_at     timestamptz not null default now()
);
create unique index if not exists lead_targets_unique
  on public.lead_targets (country, lower(area), category);
alter table public.lead_targets enable row level security;

-- 4. Places already checked, so a run never visits the same website twice.
--    Holds map ids and an outcome only, no contact details. Places without a
--    usable email are checked again after 180 days.
create table if not exists public.lead_sources_seen (
  source     text not null,
  source_id  text not null,
  outcome    text not null,   -- lead | no_email | blocked | unreachable | duplicate | suppressed | error
  checked_at timestamptz not null default now(),
  primary key (source, source_id)
);
alter table public.lead_sources_seen enable row level security;

-- 5. Starting areas: 20 UK cities × 19 categories. The priority mixes
--    cities and categories, so early runs aren't all London or all restaurants.
insert into public.lead_targets (country, area, category, priority)
select 'GB', c.name, k.key, c.rank + k.rank
from (values
  ('London', 1), ('Birmingham', 2), ('Manchester', 3), ('Leeds', 4), ('Glasgow', 5),
  ('Liverpool', 6), ('Bristol', 7), ('Sheffield', 8), ('Edinburgh', 9), ('Cardiff', 10),
  ('Leicester', 11), ('Nottingham', 12), ('Newcastle upon Tyne', 13), ('Belfast', 14),
  ('Brighton and Hove', 15), ('Southampton', 16), ('Coventry', 17), ('York', 18),
  ('Oxford', 19), ('Cambridge', 20)
) as c(name, rank)
cross join (values
  ('restaurant', 1), ('hairdresser', 2), ('dentist', 3), ('cafe', 4), ('gym', 5),
  ('beauty_salon', 6), ('plumber', 7), ('accountant', 8), ('estate_agent', 9),
  ('solicitor', 10), ('florist', 11), ('bakery', 12), ('car_repair', 13), ('vet', 14),
  ('physio', 15), ('electrician', 16), ('builder', 17), ('clothes', 18), ('hotel', 19)
) as k(key, rank)
on conflict do nothing;

commit;
