# Prodigi v4 Sandbox connection check

This function tests only **GET** `https://api.sandbox.prodigi.com/v4.0/Orders/?Top=1` using the separately stored `PRODIGI_SANDBOX_API_KEY`. It does not submit an order or return its order list.

## Secrets
- `PRODIGI_SANDBOX_API_KEY`: existing `test_` key from the Pwinty Sandbox dashboard.
- `PRODIGI_PREVIEW_ADMIN_TOKEN`: independently generated random operator secret, at least 32 characters. Never put either in GitHub or the browser.

## Deployment
Deploy `prodigi-sandbox-connection-check` as a Supabase Edge Function. The function implements bearer-token access and supports only a POST with JSON `{"mode":"check_connection"}`. With `--no-verify-jwt`, treat the operator token as a high-value secret and enforce rate limiting; no public storefront may call it.

## Test from Mac (only after deployment)
Set `PRODIGI_PREVIEW_ADMIN_TOKEN` locally via a password manager and run:

```bash
curl --fail-with-body --silent --show-error \
  "https://ngmdsmmvdnbnxeozpfej.supabase.co/functions/v1/prodigi-sandbox-connection-check" \
  -H "Authorization: Bearer $PRODIGI_PREVIEW_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"check_connection"}'
```

A successful reply includes `"connected":true`, `"environment":"sandbox"`, and `"order_created":false`.

No checkout, R2, or fulfilment changes are part of this test.
