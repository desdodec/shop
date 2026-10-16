-- Public storefront API for the Street Face catalogue.
-- Run this in the Supabase SQL editor after catalogue_import/schema.sql.
--
-- Security model:
--   * browser clients never receive direct SELECT privileges on internal tables
--   * production_key is never returned
--   * only active designs with validated assets are returned
--   * postcode mappings are searchable but never returned directly
--   * full postcode queries fall back to their postcode sector for discovery
--   * the function is read-only and has a fixed search_path

begin;

revoke all on table public.designs from anon, authenticated;
revoke all on table public.design_assets from anon, authenticated;
revoke all on table public.design_postcodes from anon, authenticated;
revoke all on table public.orders from anon, authenticated;

drop function if exists public.search_catalogue(text, integer, integer);

create function public.search_catalogue(
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
    with normalized as (
        select
            btrim(coalesce(search_text, '')) as raw,
            upper(replace(btrim(coalesce(search_text, '')), ' ', '')) as compact
    ),
    query as (
        select
            raw,
            compact,
            case
                -- A full UK postcode ends with digit + two letters in the inward code.
                -- For discovery, reduce HX75LL -> HX75 (sector HX7 5).
                when compact ~ '^[A-Z]{1,2}[0-9][0-9A-Z]?[0-9][A-Z]{2}$'
                    then left(compact, length(compact) - 2)
                else compact
            end as postcode_prefix
        from normalized
    )
    select
        d.design_code,
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
      and (
        q.raw = ''
        or d.street_name ilike '%' || q.raw || '%'
        or d.design_code ilike '%' || q.raw || '%'
        or (
            q.postcode_prefix <> ''
            and exists (
                select 1
                from public.design_postcodes p
                where p.design_id = d.id
                  and upper(replace(btrim(p.postcode), ' ', '')) like q.postcode_prefix || '%'
            )
        )
      )
    order by
      case
        when upper(d.design_code) = upper(q.raw) then 0
        when exists (
            select 1
            from public.design_postcodes p
            where p.design_id = d.id
              and upper(replace(btrim(p.postcode), ' ', '')) = q.compact
        ) then 1
        when lower(d.street_name) = lower(q.raw) then 2
        when lower(d.street_name) like lower(q.raw) || '%' then 3
        when q.postcode_prefix <> '' and exists (
            select 1
            from public.design_postcodes p
            where p.design_id = d.id
              and upper(replace(btrim(p.postcode), ' ', '')) like q.postcode_prefix || '%'
        ) then 4
        else 5
      end,
      lower(d.street_name),
      d.design_code
    limit least(greatest(coalesce(result_limit, 24), 1), 50)
    offset greatest(coalesce(result_offset, 0), 0);
$$;

revoke all on function public.search_catalogue(text, integer, integer) from public;
grant execute on function public.search_catalogue(text, integer, integer) to anon, authenticated;

comment on function public.search_catalogue(text, integer, integer) is
'Browser-safe catalogue search by street name, Design ID, or postcode. Full postcode input falls back to postcode-sector discovery. Returns only public mockup metadata.';

commit;
