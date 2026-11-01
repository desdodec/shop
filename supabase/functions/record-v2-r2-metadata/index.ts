// Street Face — guarded metadata recorder for Hebden Bridge v2 only.
// NO artwork status changes, NO Prodigi calls and NO checkout/order changes.
// Modes: "preview" (read only), "apply" (write size + ETag only).
// Requires public.record_v2_production_object_metadata RPC to be installed.
import { createClient } from "npm:@supabase/supabase-js@2";
import { S3Client, HeadObjectCommand } from "npm:@aws-sdk/client-s3@3";

const DATASET = "street-face/hebden-bridge/v2";
const PREFIX = "street-face/hebden-bridge/v2/print_candidates/";
const EXPECTED = 311;
const reply = (status: number, result: unknown) => new Response(JSON.stringify(result), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
async function digest(x: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(x)));
}
async function authenticated(got: string, secret: string) {
  const [a,b]=await Promise.all([digest(got),digest("Bearer "+secret)]);
  let diff=a.length^b.length;
  for(let i=0;i<Math.min(a.length,b.length);i++) diff|=a[i]^b[i];
  return diff===0;
}

Deno.serve(async request => {
  if(request.method!=="POST") return reply(405,{error:"POST only"});
  const admin=Deno.env.get("PRODIGI_PREVIEW_ADMIN_TOKEN")??"";
  if(!admin || !(await authenticated(request.headers.get("authorization")??"",admin)))
    return reply(403,{error:"Forbidden"});
  const need=["SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY","R2_ACCOUNT_ID","R2_ACCESS_KEY_ID","R2_SECRET_ACCESS_KEY","R2_BUCKET"];
  const absent=need.filter(n=>!Deno.env.get(n));
  if(absent.length) return reply(503,{error:"Missing configuration",missing_secret_names:absent});
  let body: Record<string,unknown>;
  try {body=await request.json();}catch{return reply(400,{error:"Invalid JSON"});}
  if(body.dataset_id!==DATASET || !["preview","apply"].includes(String(body.mode)))
    return reply(400,{error:"Invalid audit mode or dataset"});
  const apply=body.mode==="apply";
  if(apply && body.confirmation!=="RECORD R2 METADATA FOR 311 HELD V2 DESIGNS")
    return reply(400,{error:"Exact write confirmation required"});

  const db=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    {auth:{persistSession:false,autoRefreshToken:false}});
  const {data:designs,error:de}=await db.from("designs")
    .select("id,design_code,street_id,status")
    .eq("dataset_id",DATASET).order("design_code").limit(400);
  if(de || !designs || designs.length!==EXPECTED ||
    new Set(designs.map(d=>d.id)).size!==EXPECTED ||
    new Set(designs.map(d=>d.street_id)).size!==EXPECTED ||
    designs.some(d=>d.status!=="hold"))
    return reply(409,{error:"Release identity, cardinality or hold status failed"});

  const {data:assets,error:ae}=await db.from("design_assets")
    .select("design_id,production_key,production_size,production_etag,validation_status")
    .in("design_id",designs.map(d=>d.id))
    .eq("product_sku","GLOBAL-MUG-W").eq("version",1).limit(400);
  if(ae || !assets || assets.length!==EXPECTED || new Set(assets.map(a=>a.design_id)).size!==EXPECTED ||
     assets.some(a=>a.validation_status!=="pending"))
    return reply(409,{error:"Asset records are incomplete or no longer pending"});
  const byId=new Map(assets.map(a=>[a.design_id,a]));
  const s3=new S3Client({
    region:"auto",
    endpoint:`https://${Deno.env.get("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    credentials:{accessKeyId:Deno.env.get("R2_ACCESS_KEY_ID")!,
      secretAccessKey:Deno.env.get("R2_SECRET_ACCESS_KEY")!},
    maxAttempts:2,
  });
  const bucket=Deno.env.get("R2_BUCKET")!;
  const rows: {design_id:string; design_code:string; key:string; bytes:number; etag:string; existing_size:number|null; existing_etag:string|null}[]=[];
  const errors: {design_code:string; reason:string}[]=[];
  // Strict two-phase approach: collect and validate ALL 311 HEAD results before any write.
  for(let i=0;i<designs.length;i+=8) {
    const checks=await Promise.all(designs.slice(i,i+8).map(async d=>{
      const a=byId.get(d.id);
      const key=a?.production_key ?? "";
      if(!key.startsWith(PREFIX)||!key.endsWith("_wrap_print.png")||key.includes(".."))
        return {error:{design_code:d.design_code,reason:"invalid_key"}};
      try {
        const h=await s3.send(new HeadObjectCommand({Bucket:bucket,Key:key}));
        const bytes=h.ContentLength??0;
        const etag=(h.ETag??"").replace(/^"|"$/g,"");
        if(bytes<1000||!/^[A-Za-z0-9_-]{8,128}$/.test(etag))
          return {error:{design_code:d.design_code,reason:"invalid_r2_metadata"}};
        if((a?.production_size!=null && Number(a.production_size)!==bytes)||
           (a?.production_etag!=null&&String(a.production_etag).replace(/^"|"$/g,"")!==etag))
          return {error:{design_code:d.design_code,reason:"existing_db_metadata_mismatch"}};
        return {row:{design_id:d.id,design_code:d.design_code,key,bytes,etag,
          existing_size:a?.production_size??null,existing_etag:a?.production_etag??null}};
      } catch {
        return {error:{design_code:d.design_code,reason:"r2_head_failed"}};
      }
    }));
    for(const result of checks) {
      if(result.error) errors.push(result.error);
      else if(result.row) rows.push(result.row);
    }
  }
  if(errors.length || rows.length!==EXPECTED)
    return reply(409,{mode:body.mode,checked:rows.length+errors.length,
      ready_to_write:false,errors,metadata_written:false});
  if(!apply) return reply(200,{
    mode:"preview",checked:EXPECTED,ready_to_write:true,
    already_populated:rows.filter(r=>r.existing_size!==null&&r.existing_etag!==null).length,
    missing_metadata:rows.filter(r=>r.existing_size===null||r.existing_etag===null).length,
    metadata_written:false,validation_status_unchanged:true,
  });

  const changes:Record<string,number>={updated:0,unchanged:0,failed:0};
  const failures:{design_code:string;reason:string}[]=[];
  for(const row of rows) {
    const {data,error}=await db.rpc("record_v2_production_object_metadata",{
      p_design_id:row.design_id,p_production_key:row.key,
      p_size:row.bytes,p_etag:row.etag,
    });
    if(error || !["updated","unchanged"].includes(data)) {
      changes.failed++;
      failures.push({design_code:row.design_code,reason:"guarded_database_update_failed"});
    } else changes[data]=(changes[data]??0)+1;
  }
  return reply(changes.failed?207:200,{
    mode:"apply",checked:EXPECTED,changes,failures,
    validation_status_unchanged:true,design_status_unchanged:true,
    prodigi_contacted:false,automatic_fulfilment_enabled:false,
    note:"Metadata-only writes; print approval remains pending.",
  });
});
