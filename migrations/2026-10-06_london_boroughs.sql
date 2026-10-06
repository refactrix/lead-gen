-- Splits the London search areas into the 32 London boroughs and the City of
-- London. A Greater London query is too heavy for the public Overpass servers
-- and kept timing out; a borough is a fraction of the size.
--
-- Each borough's OpenStreetMap boundary is set directly (osm_area_id =
-- 3600000000 + relation id, checked against Nominatim on 2026-10-06), so no
-- name lookup can match the wrong place: "Waltham Forest" alone matches
-- Waltham Abbey in Essex, and five boroughs don't match by short name at all.
--
-- The old 'London' areas are turned off, not deleted, so their counts stay.
-- Places they already checked are remembered per place, so the boroughs
-- won't visit them again.
--
-- Run in the SQL editor of the leads Supabase project. Safe to re-run.

begin;

update public.lead_targets
set enabled = false
where country = 'GB' and lower(area) = 'london';

-- Priority = borough number + category rank, so boroughs are spread through
-- the queue alongside the other cities instead of taking the next few weeks.
insert into public.lead_targets (country, area, category, priority, osm_area_id, resolved_name)
select 'GB', b.name, k.key, b.rank + k.rank, 3600000000 + b.relation,
       b.official || ', Greater London, England, United Kingdom'
from (values
  ('City of London',          'City of London',                            51800,  1),
  ('Westminster',             'City of Westminster',                       51781,  2),
  ('Camden',                  'London Borough of Camden',                  51827,  3),
  ('Islington',               'London Borough of Islington',               51821,  4),
  ('Hackney',                 'London Borough of Hackney',                 51806,  5),
  ('Tower Hamlets',           'London Borough of Tower Hamlets',           51805,  6),
  ('Southwark',               'London Borough of Southwark',             8450265,  7),
  ('Lambeth',                 'London Borough of Lambeth',                184710,  8),
  ('Wandsworth',              'London Borough of Wandsworth',              51906,  9),
  ('Hammersmith and Fulham',  'London Borough of Hammersmith and Fulham', 184484, 10),
  ('Kensington and Chelsea',  'Royal Borough of Kensington and Chelsea',   51793, 11),
  ('Greenwich',               'Royal Borough of Greenwich',                51902, 12),
  ('Lewisham',                'London Borough of Lewisham',               184724, 13),
  ('Newham',                  'London Borough of Newham',                 185505, 14),
  ('Barking and Dagenham',    'London Borough of Barking and Dagenham',   185483, 15),
  ('Redbridge',               'London Borough of Redbridge',               65598, 16),
  ('Havering',                'London Borough of Havering',               185478, 17),
  ('Bexley',                  'London Borough of Bexley',                  51903, 18),
  ('Bromley',                 'London Borough of Bromley',                152126, 19),
  ('Croydon',                 'London Borough of Croydon',                 51907, 20),
  ('Sutton',                  'London Borough of Sutton',                  17529, 21),
  ('Merton',                  'London Borough of Merton',                  51905, 22),
  ('Kingston upon Thames',    'Royal Borough of Kingston upon Thames',     51909, 23),
  ('Richmond upon Thames',    'London Borough of Richmond upon Thames',   151795, 24),
  ('Hounslow',                'London Borough of Hounslow',                51848, 25),
  ('Hillingdon',              'London Borough of Hillingdon',             183779, 26),
  ('Ealing',                  'London Borough of Ealing',                 181321, 27),
  ('Harrow',                  'London Borough of Harrow',                 181292, 28),
  ('Brent',                   'London Borough of Brent',                   75767, 29),
  ('Barnet',                  'London Borough of Barnet',                  51831, 30),
  ('Enfield',                 'London Borough of Enfield',                 51841, 31),
  ('Haringey',                'London Borough of Haringey',                51814, 32),
  ('Waltham Forest',          'London Borough of Waltham Forest',          65595, 33)
) as b(name, official, relation, rank)
cross join (values
  ('restaurant', 1), ('hairdresser', 2), ('dentist', 3), ('cafe', 4), ('gym', 5),
  ('beauty_salon', 6), ('plumber', 7), ('accountant', 8), ('estate_agent', 9),
  ('solicitor', 10), ('florist', 11), ('bakery', 12), ('car_repair', 13), ('vet', 14),
  ('physio', 15), ('electrician', 16), ('builder', 17), ('clothes', 18), ('hotel', 19)
) as k(key, rank)
on conflict do nothing;

commit;

-- Check: expect boroughs = 33, searches = 627 (33 x 19), london_on = 0
select
  (select count(distinct area) from public.lead_targets
    where enabled and country = 'GB' and resolved_name like '%, Greater London, England, United Kingdom') as boroughs,
  (select count(*) from public.lead_targets
    where enabled and country = 'GB' and resolved_name like '%, Greater London, England, United Kingdom') as searches,
  (select count(*) from public.lead_targets
    where enabled and country = 'GB' and lower(area) = 'london') as london_on;
