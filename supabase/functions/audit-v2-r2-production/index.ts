// Street Face: READ-ONLY audit of all Hebden Bridge v2 production PNG objects.
// No database mutations, no Prodigi calls, no signed URLs returned.
// Protected by PRODIGI_PREVIEW_ADMIN_TOKEN; deploy with legacy JWT verification OFF.
import { createClient } from "npm:@supabase/supabase-js@2";
import { S3Client, HeadObjectCommand } from "npm:@aws-sdk/client-s3@3";

const DATASET = "street-face/hebden-bridge/v2";
const PREFIX = "street-face/hebden-bridge/v2/print_candidates/";
const LIMIT = 311;

const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});
async function hash(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
async function authorized(header: string, secret: string): Promise<boolean> {
  const [a, b] = await Promise.all([hash(header), hash("Bearer " + secret)]);
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < Math.min(a.length, b.length); i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return respond(405, { error: "POST required" });
  const token = Deno.env.get("PRODIGI_PREVIEW_ADMIN_TOKEN") ?? "";
  if (!token || !(await authorized(request.headers.get("authorization") ?? "", token)))
    return respond(403, { error: "Forbidden" });

  const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"];
  const missing = required.filter(n => !Deno.env.get(n));
  if (missing.length) return respond(503, { error: "Missing configuration", missing_secret_names: missing });
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return respond(400, { error: "Invalid JSON" }); }
  if (body.mode !== "audit" || body.dataset_id !== DATASET)
    return respond(400, { error: "Only Hebden Bridge v2 read-only audit is supported" });

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: designs, error: designError } = await db.from("designs")
    .select("id,design_code,street_id,status")
    .eq("dataset_id", DATASET).order("design_code").limit(400);
  if (designError || !designs) return respond(502, { error: "Could not read v2 designs" });
  if (designs.length !== LIMIT || new Set(designs.map(d => d.id)).size !== LIMIT)
    return respond(409, { error: "Unexpected v2 design count", count: designs.length });
  if (designs.some(d => d.status !== "hold"))
    return respond(409, { error: "Some v2 designs are no longer held; audit aborted" });
  const ids = designs.map(d => d.id);
  const { data: assets, error: assetError } = await db.from("design_assets")
    .select("design_id,product_sku,version,production_key,production_size,production_etag,validation_status")
    .in("design_id", ids).eq("product_sku", "GLOBAL-MUG-W").eq("version", 1).limit(400);
  if (assetError || !assets || assets.length !== LIMIT)
    return respond(409, { error: "Expected exactly 311 mug asset records", count: assets?.length ?? null });
  const byDesign = new Map(assets.map(a => [a.design_id, a]));
  if (byDesign.size !== LIMIT) return respond(409, { error: "Duplicate asset identities" });

  const client = new S3Client({
    region: "auto", endpoint: `https://${Deno.env.get("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: Deno.env.get("R2_ACCESS_KEY_ID")!,
      secretAccessKey: Deno.env.get("R2_SECRET_ACCESS_KEY")!,
    },
    maxAttempts: 2,
  });
  const bucket = Deno.env.get("R2_BUCKET")!;
  const rows: Record<string, unknown>[] = [];
  // Small fixed concurrency avoids overwhelming the R2 or Supabase runtime.
  for (let start = 0; start < designs.length; start += 8) {
    const batch = designs.slice(start, start + 8);
    const batchRows = await Promise.all(batch.map(async d => {
      const a = byDesign.get(d.id);
      const key = a?.production_key ?? "";
      const row: Record<string, unknown> = {
        design_code: d.design_code, street_key: d.street_id,
        object_key: key, database_validation_status: a?.validation_status ?? null,
        database_size: a?.production_size ?? null, database_etag: a?.production_etag ?? null,
        r2_exists: false, r2_bytes: null, r2_etag: null, result: "ERROR",
      };
      if (!key.startsWith(PREFIX) || !key.endsWith("_wrap_print.png") || key.includes("..")) {
        row.result = "INVALID_OBJECT_KEY";
        return row;
      }
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        row.r2_exists = true;
        row.r2_bytes = result.ContentLength ?? null;
        row.r2_etag = result.ETag?.replace(/^"|"$/g, "") ?? null;
        if (!result.ContentLength || result.ContentLength < 1000) row.result = "EMPTY_OR_SMALL";
        else if (a?.production_size != null && Number(a.production_size) !== result.ContentLength)
          row.result = "DB_SIZE_MISMATCH";
        else if (a?.production_etag && String(a.production_etag).replace(/^"|"$/g,"") !== row.r2_etag)
          row.result = "DB_ETAG_MISMATCH";
        else row.result = "R2_OBJECT_PRESENT";
      } catch (error) {
        const name = error && typeof error === "object" && "name" in error
          ? String((error as {name: unknown}).name) : "UnknownError";
        row.result = name === "NotFound" || name === "NoSuchKey" ? "MISSING" : "R2_HEAD_ERROR";
        row.error_type = name.slice(0, 80);
      }
      return row;
    }));
    rows.push(...batchRows);
  }
  const counts: Record<string,number> = {};
  for (const row of rows) {
    const key = String(row.result);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const needsReview = rows.filter(r => r.result !== "R2_OBJECT_PRESENT");
  return respond(200, {
    mode: "audit", dataset_id: DATASET, expected: LIMIT, checked: rows.length,
    summary: counts, all_objects_present: counts.R2_OBJECT_PRESENT === LIMIT,
    db_sizes_populated: rows.filter(r => typeof r.database_size === "number" && Number(r.database_size)>0).length,
    review_rows: needsReview,
    // Full mapping returned for operator-controlled export; no production file bytes or signed URLs.
    rows, database_modified: false, prodigi_contacted: false,
    warning: "HEAD metadata verifies existence and size, NOT PNG integrity or print approval.",
  });
});
