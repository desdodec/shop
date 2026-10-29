// Stripe sandbox webhook: verified signature; no automatic Prodigi release.
// Configure function verify_jwt=false and endpoint in Stripe sandbox.
import Stripe from "npm:stripe@17";
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("Method not allowed",{status:405});
  const key = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
  if (!key.startsWith("sk_test_") || !webhookSecret.startsWith("whsec_")) return new Response("Sandbox not configured",{status:503});
  const signature = request.headers.get("stripe-signature");
  if (!signature) return new Response("Missing signature",{status:400});
  const stripe = new Stripe(key,{apiVersion:"2024-12-18.acacia"});
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(await request.text(),signature,webhookSecret);
  } catch {
    return new Response("Invalid signature",{status:400});
  }
  if (!["checkout.session.completed","checkout.session.async_payment_succeeded","checkout.session.async_payment_failed","checkout.session.expired"].includes(event.type)) return new Response("Ignored",{status:200});
  const session = event.data.object as Stripe.Checkout.Session;
  const orderId = session.metadata?.order_id ?? session.client_reference_id;
  if (!orderId || !/^[0-9a-f-]{36}$/i.test(orderId)) return new Response("Invalid order ID",{status:400});
  const db = createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
  const {data:order,error:orderError} = await db.from("checkout_orders").select("id,checkout_status,grand_total_pence,stripe_checkout_session_id,currency").eq("id",orderId).single();
  if (orderError || !order) return new Response("Order missing",{status:500});
  // Retrieve authoritative latest payment status, do not trust success redirects.
  const fetched = await stripe.checkout.sessions.retrieve(session.id);
  if (fetched.id !== order.stripe_checkout_session_id || fetched.currency !== order.currency ||
      fetched.amount_total !== order.grand_total_pence || fetched.client_reference_id !== orderId) {
    await db.from("checkout_orders").update({checkout_status:"hold",hold_reason:"Stripe/order mismatch"}).eq("id",orderId).neq("checkout_status","validated");
    return new Response("Order mismatch",{status:200});
  }
  if (order.checkout_status === "validated") return new Response("Already validated",{status:200});
  let nextStatus = "hold";
  let reason: string | null = null;
  if (fetched.payment_status === "paid") {
    const {data:lines,error:lineError} = await db.from("checkout_order_lines").select("quantity,unit_price_pence,asset_id").eq("checkout_order_id",orderId);
    if (!lineError && lines?.length && lines.every(l=>!!l.asset_id) &&
        lines.reduce((sum,l)=>sum+l.quantity*l.unit_price_pence,0) === order.grand_total_pence) {
      nextStatus = "validated";
    } else reason = "Order lines require review";
  } else if (event.type === "checkout.session.expired") nextStatus = "expired";
  else if (event.type === "checkout.session.async_payment_failed") reason = "Async payment failed";
  else { nextStatus = "paid_unverified"; reason = "Awaiting confirmed payment"; }
  const {error:writeError} = await db.from("checkout_orders").update({
    checkout_status:nextStatus,
    hold_reason:reason,
    stripe_payment_intent_id:typeof fetched.payment_intent==="string"?fetched.payment_intent:null,
    stripe_payment_status:fetched.payment_status,
    stripe_customer_email:fetched.customer_details?.email ?? null,
    shipping_details:fetched.shipping_details ?? null
  }).eq("id",orderId).in("checkout_status",["pending","checkout_created","paid_unverified","hold","expired"]);
  if (writeError) return new Response("Database update failed",{status:500});
  // Event IDs are retained for audit; repeat deliveries must not release fulfilment.
  await db.from("stripe_webhook_events").upsert({stripe_event_id:event.id,event_type:event.type,checkout_order_id:orderId},{onConflict:"stripe_event_id",ignoreDuplicates:true});
  return new Response("OK",{status:200});
});
