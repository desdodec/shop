-- Street Face: automated, READ-ONLY fulfilment readiness assessment.
-- No Prodigi API calls. No approvals, no mutation of checkout_orders.
-- Only service_role may access customer address data in the result.
begin;
create or replace function public.assess_checkout_fulfilment(p_order_id uuid default null)
returns table (
  order_id uuid,
  checkout_status text,
  fulfilment_status text,
  mug_count bigint,
  total_pence integer,
  readiness text,
  blockers text[]
)
language plpgsql security definer
set search_path = public
as $$
begin
  -- SQL Editor runs as the trusted postgres database session, while
  -- server-side Edge Functions use the service_role JWT via PostgREST.
  -- SECURITY DEFINER changes current_user; session_user remains the caller.
  if auth.role() is distinct from 'service_role'
     and session_user <> 'postgres' then
    raise exception 'Forbidden';
  end if;
  return query
  with assessments as (
    select
      o.id,
      o.checkout_status as payment_state,
      o.fulfilment_status as fulfilment_state,
      o.grand_total_pence,
      coalesce(sum(l.quantity), 0)::bigint as units,
      count(l.id)::bigint as line_count,
      coalesce(sum(l.line_total_pence), 0)::bigint as line_total,
      count(l.id) filter (
        where d.id is null or d.status is distinct from 'active'
           or d.dataset_id is distinct from o.dataset_id
           or d.design_code is distinct from l.design_code
           or a.id is null or a.design_id is distinct from l.design_id
           or a.product_sku is distinct from 'GLOBAL-MUG-W'
           or l.product_sku is distinct from 'GLOBAL-MUG-W'
           or a.version is distinct from l.asset_version
           or a.validation_status is distinct from 'valid'
           or nullif(btrim(a.production_key), '') is null
           or coalesce(a.production_size,0) < 1
           or l.unit_price_pence <> 2000
      )::bigint as bad_lines,
      o.shipping_details,
      o.stripe_payment_status,
      o.currency,
      o.shipping_charge_pence,
      o.item_subtotal_pence,
      o.stripe_checkout_session_id
    from public.checkout_orders o
    left join public.checkout_order_lines l on l.checkout_order_id = o.id
    left join public.designs d on d.id = l.design_id
    left join public.design_assets a on a.id = l.asset_id
    where p_order_id is null or o.id = p_order_id
    group by o.id
  ), checks as (
    select x.*, array_remove(array[
      case when x.payment_state <> 'validated' or x.stripe_payment_status is distinct from 'paid'
        then 'payment_not_validated' end,
      case when x.fulfilment_state <> 'not_released' then 'fulfilment_already_released_or_changed' end,
      case when x.stripe_checkout_session_id is null then 'missing_stripe_session' end,
      case when x.currency <> 'gbp' then 'currency_mismatch' end,
      case when x.units < 1 or x.units > 4 or x.line_count < 1 or x.line_count > 4
        then 'invalid_quantities' end,
      case when x.bad_lines <> 0 then 'artwork_or_catalogue_not_ready' end,
      case when x.line_total <> x.item_subtotal_pence
             or x.grand_total_pence <> x.item_subtotal_pence + x.shipping_charge_pence
             or x.grand_total_pence <> 2000 * x.units
        then 'total_mismatch' end,
      case when coalesce(nullif(btrim(x.shipping_details->>'name'), ''), '') = ''
        then 'missing_recipient_name' end,
      case when nullif(btrim(x.shipping_details#>>'{address,line1}'), '') is null
             or nullif(btrim(x.shipping_details#>>'{address,city}'), '') is null
             or nullif(btrim(x.shipping_details#>>'{address,postal_code}'), '') is null
             or x.shipping_details#>>'{address,country}' is distinct from 'GB'
        then 'missing_or_non_uk_shipping_address' end,
      -- Validation of file presence is not print-quality certification.
      'print_proof_not_approved',
      'prodigi_product_mapping_not_verified'
    ], null)::text[] as reasons
    from assessments x
  )
  select c.id, c.payment_state, c.fulfilment_state, c.units, c.grand_total_pence,
    case when cardinality(c.reasons) = 0 then 'ready' else 'hold' end,
    c.reasons
  from checks c
  order by c.id;
end;
$$;
revoke all on function public.assess_checkout_fulfilment(uuid) from public,anon,authenticated;
grant execute on function public.assess_checkout_fulfilment(uuid) to service_role;
commit;
