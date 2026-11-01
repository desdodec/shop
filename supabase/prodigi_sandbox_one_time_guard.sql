-- Manual Acacia Grove Prodigi v4 Sandbox test. Independent of customer orders.
-- Execute once in Supabase SQL Editor before deploying the submission function.
begin;
create table if not exists public.prodigi_sandbox_test_submissions (
  test_key text primary key,
  design_code text not null,
  state text not null check (state in ('reserved', 'accepted', 'rejected', 'unknown')),
  merchant_reference text not null unique,
  prodigi_order_id text,
  http_status integer,
  result_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sandbox_acacia_only check (
    test_key = 'acacia-grove-v2-first-sandbox'
    and design_code = 'HBV2-0000'
    and merchant_reference = 'STREET-FACE-HBV2-0000-SANDBOX-ONCE'
  )
);
revoke all on public.prodigi_sandbox_test_submissions from public, anon, authenticated;
grant select, insert, update on public.prodigi_sandbox_test_submissions to service_role;
commit;
-- Read-only inspection:
-- select test_key, state, merchant_reference, prodigi_order_id, http_status, result_summary, created_at
-- from public.prodigi_sandbox_test_submissions;
