-- schema.sql

create extension if not exists pgcrypto;

create table if not exists designs (
    id uuid primary key default gen_random_uuid(),
    design_code text unique not null,
    dataset_id text not null,
    street_id text not null,
    street_name text not null,
    locality text not null,
    status text not null default 'active'
        check (status in ('active', 'hold', 'disabled')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique(dataset_id, street_id)
);

create table if not exists design_assets (
    id uuid primary key default gen_random_uuid(),
    design_id uuid not null references designs(id) on delete cascade,
    product_sku text not null,
    front_mockup_key text not null,
    rear_mockup_key text not null,
    production_key text not null,
    version integer not null default 1,
    validation_status text not null default 'pending'
        check (validation_status in ('pending','valid','missing_front','missing_rear','missing_production','invalid')),
    front_size bigint,
    rear_size bigint,
    production_size bigint,
    front_etag text,
    rear_etag text,
    production_etag text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique(design_id, product_sku, version)
);

create table if not exists design_postcodes (
    design_id uuid not null references designs(id) on delete cascade,
    postcode text not null,
    postcode_normalized text generated always as (upper(regexp_replace(postcode, '\\s+', '', 'g'))) stored,
    created_at timestamptz not null default now(),
    primary key (design_id, postcode),
    check (length(btrim(postcode)) >= 2)
);

create table if not exists design_postcode_sectors (
    design_id uuid not null references designs(id) on delete cascade,
    sector text not null,
    sector_normalized text generated always as (upper(replace(btrim(sector), ' ', ''))) stored,
    source text not null default 'geometry_candidates',
    created_at timestamptz not null default now(),
    primary key (design_id, sector),
    check (length(btrim(sector)) >= 3)
);

create table if not exists orders (
    id uuid primary key default gen_random_uuid(),
    etsy_receipt_id text unique,
    etsy_transaction_id text,
    design_id uuid not null references designs(id),
    design_version integer not null default 1,
    product_sku text not null,
    prodigi_order_id text unique,
    status text not null default 'received'
        check (status in ('received','validated','hold','submitted','in_production','shipped','cancelled','failed')),
    error_message text,
    created_at timestamptz not null default now(),
    submitted_at timestamptz,
    shipped_at timestamptz
);

create index if not exists idx_designs_locality on designs(locality);
create index if not exists idx_designs_street_name_lower on designs(lower(street_name));
create index if not exists idx_designs_status on designs(status);
create index if not exists idx_design_postcodes_normalized on design_postcodes(postcode_normalized);
create index if not exists idx_design_postcode_sectors_normalized on design_postcode_sectors(sector_normalized);
create index if not exists idx_orders_status on orders(status);
create index if not exists idx_design_assets_product_sku on design_assets(product_sku);

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists trg_designs_updated_at on designs;
create trigger trg_designs_updated_at
before update on designs
for each row execute function set_updated_at();

drop trigger if exists trg_design_assets_updated_at on design_assets;
create trigger trg_design_assets_updated_at
before update on design_assets
for each row execute function set_updated_at();
