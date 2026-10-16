-- Postcode-sector discovery for the public catalogue.
--
-- Exact full postcodes remain in design_postcodes. This table is deliberately
-- broader: it lets customers narrow by a postcode sector such as HX7 5 even when
-- we do not have enough evidence to attach a particular full postcode to a street.
--
-- Search behaviour:
--   * full postcode + exact matches -> return only exact matches
--   * full postcode + no exact matches -> fall back to its postcode sector
--   * partial postcode / sector -> return sector-discovery matches

begin;

create table if not exists public.design_postcode_sectors (
    design_id uuid not null references public.designs(id) on delete cascade,
    sector text not null,
    sector_normalized text generated always as (upper(replace(btrim(sector), ' ', ''))) stored,
    source text not null default 'geometry_candidates',
    created_at timestamptz not null default now(),
    primary key (design_id, sector),
    check (length(btrim(sector)) >= 3)
);

create index if not exists idx_design_postcode_sectors_normalized
    on public.design_postcode_sectors(sector_normalized);

revoke all on table public.design_postcode_sectors from anon, authenticated;

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
    query_base as (
        select
            raw,
            compact,
            compact ~ '^[A-Z]{1,2}[0-9][0-9A-Z]?[0-9][A-Z]{2}$' as is_full_postcode,
            case
                when compact ~ '^[A-Z]{1,2}[0-9][0-9A-Z]?[0-9][A-Z]{2}$'
                    then left(compact, length(compact) - 2)
                else compact
            end as postcode_prefix
        from normalized
    ),
    query as (
        select
            qb.*,
            (
                qb.is_full_postcode
                and exists (
                    select 1
                    from public.design_postcodes p
                    where upper(replace(btrim(p.postcode), ' ', '')) = qb.compact
                )
            ) as has_exact_postcode_matches
        from query_base qb
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
            q.compact <> ''
            and (
                (
                    q.has_exact_postcode_matches
                    and exists (
                        select 1
                        from public.design_postcodes p
                        where p.design_id = d.id
                          and upper(replace(btrim(p.postcode), ' ', '')) = q.compact
                    )
                )
                or (
                    not q.has_exact_postcode_matches
                    and (
                        exists (
                            select 1
                            from public.design_postcodes p
                            where p.design_id = d.id
                              and upper(replace(btrim(p.postcode), ' ', '')) like q.postcode_prefix || '%'
                        )
                        or exists (
                            select 1
                            from public.design_postcode_sectors s
                            where s.design_id = d.id
                              and upper(replace(btrim(s.sector), ' ', '')) like q.postcode_prefix || '%'
                        )
                    )
                )
            )
        )
      )
    order by
      case
        when upper(d.design_code) = upper(q.raw) then 0
        when q.has_exact_postcode_matches and exists (
            select 1
            from public.design_postcodes p
            where p.design_id = d.id
              and upper(replace(btrim(p.postcode), ' ', '')) = q.compact
        ) then 1
        when lower(d.street_name) = lower(q.raw) then 2
        when lower(d.street_name) like lower(q.raw) || '%' then 3
        when not q.has_exact_postcode_matches and q.postcode_prefix <> '' and exists (
            select 1
            from public.design_postcode_sectors s
            where s.design_id = d.id
              and upper(replace(btrim(s.sector), ' ', '')) like q.postcode_prefix || '%'
        ) then 4
        when not q.has_exact_postcode_matches and q.postcode_prefix <> '' and exists (
            select 1
            from public.design_postcodes p
            where p.design_id = d.id
              and upper(replace(btrim(p.postcode), ' ', '')) like q.postcode_prefix || '%'
        ) then 5
        else 6
      end,
      lower(d.street_name),
      d.design_code
    limit least(greatest(coalesce(result_limit, 24), 1), 50)
    offset greatest(coalesce(result_offset, 0), 0);
$$;

revoke all on function public.search_catalogue(text, integer, integer) from public;
grant execute on function public.search_catalogue(text, integer, integer) to anon, authenticated;

comment on table public.design_postcode_sectors is
'Internal postcode-sector discovery mappings. Broader than full postcode mappings and never returned by the public RPC.';

comment on function public.search_catalogue(text, integer, integer) is
'Browser-safe catalogue search. Exact full postcode matches take priority; sector discovery is used only when no exact postcode mapping exists or when the user enters a partial postcode/sector.';

commit;
