#!/usr/bin/env node
/**
 * Street Face checkout expiry audit (Stripe TEST mode only).
 *
 * Required environment variables:
 *   STRIPE_SECRET_KEY=sk_test_...
 *   SUPABASE_URL=https://<project>.supabase.co
 *   SUPABASE_SECRET_KEY=sb_secret_...
 *
 * Run: node scripts/reconcile-checkout-expiry.mjs
 * Apply verified expiry: node scripts/reconcile-checkout-expiry.mjs --apply
 * Default is READ-ONLY. Never expose credentials to the browser or commit them.
 */
const apply = process.argv.includes('--apply');
if (process.argv.some(arg => arg.startsWith('--') && arg !== '--apply')) {
  console.error('Only --apply is supported');
  process.exit(2);
}
const stripeKey = process.env.STRIPE_SECRET_KEY ?? '';
const supabaseUrl = process.env.SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SECRET_KEY ?? '';
if (!stripeKey.startsWith('sk_test_') || !/^https:\/\/[^/]+\.supabase\.co\/?$/.test(supabaseUrl) || !serviceKey.startsWith('sb_secret_')) {
  console.error('Missing sandbox STRIPE_SECRET_KEY, SUPABASE_URL, or SUPABASE_SECRET_KEY');
  process.exit(2);
}
const base = supabaseUrl.replace(/\/$/, '');
const dbHeaders = { apikey: serviceKey };
async function jsonResponse(response, label) {
  if (!response.ok) throw new Error(`${label} failed (HTTP ${response.status})`);
  return response.json();
}
const orders = await jsonResponse(await fetch(
  `${base}/rest/v1/checkout_orders?select=id,checkout_status,stripe_checkout_session_id&checkout_status=in.(checkout_created,paid_unverified,expired)&order=created_at.desc&limit=50`,
  { headers: dbHeaders }
), 'Read checkout orders');
const results = [];
for (const order of orders) {
  if (!order.stripe_checkout_session_id) {
    results.push({ order_id: order.id, result: 'manual_review_missing_session' });
    continue;
  }
  const stripe = await jsonResponse(await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(order.stripe_checkout_session_id)}`,
    { headers: { Authorization: `Bearer ${stripeKey}` } }
  ), 'Retrieve Stripe session');
  if (stripe.livemode !== false || stripe.mode !== 'payment' ||
      stripe.client_reference_id !== order.id || stripe.metadata?.order_id !== order.id ||
      stripe.id !== order.stripe_checkout_session_id) {
    results.push({ order_id: order.id, result: 'manual_review_session_identity' });
    continue;
  }
  let result;
  if (apply) {
    const response = await fetch(`${base}/rest/v1/rpc/reconcile_stripe_checkout_expiry`, {
      method: 'POST',
      headers: { ...dbHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        p_order_id: order.id,
        p_session_id: stripe.id,
        p_session_status: stripe.status,
        p_payment_status: stripe.payment_status,
        p_amount_total: stripe.amount_total,
        p_currency: stripe.currency,
      }),
    });
    result = await jsonResponse(response, 'Reconcile Stripe session');
  } else {
    result = stripe.status === 'expired' && stripe.payment_status === 'unpaid'
      ? 'would_reconcile_expiry'
      : stripe.status === 'complete' || stripe.payment_status === 'paid'
        ? 'manual_review_completed'
        : stripe.status === 'open' ? 'still_open' : 'manual_review_other_status';
  }
  results.push({ order_id: order.id, result, stripe_status: stripe.status, payment_status: stripe.payment_status });
}
console.log(JSON.stringify({ mode: apply ? 'apply' : 'read_only', checked: orders.length, results }, null, 2));
