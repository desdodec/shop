-- Apply after stripe_checkout_pilot.sql. Atomic payment reconciliation.
-- No transition in this function can release a Prodigi fulfilment.
begin;
create or replace function public.reconcile_stripe_checkout(
  p_event_id text,
  p_event_type text,
  p_order_id uuid,
  p_session_id text,
  p_payment_intent_id text,
  p_payment_status text,
  p_amount_total integer,
  p_currency text,
  p_customer_email text,
  p_shipping_details jsonb
) returns text
language plpgsql security definer
set search_path = public
as $$
declare
  o public.checkout_orders%rowtype;
  v_lines integer;
  v_valid_lines integer;
  v_qty integer;
  v_total integer;
  v_bad integer;
  v_status text;
begin
  -- Explicitly require a privileged, server-side caller.
  if auth.role() is distinct from 'service_role' then
    raise exception 'Forbidden';
  end if;
  if p_event_id is null or p_event_id = '' or p_session_id is null then
    raise exception 'Missing Stripe identifiers';
  end if;

  select * into o from public.checkout_orders where id = p_order_id for update;
  if not found then raise exception 'Unknown checkout order'; end if;

  -- Stripe session identity must be persisted before its webhook is reconciled.
  if o.stripe_checkout_session_id is distinct from p_session_id
     or o.currency is distinct from lower(p_currency)
     or o.grand_total_pence is distinct from p_amount_total then
    update public.checkout_orders
       set checkout_status = 'hold', hold_reason = 'Stripe session/amount/currency mismatch', updated_at = now()
     where id = p_order_id and checkout_status not in ('validated','refunded','cancelled');
    insert into public.stripe_webhook_events(stripe_event_id,event_type,checkout_order_id)
      values(p_event_id,p_event_type,p_order_id) on conflict do nothing;
    return 'hold_mismatch';
  end if;

  if exists(select 1 from public.stripe_webhook_events where stripe_event_id = p_event_id) then
    return 'duplicate';
  end if;

  -- LEFT joins prevent missing catalogue records from disappearing from validation.
  select count(*),
         count(*) filter (where d.id is not null and a.id is not null),
         coalesce(sum(l.quantity),0),coalesce(sum(l.line_total_pence),0),
         count(*) filter (where d.id is null or a.id is null
                           or d.status is distinct from 'active'
                           or d.dataset_id is distinct from o.dataset_id
                           or d.design_code is distinct from l.design_code
                           or a.design_id is distinct from l.design_id
                           or a.product_sku is distinct from l.product_sku
                           or a.version is distinct from l.asset_version
                           or a.validation_status is distinct from 'valid'
                           or l.unit_price_pence <> 2000)
    into v_lines,v_valid_lines,v_qty,v_total,v_bad
    from public.checkout_order_lines l
    left join public.designs d on d.id = l.design_id
    left join public.design_assets a on a.id = l.asset_id
   where l.checkout_order_id = p_order_id;

  if p_payment_status = 'paid' then
    if v_lines < 1 or v_lines <> v_valid_lines or v_qty > 4
       or v_total <> o.item_subtotal_pence
       or o.grand_total_pence <> o.item_subtotal_pence + o.shipping_charge_pence
       or v_bad <> 0 or v_qty < 1 then
      v_status := 'hold';
    else
      v_status := 'validated';
    end if;
  elsif p_event_type = 'checkout.session.expired' then
    v_status := 'expired';
  elsif p_event_type = 'checkout.session.async_payment_failed' then
    v_status := 'hold';
  else
    v_status := 'paid_unverified';
  end if;

  -- Payment state must not move backwards on out-of-order events.
  if o.checkout_status not in ('validated','cancelled','refunded') then
    update public.checkout_orders set
      checkout_status = v_status,
      hold_reason = case when v_status = 'hold' then 'Payment or catalogue validation failed' else null end,
      stripe_payment_intent_id = coalesce(p_payment_intent_id,stripe_payment_intent_id),
      stripe_payment_status = p_payment_status,
      stripe_customer_email = p_customer_email,
      shipping_details = p_shipping_details,
      updated_at = now()
    where id = p_order_id;
  end if;

  insert into public.stripe_webhook_events(stripe_event_id,event_type,checkout_order_id)
    values(p_event_id,p_event_type,p_order_id) on conflict do nothing;
  return case when o.checkout_status in ('validated','cancelled','refunded') then 'terminal_noop' else v_status end;
end;
$$;
revoke all on function public.reconcile_stripe_checkout(text,text,uuid,text,text,text,integer,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.reconcile_stripe_checkout(text,text,uuid,text,text,text,integer,text,text,jsonb) to service_role;
commit;
