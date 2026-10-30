// Scheduled Stripe TEST-mode checkout expiry audit.
// No payment capture, Stripe-side expiry, or fulfilment actions.
// Requires a private RECONCILIATION_CRON_TOKEN. A dry run is the default.
import Stripe from "npm:stripe@17";
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", {status: 405});
  const expectedToken = Deno.env.get("RECONCILIATION_CRON_TOKEN") ?? "";
  const suppliedToken = req.headers.get("x-reconciliation-token") ?? "";
  if (expectedToken.length < 32 || suppliedToken.length !== expectedToken.length) {
    return new Response("Forbidden", {status: 403});
  }
  // Compare all bytes without an early mismatch return.
  const a = new TextEncoder().encode(expectedToken);
  const b = new TextEncoder().encode(suppliedToken);
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a[i] ^ b[i];
  if (different !== 0) return new Response("Forbidden", {status: 403});

  const key = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  if (!key.startsWith("sk_test_")) return new Response("Test Stripe key required", {status: 503});
  const apply = Deno.env.get("EXPIRY_RECONCILIATION_APPLY") === "true";
  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    {auth: {persistSession: false}}
  );
  const stripe = new Stripe(key, {apiVersion: "2025-02-24.acacia"});
  const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();

  try {
    // Bounded batch; old orders remain discoverable on subsequent executions.
    const {data: orders, error} = await db.from("checkout_orders")
      .select("id,stripe_checkout_session_id,checkout_status")
      .in("checkout_status", ["checkout_created", "paid_unverified"])
      .lt("created_at", cutoff)
      .order("created_at", {ascending: true})
      .limit(25);
    if (error) throw new Error("Order lookup failed");
    const summary: Record<string,number> = {};
    let failures = 0;
    for (const order of orders ?? []) {
      let outcome = "manual_review_missing_session";
      try {
        if (order.stripe_checkout_session_id) {
          const session = await stripe.checkout.sessions.retrieve(order.stripe_checkout_session_id);
          if (session.livemode || session.mode !== "payment" ||
              session.id !== order.stripe_checkout_session_id ||
              session.client_reference_id !== order.id || session.metadata?.order_id !== order.id) {
            outcome = "manual_review_identity";
          } else if (session.status === "expired" && session.payment_status === "unpaid" && apply) {
            const {data, error: reconcileError} = await db.rpc("reconcile_stripe_checkout_expiry", {
              p_order_id: order.id,
              p_session_id: session.id,
              p_session_status: session.status,
              p_payment_status: session.payment_status,
              p_amount_total: session.amount_total,
              p_currency: session.currency
            });
            if (reconcileError) throw new Error("Expiry reconciliation RPC failed");
            outcome = String(data);
          } else if (session.status === "expired" && session.payment_status === "unpaid") {
            outcome = "would_reconcile_expiry";
          } else if (session.status === "complete" || session.payment_status === "paid") {
            outcome = "manual_review_completed";
          } else if (session.status === "open" && session.payment_status === "unpaid") {
            outcome = "still_open";
          } else {
            outcome = "manual_review_other_state";
          }
        }
      } catch (err) {
        outcome = "check_failed";
        failures++;
        console.error("Expiry check failed for order", order.id, err instanceof Error ? err.message : "unknown");
      }
      summary[outcome] = (summary[outcome] ?? 0) + 1;
      if (outcome.startsWith("manual_review")) console.warn("Expiry manual review:", order.id, outcome);
    }
    const report = {mode: apply ? "apply" : "dry_run", checked: orders?.length ?? 0, summary, failures};
    console.log("Checkout expiry audit", JSON.stringify(report));
    return Response.json(report, {status: failures ? 500 : 200});
  } catch (err) {
    console.error("Checkout expiry audit failed", err instanceof Error ? err.message : "unknown");
    return new Response("Audit unavailable", {status: 500});
  }
});
