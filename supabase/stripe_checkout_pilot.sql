-- Street Face Stripe sandbox pilot: immutable, multi-line order ledger.
-- Apply only after review; no live checkout or Prodigi fulfilment is enabled.
-- The existing legacy "orders" table is deliberately left untouched.
begin;
create extension if not exists pgcrypto;

create table if not exists public.checkout_orders (
  id uuid primary key default gen_random_uuid(),
  collection_id text not null,
  dataset_id text not null,
  currency text not null default 'gbp' check (currency = 'gbp'),
  item_subtotal_pence integer not null check (item_subtotal_pence >= 0),
  shipping_charge_pence integer not null default 0 check (shipping_charge_pence >= 0),
  grand_total_pence integer not null check (grand_total_pence = item_subtotal_pence + shipping_charge_pence),
  checkout_status text not null default 'pending'
    check (checkout_status in ('pending','checkout_created','paid_unverified','validated','hold','cancelled','expired','refunded')),
  fulfilment_status text not null default 'not_released'
    check (fulfilment_status in ('not_released','approved','submitted','shipped','failed','cancelled')),
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text unique,
  stripe_payment_status text,
  stripe_customer_email text,
  shipping_details jsonb,
  hold_reason text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint paid_must_be_checked check (fulfilment_status = 'not_released' or checkout_status = 'validated')
);

create table if not exists public.checkout_order_lines (
  id uuid primary key default gen_random_uuid(),
  checkout_order_id uuid not null references public.checkout_orders(id) on delete restrict,
  line_number integer not null check (line_number > 0),
  design_id uuid not null references public.designs(id) on delete restrict,
  design_code text not null,
  street_name text not null,
  locality text not null,
  product_sku text not null check (product_sku = 'GLOBAL-MUG-W'),
  asset_id uuid not null references public.design_assets(id) on delete restrict,
  asset_version integer not null check (asset_version > 0),
  quantity integer not null check (quantity between 1 and 4),
  unit_price_pence integer not null check (unit_price_pence = 2000),
  line_total_pence integer generated always as (quantity * unit_price_pence) stored,
  created_at timestamptz not null default now(),
  unique (checkout_order_id, line_number),
  unique (checkout_order_id, design_id, product_sku)
);

create table if not exists public.stripe_webhook_events (
  stripe_event_id text primary key,
  event_type text not null,
  checkout_order_id uuid references public.checkout_orders(id) on delete restrict,
  processed_at timestamptz not null default now()
);

create table if not exists public.checkout_fulfilment_attempts (
  id uuid primary key default gen_random_uuid(),
  checkout_order_id uuid not null references public.checkout_orders(id) on delete restrict,
  attempt_no integer not null check (attempt_no > 0),
  idempotency_key text not null unique,
  prodigi_order_id text unique,
  status text not null check (status in ('pending','submitted','failed','cancelled')),
  error_message text,
  created_at timestamptz not null default now(),
  unique(checkout_order_id, attempt_no)
);

create index if not exists checkout_orders_status_idx on public.checkout_orders(checkout_status, created_at);
create index if not exists checkout_lines_order_idx on public.checkout_order_lines(checkout_order_id);

-- Fail closed: browser clients have no access to private order tables.
alter table public.checkout_orders enable row level security;
alter table public.checkout_order_lines enable row level security;
alter table public.stripe_webhook_events enable row level security;
alter table public.checkout_fulfilment_attempts enable row level security;
revoke all on public.checkout_orders from anon, authenticated;
revoke all on public.checkout_order_lines from anon, authenticated;
revoke all on public.stripe_webhook_events from anon, authenticated;
revoke all on public.checkout_fulfilment_attempts from anon, authenticated;

-- Avoid direct updates to validated/paid line snapshots from the browser;
-- server-side checkout code must separately enforce state transitions, 
-- validate all totals, and serialise concurrent webhook handling.
commit;
