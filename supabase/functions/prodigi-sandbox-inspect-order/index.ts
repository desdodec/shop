// Read-only Prodigi v4 Sandbox order inspection for one previously created test.
// No Prodigi POST, no database writes, no signed artwork URLs in the response.
// Requires PRODIGI_SANDBOX_API_KEY and PRODIGI_PREVIEW_ADMIN_TOKEN.
const ORDER_ID = "ord_1194085";
const REFERENCE = "STREET-FACE-HBV2-0000-SANDBOX-ONCE";
function json(status: number, data: Record<string, unknown>) {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
async function hash(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
async function authenticated(received: string, secret: string) {
  const [a,b] = await Promise.all([hash(received),hash("Bearer " + secret)]);
  let difference = a.length ^ b.length;
  for (let i=0;i<Math.min(a.length,b.length);i++) difference |= a[i]^b[i];
  return difference === 0;
}
function safeString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function safeStatus(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = value as Record<string,unknown>;
  return { stage:safeString(status.stage), issues:Array.isArray(status.issues)
    ? status.issues.map(item => {
        if (typeof item === "string") return item.slice(0,160);
        if (item && typeof item === "object") {
          const o=item as Record<string,unknown>;
          return { code:safeString(o.code), type:safeString(o.type), description:safeString(o.description)?.slice(0,160) };
        }
        return null;
      })
    : [] ,
    details: (() => {
      const d=status.details;
      if (!d || typeof d!=="object" || Array.isArray(d)) return null;
      const o=d as Record<string,unknown>;
      return {downloadAssets:safeString(o.downloadAssets),
        printReadyAssetsPrepared:safeString(o.printReadyAssetsPrepared),
        allocateProductionLocation:safeString(o.allocateProductionLocation)};
    })(),
  };
}
Deno.serve(async (request: Request) => {
  if(request.method!=="POST") return json(405,{error:"POST required"});
  const token=Deno.env.get("PRODIGI_PREVIEW_ADMIN_TOKEN") ?? "";
  if(!token || !(await authenticated(request.headers.get("authorization") ?? "",token)))
    return json(403,{error:"Forbidden"});
  const key=Deno.env.get("PRODIGI_SANDBOX_API_KEY") ?? "";
  if(!key.startsWith("test_")) return json(503,{error:"Prodigi v4 Sandbox key unavailable"});
  let payload:Record<string,unknown>;
  try { payload=await request.json(); } catch { return json(400,{error:"Invalid JSON"}); }
  if(payload.mode!=="inspect_order" || payload.order_id!==ORDER_ID)
    return json(400,{error:"Only the first Acacia Grove Sandbox order can be inspected"});
  let upstream: Response;
  try {
    upstream=await fetch(`https://api.sandbox.prodigi.com/v4.0/Orders/${ORDER_ID}`,{
      method:"GET",headers:{"X-API-Key":key,"Accept":"application/json"},
      signal:AbortSignal.timeout(15000),
    });
  } catch { return json(502,{error:"Prodigi Sandbox could not be reached"}); }
  if(!upstream.ok) return json(502,{error:"Prodigi returned a non-success response",prodigi_http_status:upstream.status});
  let body:Record<string,unknown>;
  try {body=await upstream.json();}catch{return json(502,{error:"Prodigi returned invalid JSON"});}
  const order=(body.order ?? null) as Record<string,unknown>|null;
  if(!order || order.id!==ORDER_ID || order.merchantReference!==REFERENCE)
    return json(409,{error:"Prodigi order identity or merchant reference mismatch"});
  const rawItems=Array.isArray(order.items)?order.items:[];
  const items=rawItems.map(item=>{
    if(!item||typeof item!=="object")return null;
    const i=item as Record<string,unknown>;
    const assets=Array.isArray(i.assets)?i.assets:[];
    return {sku:safeString(i.sku),copies:typeof i.copies==="number"?i.copies:null,
      merchant_reference:safeString(i.merchantReference),
      item_status:safeString(i.status),
      assets:assets.map(asset=>{
        if(!asset||typeof asset!=="object")return null;
        const a=asset as Record<string,unknown>;
        return {print_area:safeString(a.printArea),status:safeString(a.status),
          has_md5_hash:typeof a.md5Hash==="string" && a.md5Hash.length>0};
      }).filter(Boolean)};
  }).filter(Boolean);
  return json(200,{
    environment:"sandbox",order_id:ORDER_ID,merchant_reference:REFERENCE,
    last_updated:safeString(order.lastUpdated),created:safeString(order.created),
    status:safeStatus(order.status),items,
    note:"No recipient, artwork URL, or production credentials returned. Read-only; no order was created.",
  });
});
