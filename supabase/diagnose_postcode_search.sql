-- Diagnose postcode-sector search behaviour.
-- Safe read-only checks plus a function-definition inspection.

-- 1) Confirm that HX7 5... mappings actually exist in design_postcodes.
select
    count(*) as hx75_mapping_count,
    count(distinct design_id) as hx75_design_count
from public.design_postcodes
where upper(replace(btrim(postcode), ' ', '')) like 'HX75%';

-- 2) Show a sample of mapped designs in that sector.
select
    d.design_code,
    d.street_name,
    p.postcode,
    upper(replace(btrim(p.postcode), ' ', '')) as postcode_compact
from public.design_postcodes p
join public.designs d on d.id = p.design_id
where upper(replace(btrim(p.postcode), ' ', '')) like 'HX75%'
order by d.street_name, p.postcode
limit 30;

-- 3) Test the public RPC directly inside Postgres.
select * from public.search_catalogue('HX7 5', 24, 0);

-- 4) Compare the compact form explicitly.
select
    upper(replace(btrim('HX7 5'), ' ', '')) as input_compact,
    upper(replace(btrim('HX7 5LL'), ' ', '')) as full_compact;
