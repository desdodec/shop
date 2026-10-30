// Stripe sandbox webhook. No Prodigi integration or automatic fulfilment.
// Requires stripe_payment_reconciliation.sql and an endpoint deployed with --no-verify-jwt.
// Signature verification is mandatory. Do not log payment/customer details.
import Stripe from "npm:stripe@17";
import { createClient } from "npm:@supabase/supabase-js@2";

const supported = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired"
]);

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const key = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
  if (!key.startsWith("sk_test_") || !secret.startsWith("whsec_"))
    return new Response("Sandbox not configured", { status: 503 });

  const signature = request.headers.get("stripe-signature");
  if (!signature) return new Response("Missing signature", { status: 400 });
  const stripe = new Stripe(key, { apiVersion: "2025-02-24.acacia" });

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(await request.text(), signature, secret);
  } catch {
    return new Response("Invalid signature", { status: 400 });
  }

  if (!supported.has(event.type)) return new Response("Ignored", { status: 200 });
  const eventSession = event.data.object as Stripe.Checkout.Session;
  const id = eventSession.metadata?.order_id ?? eventSession.client_reference_id;
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    return new Response("Invalid order ID", { status: 400 });

  try {
    // Fetch the latest authoritative session state: webhook delivery order is not guaranteed.
    const session = await stripe.checkout.sessions.retrieve(eventSession.id);
    if (session.mode !== "payment" || session.client_reference_id !== id ||
        session.metadata?.order_id !== id || session.livemode)
      return new Response("Invalid session", { status: 400 });

    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } }
    );
    const { data, error } = await db.rpc("reconcile_stripe_checkout", {
      p_event_id: event.id,
      p_event_type: event.type,
      p_order_id: id,
      p_session_id: session.id,
      p_payment_intent_id: typeof session.payment_intent === "string" ? session.payment_intent : null,
      p_payment_status: session.payment_status,
      p_amount_total: session.amount_total,
      p_currency: session.currency,
      p_customer_email: session.customer_details?.email ?? null,
      p_shipping_details: session.shipping_details ?? null
    });
    if (error) {
      console.error("Payment reconciliation failed", error.message);
      return new Response("Reconciliation unavailable", { status: 500 });
    }
    return new Response(String(data), { status: 200 });
  } catch (error) {
    console.error("Stripe session retrieval failed", error instanceof Error ? error.message : "unknown");
    return new Response("Temporary processing failure", { status: 500 });
  }
});
