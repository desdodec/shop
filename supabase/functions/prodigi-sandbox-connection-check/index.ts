// Street Face: read-only Prodigi v4 Sandbox connectivity check.
// Never sends a POST to Prodigi, creates an order, or returns order data.
// Required Supabase Edge secrets:
//   PRODIGI_SANDBOX_API_KEY (the test_ key from sandbox-beta-dashboard.pwinty.com)
//   PRODIGI_PREVIEW_ADMIN_TOKEN (a separate random operator-only secret)
// Deploy with --no-verify-jwt ONLY if the independent operator token is configured.
// Do not link from the storefront; do not expose either key to browser JavaScript.
const PRODIGI_URL = "https://api.sandbox.prodigi.com/v4.0/Orders/?Top=1";

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
async function fingerprint(input: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
}
async function isAuthorized(received: string, token: string): Promise<boolean> {
  const [a, b] = await Promise.all([fingerprint(received), fingerprint(`Bearer ${token}`)]);
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < Math.min(a.length, b.length); i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== "POST") return reply(405, { error: "POST only" });
  const apiKey = Deno.env.get("PRODIGI_SANDBOX_API_KEY") ?? "";
  const operatorToken = Deno.env.get("PRODIGI_PREVIEW_ADMIN_TOKEN") ?? "";
  if (!operatorToken || operatorToken.length < 32 || !apiKey.startsWith("test_")) {
    return reply(503, { error: "Sandbox credentials or operator access not configured" });
  }
  if (!(await isAuthorized(request.headers.get("authorization") ?? "", operatorToken))) {
    return reply(403, { error: "Forbidden" });
  }
  let payload: unknown;
  try { payload = await request.json(); } catch { return reply(400, { error: "Invalid JSON" }); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || (payload as Record<string, unknown>).mode !== "check_connection") {
    return reply(400, { error: "Only check_connection is supported" });
  }
  try {
    const result = await fetch(PRODIGI_URL, {
      method: "GET",
      headers: { "X-API-Key": apiKey, "Accept": "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    // Never return Prodigi's response body: it may contain sandbox customer data.
    if (!result.ok) return reply(502, {
      connected: false, environment: "sandbox", api_version: "v4",
      prodigi_http_status: result.status,
    });
    return reply(200, {
      connected: true, environment: "sandbox", api_version: "v4",
      prodigi_http_status: result.status,
      order_created: false, production_enabled: false,
    });
  } catch (error) {
    console.error("Prodigi sandbox connectivity failure", error instanceof Error ? error.name : "unknown");
    return reply(502, { connected: false, error: "Sandbox connection failed" });
  }
});
