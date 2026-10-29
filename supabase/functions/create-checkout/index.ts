// Supabase Edge Function: create-checkout (Stripe SANDBOX ONLY)
// Deploy with JWT verification disabled; rate-limit at the edge before public launch.
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY,
// SITE_URL, STREET_FACE_DATASET_ID, STREET_FACE_COLLECTION_ID.
// Optional: ALLOWED_ORIGIN. Never expose the service role or Stripe secret to a browser.
import { createClient } from "npm:@supabase/supabase-js@2";

const json = (body: unknown, status = 200, origin = "") => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "access-control-allow-origin": origin, "vary": "Origin" }
});
const originAllowed = (origin: string) => {
  const allowed = Deno.env.get("ALLOWED_ORIGIN") ?? Deno.env.get("SITE_URL") ?? "";
  return !!origin && new URL(origin).origin === new URL(allowed).origin;
};
const unitPence = 2000; // £20 including UK delivery
const sku = "GLOBAL-MUG-W";
Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  if (!originAllowed(origin)) return json({error:"Origin not permitted"}, 403);
  if (req.method === "OPTIONS") return new Response(null, {status:204,headers:{"access-control-allow-origin":origin,"access-control-allow-methods":"POST, OPTIONS","access-control-allow-headers":"content-type"}});
  if (req.method !== "POST") return json({error:"Method not allowed"},405,origin);
  try {
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
    if (!stripeKey.startsWith("sk_test_")) throw new Error("Sandbox key required");
    const payload = await req.json();
    if (!Array.isArray(payload.items) || !payload.items.length || payload.items.length > 4) return json({error:"Select 1–4 designs"},400,origin);
    const quantities = new Map<string,number>();
    for (const row of payload.items) {
      const code = row?.design_code;
      const quantity = row?.quantity;
      if (typeof code !== "string" || !/^HB-\d{4}$/.test(code) || !Number.isInteger(quantity) || quantity < 1) return json({error:"Invalid basket"},400,origin);
      quantities.set(code,(quantities.get(code) ?? 0)+quantity);
    }
    const totalQty = [...quantities.values()].reduce((a,b)=>a+b,0);
    if (totalQty > 4) return json({error:"Pilot limited to four mugs"},400,origin);
    const db = createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
    const dataset = Deno.env.get("STREET_FACE_DATASET_ID")!;
    const collection = Deno.env.get("STREET_FACE_COLLECTION_ID")!;
    const {data:designs,error:designError} = await db.from("designs").select("id,design_code,street_name,locality,status,dataset_id").eq("dataset_id",dataset).in("design_code",[...quantities.keys()]);
    if (designError || !designs || designs.length !== quantities.size || designs.some((d)=>d.status!=="active")) return json({error:"Unavailable design"},400,origin);
    const {data:assets,error:assetError} = await db.from("design_assets").select("id,design_id,version,validation_status").in("design_id",designs.map(d=>d.id)).eq("product_sku",sku).eq("version",1).eq("validation_status","valid");
    if (assetError || !assets || assets.length !== designs.length) return json({error:"Artwork is not ready"},400,origin);
    const byDesign = new Map(assets.map(a=>[a.design_id,a]));
    if (byDesign.size !== designs.length) return json({error:"Ambiguous artwork"},400,origin);
    const subtotal = totalQty*unitPence;
    const {data:order,error:orderError} = await db.from("checkout_orders").insert({collection_id:collection,dataset_id:dataset,item_subtotal_pence:subtotal,grand_total_pence:subtotal,shipping_charge_pence:0}).select("id").single();
    if (orderError || !order) throw new Error("Could not create order");
    const lines = designs.sort((a,b)=>a.design_code.localeCompare(b.design_code)).map((d,index)=>({
      checkout_order_id:order.id,line_number:index+1,design_id:d.id,design_code:d.design_code,street_name:d.street_name,locality:d.locality,product_sku:sku,asset_id:byDesign.get(d.id)!.id,asset_version:1,quantity:quantities.get(d.design_code),unit_price_pence:unitPence
    }));
    const {error:linesError} = await db.from("checkout_order_lines").insert(lines);
    if (linesError) {
      await db.from("checkout_orders").update({checkout_status:"hold",hold_reason:"Could not snapshot lines"}).eq("id",order.id);
      throw new Error("Could not save order lines");
    }
    const siteUrl = new URL(Deno.env.get("SITE_URL")!);
    const params = new URLSearchParams();
    params.set("mode","payment");
    params.set("payment_method_types[0]","card");
    params.set("client_reference_id",order.id);
    params.set("metadata[order_id]",order.id);
    params.set("success_url",new URL("/checkout-success?session_id={CHECKOUT_SESSION_ID}",siteUrl).toString().replace("%7BCHECKOUT_SESSION_ID%7D","{CHECKOUT_SESSION_ID}"));
    params.set("cancel_url",new URL("/?checkout=cancelled",siteUrl).toString());
    params.set("shipping_address_collection[allowed_countries][0]","GB");
    lines.forEach((l,i)=>{
      params.set(`line_items[${i}][price_data][currency]`,"gbp");
      params.set(`line_items[${i}][price_data][unit_amount]`,String(unitPence));
      params.set(`line_items[${i}][price_data][product_data][name]`,`${l.street_name}, ${l.locality} — Street Face mug`);
      params.set(`line_items[${i}][quantity]`,String(l.quantity));
    });
    const response = await fetch("https://api.stripe.com/v1/checkout/sessions",{method:"POST",headers:{Authorization:`Bearer ${stripeKey}`,"Content-Type":"application/x-www-form-urlencoded","Idempotency-Key":order.id},body:params});
    const stripe = await response.json();
    if (!response.ok || !stripe.id || !stripe.url) {
      await db.from("checkout_orders").update({checkout_status:"hold",hold_reason:"Stripe session creation failed"}).eq("id",order.id);
      throw new Error("Stripe session creation failed");
    }
    const {error:syncError} = await db.from("checkout_orders").update({checkout_status:"checkout_created",stripe_checkout_session_id:stripe.id}).eq("id",order.id);
    if (syncError) throw new Error("Unable to save Stripe session; order requires reconciliation");
    return json({url:stripe.url,order_id:order.id},200,origin);
  } catch (error) {
    console.error("Checkout failure",error);
    return json({error:"Unable to start checkout"},500,origin);
  }
});
