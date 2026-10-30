-- Run after stripe_checkout_pilot.sql. Safe to re-run.
-- Only the server-side service_role may reconcile a Stripe-confirmed expiry.
-- Stripe session state MUST first be retrieved using the Stripe secret test key.
begin;
create or replace function public.reconcile_stripe_checkout_expiry(
  p_order_id uuid,
  p_session_id text,
  p_session_status text,
  p_payment_status text,
  p_amount_total integer,
  p_currency text
) returns text
language plpgsql security definer
set search_path = public
as $$
declare
  o public.checkout_orders%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Forbidden';
  end if;

  if p_session_id is null or p_session_id = ''
     or p_session_status not in ('open','complete','expired')
     or p_payment_status not in ('paid','unpaid','no_payment_required')
     or p_amount_total is null or p_currency is null then
    raise exception 'Missing or invalid Stripe session state';
  end if;

  select * into o from public.checkout_orders
   where id = p_order_id for update;
  if not found then raise exception 'Unknown checkout order'; end if;

  -- A mismatch needs manual review: never apply an expiry to the wrong order.
  if o.stripe_checkout_session_id is distinct from p_session_id
     or o.grand_total_pence is distinct from p_amount_total
     or o.currency is distinct from lower(p_currency) then
    return 'manual_review_mismatch';
  end if;

  -- Never downgrade paid, approved or previously resolved orders.
  if o.checkout_status in ('validated','refunded','cancelled','hold')
     or o.fulfilment_status <> 'not_released' then
    return 'terminal_or_held_noop';
  end if;

  if p_session_status = 'expired' and p_payment_status = 'unpaid' then
    if o.checkout_status = 'expired' then return 'already_expired'; end if;
    update public.checkout_orders
       set checkout_status = 'expired',
           stripe_payment_status = 'unpaid',
           hold_reason = null,
           updated_at = now()
     where id = p_order_id;
    return 'expired';
  end if;

  -- A completed/paid session without webhook reconciliation is NOT expired.
  -- Report it for payment reconciliation; do not self-declare a paid order.
  if p_session_status = 'complete' or p_payment_status = 'paid' then
    return 'manual_review_completed';
  end if;

  return 'still_open';
end;
$$;
revoke all on function public.reconcile_stripe_checkout_expiry(uuid,text,text,text,integer,text) from public,anon,authenticated;
grant execute on function public.reconcile_stripe_checkout_expiry(uuid,text,text,text,integer,text) to service_role;
commit;
