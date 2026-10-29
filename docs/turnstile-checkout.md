# Stripe sandbox checkout: bot-verification gate

The public `create-checkout` Edge Function is intentionally **fail-closed** until
Cloudflare Turnstile is fully configured on both the website and Supabase.

## Setup (no live payments)
1. In Cloudflare Turnstile, create a site/widget for `hebdenbridgemugs.netlify.app`.
   Choose managed mode (minimises customer friction).
2. Set the **secret key** in Supabase Edge Function secrets as
   `TURNSTILE_SECRET_KEY`. Do not commit or paste the secret in chat.
3. Embed the **public site key** on the website and obtain a token when the
   customer clicks checkout.
4. Include the token as `turnstile_token` in the POST JSON to
   `/functions/v1/create-checkout`, alongside the basket `items`.
5. Test invalid/absent/expired/reused tokens, incorrect hostname, and normal
   browser checkout flow. A real Turnstile response must have `success: true`
   and hostname matching `SITE_URL`.
6. Add rate limiting and monitoring before public launch; Turnstile is an
   abuse barrier, not a complete replacement for rate limits.

Without the secret or a valid token, the checkout function will return
HTTP 503 or 403 without creating a Stripe Session. This is intentional.

The public storefront checkout button remains disabled. There is no automatic
Prodigi order submission. Test Stripe keys must remain `sk_test_` only.
