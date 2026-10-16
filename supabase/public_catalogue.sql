-- Public storefront API for the Street Face catalogue.
-- Run this in the Supabase SQL editor after catalogue_import/schema.sql.
--
-- Security model:
--   * browser clients never receive direct SELECT privileges on internal tables
--   * production_key is never returned
--   * only active designs with validated assets are returned
--   * the function is read-only and has a fixed search_path
--
-- The function is intentionally keyed by public design_code for customer UX.
-- Internal fulfilment continues to resolve that unique design_code to the
-- canonical design row, whose durable database identity is dataset_id + street_id.

begin;

-- Ensure browser roles cannot query the internal tables directly.
revoke all on table public.designs from anon, authenticated;
revoke all on table public.design_assets from anon, authenticated;
revoke all on table public.orders from anon, authenticated;

-- Recreate cleanly so the declared return type cannot drift unnoticed.
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
    where d.status = 'active'
      and (
        nullif(btrim(search_text), '') is null
        or d.street_name ilike '%' || btrim(search_text) || '%'
        or d.design_code ilike '%' || btrim(search_text) || '%'
      )
    order by
      case
        when upper(d.design_code) = upper(btrim(search_text)) then 0
        when lower(d.street_name) = lower(btrim(search_text)) then 1
        when lower(d.street_name) like lower(btrim(search_text)) || '%' then 2
        else 3
      end,
      lower(d.street_name),
      d.design_code
    limit least(greatest(coalesce(result_limit, 24), 1), 50)
    offset greatest(coalesce(result_offset, 0), 0);
$$;

revoke all on function public.search_catalogue(text, integer, integer) from public;
grant execute on function public.search_catalogue(text, integer, integer) to anon, authenticated;

comment on function public.search_catalogue(text, integer, integer) is
'Browser-safe catalogue search. Returns only public mockup metadata for active, validated GLOBAL-MUG-W designs.';

commit;
