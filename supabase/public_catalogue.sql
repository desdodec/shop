-- Public storefront API for the Street Face catalogue.
-- Run this in the Supabase SQL editor after catalogue_import/schema.sql.
--
-- Security model:
--   * browser clients never receive direct SELECT privileges on internal tables
--   * production_key and internal design UUIDs are never returned
--   * collection_dataset_id scopes every current storefront query to one dataset
--   * street_id is returned as safe public mapping metadata for deterministic GeoJSON lookup
--   * only active designs with validated assets are returned
--   * postcode mappings are searchable but never returned directly
--   * full postcode -> exact mappings only
--   * partial postcode / sector -> broader discovery mappings
--   * the function is read-only and has a fixed search_path
--
-- Migration safety:
--   * the legacy 3-argument search_catalogue overload is retained temporarily
--   * it only works while exactly one active dataset exists, so it cannot silently
--     mix collections after a second dataset is activated

begin;

revoke all on table public.designs from anon, authenticated;
revoke all on table public.design_assets from anon, authenticated;
revoke all on table public.design_postcodes from anon, authenticated;
revoke all on table public.design_postcode_sectors from anon, authenticated;
revoke all on table public.orders from anon, authenticated;

drop function if exists public.search_catalogue(text, text, integer, integer);

create function public.search_catalogue(
    collection_dataset_id text,
    search_text text default '',
    result_limit integer default 24,
    result_offset integer default 0
)
returns table (
    design_code text,
    street_id text,
    street_name text,
    locality text,
    front_mockup_key text,
    rear_mockup_key text
)
language sql
stable
security definer
set search_path = public
as $$
    with normalized as (
        select
            btrim(coalesce(search_text, '')) as raw,
            upper(replace(btrim(coalesce(search_text, '')), ' ', '')) as compact
    ),
    query as (
        select
            raw,
            compact,
            compact ~ '^[A-Z]{1,2}[0-9][0-9A-Z]?[0-9][A-Z]{2}$' as is_full_postcode
        from normalized
    )
    select
        d.design_code,
        d.street_id,
        d.street_name,
        d.locality,
        a.front_mockup_key,
        a.rear_mockup_key
    from public.designs d
    join public.design_assets a
      on a.design_id = d.id
     and a.product_sku = 'GLOBAL-MUG-W'
     and a.version = 1
     and a.validation_status = 'valid'
    cross join query q
    where d.status = 'active'
      and d.dataset_id = collection_dataset_id
      and (
        q.raw = ''
        or d.street_name ilike '%' || q.raw || '%'
        or d.design_code ilike '%' || q.raw || '%'
        or (
            q.is_full_postcode
            and exists (
                select 1
                from public.design_postcodes p
                where p.design_id = d.id
                  and upper(replace(btrim(p.postcode), ' ', '')) = q.compact
            )
        )
        or (
            not q.is_full_postcode
            and q.compact <> ''
            and (
                exists (
                    select 1
                    from public.design_postcodes p
                    where p.design_id = d.id
                      and upper(replace(btrim(p.postcode), ' ', '')) like q.compact || '%'
                )
                or exists (
                    select 1
                    from public.design_postcode_sectors s
                    where s.design_id = d.id
                      and upper(replace(btrim(s.sector), ' ', '')) like q.compact || '%'
                )
            )
        )
      )
    order by
      case
        when upper(d.design_code) = upper(q.raw) then 0
        when q.is_full_postcode and exists (
            select 1
            from public.design_postcodes p
            where p.design_id = d.id
              and upper(replace(btrim(p.postcode), ' ', '')) = q.compact
        ) then 1
        when lower(d.street_name) = lower(q.raw) then 2
        when lower(d.street_name) like lower(q.raw) || '%' then 3
        when not q.is_full_postcode and q.compact <> '' and exists (
            select 1
            from public.design_postcode_sectors s
            where s.design_id = d.id
              and upper(replace(btrim(s.sector), ' ', '')) like q.compact || '%'
        ) then 4
        when not q.is_full_postcode and q.compact <> '' and exists (
            select 1
            from public.design_postcodes p
            where p.design_id = d.id
              and upper(replace(btrim(p.postcode), ' ', '')) like q.compact || '%'
        ) then 5
        else 6
      end,
      lower(d.street_name),
      d.design_code
    limit least(greatest(coalesce(result_limit, 24), 1), 50)
    offset greatest(coalesce(result_offset, 0), 0);
$$;

revoke all on function public.search_catalogue(text, text, integer, integer) from public;
grant execute on function public.search_catalogue(text, text, integer, integer) to anon, authenticated;

comment on function public.search_catalogue(text, text, integer, integer) is
'Browser-safe collection-scoped catalogue search. Returns public design metadata plus street_id for deterministic GeoJSON mapping; never returns internal design UUIDs or production asset keys.';

-- Temporary compatibility overload for a storefront deployed before the
-- collection_dataset_id argument existed. It intentionally refuses to browse
-- across multiple active datasets: once more than one active dataset exists,
-- callers must use the collection-scoped overload above.
create or replace function public.search_catalogue(
    search_text text default '',
    result_limit integer default 24,
    result_offset integer default 0
)
returns table (
    design_code text,
    street_name text,
    locality text,
    front_mockup_key text,
    rear_mockup_key text
)
language sql
stable
security definer
set search_path = public
as $$
    with active_dataset as (
        select
            min(d.dataset_id) as dataset_id,
            count(distinct d.dataset_id) as dataset_count
        from public.designs d
        where d.status = 'active'
    )
    select
        c.design_code,
        c.street_name,
        c.locality,
        c.front_mockup_key,
        c.rear_mockup_key
    from active_dataset a
    cross join lateral public.search_catalogue(
        a.dataset_id,
        search_text,
        result_limit,
        result_offset
    ) c
    where a.dataset_count = 1;
$$;

revoke all on function public.search_catalogue(text, integer, integer) from public;
grant execute on function public.search_catalogue(text, integer, integer) to anon, authenticated;

comment on function public.search_catalogue(text, integer, integer) is
'Temporary legacy storefront compatibility overload. Works only while exactly one active dataset exists; migrate callers to the collection_dataset_id overload.';

commit;
