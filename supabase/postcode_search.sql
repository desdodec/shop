-- Full-postcode storage for the Street Face catalogue.
--
-- This file intentionally DOES NOT redefine public.search_catalogue.
-- The current browser-safe search function lives in public_catalogue.sql and
-- postcode_sector_search.sql, where full postcodes are exact-only and partial
-- postcode/sector input uses broader discovery mappings.
--
-- Keeping this file limited to the table/index prevents an old maintenance
-- script from accidentally restoring obsolete postcode search behaviour.

begin;

create table if not exists public.design_postcodes (
    design_id uuid not null references public.designs(id) on delete cascade,
    postcode text not null,
    postcode_normalized text generated always as (upper(replace(btrim(postcode), ' ', ''))) stored,
    created_at timestamptz not null default now(),
    primary key (design_id, postcode),
    check (length(btrim(postcode)) >= 2)
);

create index if not exists idx_design_postcodes_normalized
    on public.design_postcodes(postcode_normalized);

revoke all on table public.design_postcodes from anon, authenticated;

comment on table public.design_postcodes is
'Internal exact postcode mappings for catalogue search. Multiple postcodes may map to one design; mappings are never returned directly to browser clients.';

commit;
