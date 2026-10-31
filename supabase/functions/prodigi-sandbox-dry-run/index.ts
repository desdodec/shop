// Street Face — Prodigi sandbox preparation (DRY RUN ONLY).
// No Prodigi API calls. No order creation. No database mutations.
// Deploy privately; DO NOT place this endpoint in the public storefront.
// Required Edge Function secrets:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   PRODIGI_PREVIEW_ADMIN_TOKEN (random secret, distinct from other tokens)
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
// Uses temporary R2 GET-only signed URL for ONE fixed test design.
// Deploy with --no-verify-jwt and guard via the separate token below,
// or keep JWT verification enabled and configure service-to-service invocation.
import { createClient } from "npm:@supabase/supabase-js@2";
import { S3Client, HeadObjectCommand, GetObjectCommand } from "npm:@aws-sdk/client-s3@3";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner@3";

const DESIGN = "HBV2-0000";
const EXPECTED_KEY = "street-face/hebden-bridge/v2/print_candidates/0000_Acacia Grove_wrap_print.png";
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const response = (status: number, value: Record<string, unknown>) =>
  new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });

Deno.serve(async (request) => {
  if (request.method !== "POST") return response(405, { error: "Method not allowed" });
  const required = ["SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY","PRODIGI_PREVIEW_ADMIN_TOKEN",
    "R2_ACCOUNT_ID","R2_ACCESS_KEY_ID","R2_SECRET_ACCESS_KEY","R2_BUCKET"];
  if (required.some(name => !Deno.env.get(name))) return response(503, { error: "Not configured" });
  const authorization = request.headers.get("authorization") ?? "";
  const secret = Deno.env.get("PRODIGI_PREVIEW_ADMIN_TOKEN")!;
  // Compare a SHA-256 digest rather than raw strings.
  const encoder = new TextEncoder();
  const sha = async (value: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  const actual = await sha(authorization);
  const expected = await sha("Bearer " + secret);
  let difference = actual.length ^ expected.length;
  for (let i=0; i<Math.min(actual.length,expected.length); i++) difference |= actual[i] ^ expected[i];
  if (difference !== 0) return response(403, { error: "Forbidden" });

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return response(400, { error: "Invalid JSON" }); }
  if (body.mode !== "dry_run" || body.design_code !== DESIGN)
    return response(400, { error: "Only Acacia Grove dry_run is supported" });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: design, error: dError } = await supabase.from("designs")
    .select("id,design_code,dataset_id,street_id,street_name,status")
    .eq("design_code", DESIGN).maybeSingle();
  if (dError || !design || design.status !== "hold" || design.street_name !== "Acacia Grove"
      || !design.dataset_id || !String(design.street_id).startsWith("Acacia Grove__"))
    return response(409, { error: "Design failed safety checks" });

  const { data: assets, error: aError } = await supabase.from("design_assets")
    .select("product_sku,version,production_key,validation_status")
    .eq("design_id", design.id).eq("product_sku", "GLOBAL-MUG-W").eq("version", 1);
  if (aError || !assets || assets.length !== 1 || assets[0].production_key !== EXPECTED_KEY)
    return response(409, { error: "Production artwork does not match the expected release" });
  const account = Deno.env.get("R2_ACCOUNT_ID")!;
  const bucket = Deno.env.get("R2_BUCKET")!;
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${account}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: Deno.env.get("R2_ACCESS_KEY_ID")!,
      secretAccessKey: Deno.env.get("R2_SECRET_ACCESS_KEY")!,
    },
  });
  let size: number | undefined;
  let signedUrl: string;
  try {
    const metadata = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: EXPECTED_KEY }));
    size = metadata.ContentLength;
    if (!size || size < 1000) return response(409, { error: "Empty or implausible artwork file" });
    signedUrl = await getSignedUrl(client,
      new GetObjectCommand({ Bucket: bucket, Key: EXPECTED_KEY, ResponseContentType: "image/png" }),
      { expiresIn: 900 });
  } catch (error) {
    console.error("R2 read/sign failed", error instanceof Error ? error.name : "unknown");
    return response(502, { error: "Could not verify R2 object" });
  }
  // Verify that the signed URL actually retrieves a production PNG.
  // The signed URL is NEVER returned to the caller or logged.
  let pngWidth = 0;
  let pngHeight = 0;
  let signedGetStatus = 0;
  try {
    const imageResponse = await fetch(signedUrl, {
      method: "GET", headers: { Range: "bytes=0-23" }
    });
    signedGetStatus = imageResponse.status;
    if (!imageResponse.ok)
      return response(502, { error: "Signed artwork retrieval failed", signed_get_status: signedGetStatus });
    const bytes = new Uint8Array(await imageResponse.arrayBuffer());
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 24 || !signature.every((n, i) => bytes[i] === n))
      return response(409, { error: "The R2 object did not return a PNG header" });
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    pngWidth = data.getUint32(16);
    pngHeight = data.getUint32(20);
    if (pngWidth !== 2670 || pngHeight !== 1110)
      return response(409, { error: "Unexpected PNG dimensions", png_width: pngWidth, png_height: pngHeight });
  } catch {
    return response(502, { error: "Cannot fetch or inspect signed production PNG" });
  }
  return response(200, {
    mode: "dry_run", submitted_to_prodigi: false,
    design_id: design.id, design_code: design.design_code, street_key: design.street_id,
    product_sku: "GLOBAL-MUG-W", copies: 1,
    png_key: EXPECTED_KEY, png_bytes: size, signed_get_status: signedGetStatus,
    png_width: pngWidth, png_height: pngHeight, signed_png_access_verified: true,
    validation_status: assets[0].validation_status,
    warnings: [
      "No Prodigi order was created.",
      "A signed URL is a short-lived access credential; do not share it publicly.",
      "Technical validation is not print approval.",
      "Do not enable live fulfilment before sample approval."
    ],
  });
});
