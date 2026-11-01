// MANUALLY TRIGGERED ONE-TIME Prodigi v4 SANDBOX order, Acacia Grove only.
// NEVER called from the shop, Stripe webhook, or automatic fulfilment.
// Requires public.prodigi_sandbox_test_submissions table to be installed first.
// Fail-closed: once a submission is reserved, retries never POST again,
// even when the response is lost or the API returns an ambiguous failure.
import { createClient } from "npm:@supabase/supabase-js@2";
import { S3Client, GetObjectCommand, HeadObjectCommand } from "npm:@aws-sdk/client-s3@3";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner@3";

const DESIGN = "HBV2-0000";
const TEST_KEY = "acacia-grove-v2-first-sandbox";
const REFERENCE = "STREET-FACE-HBV2-0000-SANDBOX-ONCE";
const KEY = "street-face/hebden-bridge/v2/print_candidates/0000_Acacia Grove_wrap_print.png";
const ENDPOINT = "https://api.sandbox.prodigi.com/v4.0/Orders/";
const REQUIRED = [
  "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "PRODIGI_PREVIEW_ADMIN_TOKEN",
  "PRODIGI_SANDBOX_API_KEY", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY", "R2_BUCKET",
];
const respond = (status: number, value: Record<string, unknown>) =>
  new Response(JSON.stringify(value), { status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
async function digest(text: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}
async function auth(received: string, token: string) {
  const [a,b] = await Promise.all([digest(received),digest("Bearer " + token)]);
  let mismatch = a.length ^ b.length;
  for(let i=0;i<Math.min(a.length,b.length);i++) mismatch |= a[i]^b[i];
  return mismatch === 0;
}

Deno.serve(async (req) => {
  if(req.method !== "POST") return respond(405,{error:"POST only"});
  const adminToken = Deno.env.get("PRODIGI_PREVIEW_ADMIN_TOKEN") ?? "";
  if(!adminToken || !(await auth(req.headers.get("authorization") ?? "",adminToken)))
    return respond(403,{error:"Forbidden"});
  const missing=REQUIRED.filter(k=>!Deno.env.get(k));
  if(missing.length) return respond(503,{error:"Missing configuration",missing_secret_names:missing});
  if(!(Deno.env.get("PRODIGI_SANDBOX_API_KEY") ?? "").startsWith("test_"))
    return respond(503,{error:"Expected a v4 test_ Sandbox API key"});
  let body: Record<string,unknown>;
  try { body=await req.json(); } catch { return respond(400,{error:"Invalid JSON"}); }
  if(body.mode!=="submit_once" || body.design_code!==DESIGN ||
     body.confirmation!=="SUBMIT ONE ACACIA GROVE SANDBOX ORDER")
    return respond(400,{error:"Explicit Sandbox submission confirmation required"});

  const db=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    {auth:{persistSession:false,autoRefreshToken:false}});
  const {data:existing,error:existingError}=await db.from("prodigi_sandbox_test_submissions")
    .select("state,prodigi_order_id,http_status").eq("test_key",TEST_KEY).maybeSingle();
  if(existingError) return respond(503,{error:"Sandbox one-time guard unavailable; install SQL first"});
  if(existing) return respond(409,{error:"Sandbox submission already reserved; never retry automatically",
    state:existing.state,prodigi_order_id:existing.prodigi_order_id,http_status:existing.http_status});

  const {data:design,error:de}=await db.from("designs")
    .select("id,dataset_id,design_code,street_id,street_name,status").eq("design_code",DESIGN).maybeSingle();
  if(de||!design||design.status!=="hold"||design.street_name!=="Acacia Grove"||
     design.dataset_id!=="street-face/hebden-bridge/v2"||
     !String(design.street_id).startsWith("Acacia Grove__"))
    return respond(409,{error:"The Acacia Grove design failed release verification"});

  const {data:asset,error:ae}=await db.from("design_assets")
    .select("product_sku,version,production_key,validation_status")
    .eq("design_id",design.id).eq("product_sku","GLOBAL-MUG-W").eq("version",1).maybeSingle();
  if(ae||!asset||asset.production_key!==KEY)
    return respond(409,{error:"The production PNG does not match the imported asset"});

  const r2=new S3Client({
    region:"auto",
    endpoint:`https://${Deno.env.get("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    credentials:{
      accessKeyId:Deno.env.get("R2_ACCESS_KEY_ID")!,
      secretAccessKey:Deno.env.get("R2_SECRET_ACCESS_KEY")!,
    },
  });
  const bucket=Deno.env.get("R2_BUCKET")!;
  let imageUrl: string;
  try {
    const head=await r2.send(new HeadObjectCommand({Bucket:bucket,Key:KEY}));
    if(!head.ContentLength || head.ContentLength<1000)
      return respond(409,{error:"Production PNG missing or empty"});
    imageUrl=await getSignedUrl(r2,
      new GetObjectCommand({Bucket:bucket,Key:KEY,ResponseContentType:"image/png"}),
      {expiresIn:21600}); // 6 hours; order service may download asynchronously
    const check=await fetch(imageUrl,{headers:{Range:"bytes=0-23"}});
    if(!check.ok) return respond(502,{error:"Signed artwork GET failed",status:check.status});
    const bytes=new Uint8Array(await check.arrayBuffer());
    const sig=[137,80,78,71,13,10,26,10];
    if(bytes.length<24||!sig.every((v,i)=>bytes[i]===v))
      return respond(409,{error:"Art is not a PNG"});
    const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    if(v.getUint32(16)!==2670 || v.getUint32(20)!==1110)
      return respond(409,{error:"Production PNG dimensions mismatch"});
  } catch {
    return respond(502,{error:"Could not verify R2 artwork"});
  }

  // This fixed address is fictional and used ONLY in Sandbox.
  const order={
    merchantReference:REFERENCE,
    shippingMethod:"Standard",
    recipient:{
      name:"Street Face Sandbox Test",
      address:{
        line1:"14 Test Place",
        townOrCity:"London",
        postalOrZipCode:"SW1A 1AA",
        countryCode:"GB",
      },
    },
    items:[{
      merchantReference:DESIGN,
      sku:"GLOBAL-MUG-W",copies:1,sizing:"fillPrintArea",
      assets:[{printArea:"default",url:imageUrl}],
    }],
    metadata:{source:"street-face",purpose:"sandbox-manual-acacia-first"},
  };

  // Unique primary-key INSERT is the atomic one-time lock.
  // Deliberately DO NOT release this lock if the remote POST fails/times out:
  // a timeout could occur AFTER Prodigi accepted the order.
  const {error:reserveError}=await db.from("prodigi_sandbox_test_submissions").insert({
    test_key:TEST_KEY,design_code:DESIGN,state:"reserved",merchant_reference:REFERENCE,
    result_summary:"One-time reservation, Prodigi POST about to be attempted",
  });
  if(reserveError) return respond(409,{error:"Submission blocked: one-time reservation failed or already exists"});

  let httpStatus: number | null=null;
  let outcome="unknown";
  let orderId: string | null=null;
  let summary="Submission result uncertain; inspect Prodigi Sandbox dashboard before taking action";
  try {
    const result=await fetch(ENDPOINT,{
      method:"POST",
      headers:{"X-API-Key":Deno.env.get("PRODIGI_SANDBOX_API_KEY")!,
        "Content-Type":"application/json","Accept":"application/json"},
      body:JSON.stringify(order),
      signal:AbortSignal.timeout(30000),
    });
    httpStatus=result.status;
    // Extract only the order ID, never full recipient or signed-URL payload.
    let answer: Record<string,unknown>={};
    try { answer=await result.json(); } catch { /* no body */ }
    const raw=answer.order as Record<string,unknown>|undefined;
    const id=raw?.id ?? answer.id;
    if(typeof id==="string"&&id.startsWith("ord_")) orderId=id;
    if(result.ok && orderId) {
      outcome="accepted";summary="Sandbox order accepted by Prodigi";
    } else if(result.status>=400&&result.status<500) {
      outcome="rejected";summary="Prodigi returned client validation error; inspect Sandbox dashboard";
    } else {
      summary="Prodigi response ambiguous; inspect Sandbox dashboard before any further action";
    }
  } catch {
    summary="Prodigi request failed or timed out; order may have been accepted";
  }
  // If this update fails, the reserved row still blocks duplicate submission.
  const {error:logError}=await db.from("prodigi_sandbox_test_submissions")
    .update({state:outcome,prodigi_order_id:orderId,http_status:httpStatus,
      result_summary:summary,updated_at:new Date().toISOString()})
    .eq("test_key",TEST_KEY).eq("state","reserved");
  return respond(outcome==="accepted"?200:202,{
    environment:"sandbox",api_version:"v4",state:outcome,
    merchant_reference:REFERENCE,prodigi_order_id:orderId,
    prodigi_http_status:httpStatus,summary,
    audit_saved:!logError,duplicate_submission_blocked:true,
    live_order_created:false,automatic_fulfilment_enabled:false,
  });
});
