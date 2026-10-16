-- Diagnose postcode-sector search behaviour in one result table.
-- Safe read-only checks.

with hx75_mappings as (
    select
        p.design_id,
        d.design_code,
        d.street_name,
        p.postcode,
        upper(replace(btrim(p.postcode), ' ', '')) as postcode_compact
    from public.design_postcodes p
    join public.designs d on d.id = p.design_id
    where upper(replace(btrim(p.postcode), ' ', '')) like 'HX75%'
),
rpc_results as (
    select * from public.search_catalogue('HX7 5', 50, 0)
),
burnley as (
    select
        count(*) as mapped_rows,
        string_agg(distinct postcode, ', ' order by postcode) as mapped_postcodes
    from hx75_mappings
    where lower(street_name) = lower('Burnley Road')
)
select
    upper(replace(btrim('HX7 5'), ' ', '')) as input_compact,
    (select count(*) from hx75_mappings) as hx75_mapping_count,
    (select count(distinct design_id) from hx75_mappings) as hx75_design_count,
    (select count(*) from rpc_results) as rpc_result_count,
    (select count(*) > 0 from rpc_results where lower(street_name) = lower('Burnley Road')) as rpc_includes_burnley_road,
    (select mapped_rows from burnley) as burnley_hx75_mapping_rows,
    (select mapped_postcodes from burnley) as burnley_hx75_postcodes,
    (select string_agg(design_code || ' — ' || street_name, '; ' order by street_name)
       from (select distinct design_code, street_name from rpc_results limit 20) s
    ) as rpc_sample;
