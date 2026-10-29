# Street Face — Stripe sandbox checkout (development branch)

Branch: `feature/stripe-sandbox-checkout`. **Do not merge or enable a live Buy button yet.**

## What this branch adds

- `supabase/stripe_checkout_pilot.sql`: private order header, multi-line immutable design/asset snapshots, event audit, fulfilment attempts.
- `supabase/functions/create-checkout/index.ts`: server-side validation of a 1–4 mug basket, £20/mug, creates a Stripe **test-mode** hosted Checkout Session. All customer-supplied prices/asset paths are ignored.
- `supabase/functions/stripe-webhook/index.ts`: validates the Stripe webhook signature, re-reads payment status from Stripe and holds orders pending human fulfilment review.

These are **initial implementation files, not tested or deployed**. The live site still has its disabled Etsy button. No Prodigi API is called.

## Manual setup / prerequisites

1. Review and apply `supabase/stripe_checkout_pilot.sql` in the **development** Supabase project (or use a fresh isolated staging project). Confirm catalogue and active `GLOBAL-MUG-W` version-1 validated assets exist.
2. Set Supabase function secrets on the **server**:
   - `STRIPE_SECRET_KEY` (must begin with `sk_test_`)
   - `STRIPE_WEBHOOK_SECRET` (Stripe sandbox endpoint signature secret; webhook function only)
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SITE_URL` (site's exact base origin, e.g. test Netlify URL)
   - `ALLOWED_ORIGIN` (same exact origin allowed for browser checkout)
   - `STREET_FACE_DATASET_ID` (actual current catalogue dataset ID)
   - `STREET_FACE_COLLECTION_ID` (current collection ID)
3. Deploy the Edge Functions with `verify_jwt=false` only after rate limits / abuse mitigation are added; browser customers do not have Supabase user JWTs. The functions must not be left public without production controls.
4. Configure the Stripe sandbox webhook endpoint to invoke `stripe-webhook` for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, and `checkout.session.expired`. Add the signing secret to Supabase.
5. Before turning on the site checkout, implement success/cancel pages and a server-side status endpoint that returns **only safe customer-facing information**. Never show `service_role` secrets or production asset storage paths.

## Expected basket request

```json
{"items":[{"design_code":"HB-0001","quantity":1},{"design_code":"HB-0002","quantity":2}]}
```

`POST /functions/v1/create-checkout`, `Content-Type: application/json`. The response is a Stripe-hosted test checkout `url`. The browser should redirect to that URL, and must never decide the amount or fulfilment identity.

This pilot deliberately caps orders at **four mugs total**, charges **£20 per mug including UK delivery**, and restricts Stripe shipping address selection to Great Britain (`GB`). It does **not** calculate live Prodigi shipping or VAT.

The preliminary margins depend on Prodigi quotes supplied by the shop owner:
- Mug: £4.25 before VAT
- UK shipping: 1 = £5.50, 2 = £7.00, 3 = £8.50, 4 = £10.00
- Prodigi tax on the original one-mug quote: £1.95
- Stripe fee: estimate 1.5% + £0.20 for a standard UK card

All totals must be re-verified prior to launch and profit accounting should allow for refunds, taxes and overhead.

## Open release blockers (MUST resolve before public checkout)

- No Stripe keys or Supabase secrets have been installed or tested.
- Existing browser basket is stored in localStorage; it is **not** an authoritative order. No frontend checkout wiring exists on this branch.
- No deployed webhook, webhook concurrency tests, order recovery or retry worker.
- On payment success, current handler only validates totals and the stored asset reference; it does not independently re-check all line/product/asset statuses. Add a transaction-safe final approval step and payment-event reconciliation; handle out-of-order webhook events and duplicate events.
- Session creation and order-line inserts are separate DB transactions. Implement cleanup/reconciliation of orphaned orders.
- Add rate-limits, anti-automation protections, and strict site origin enforcement at edge/network level. CORS is not authentication.
- Verify Stripe API semantics and compile/type-check both Edge Functions in Supabase staging. Review the Stripe SDK pinned version and shipping/session fields.
- Confirm the Stripe quote, payment tax treatment, packaging, shipping, refunds, privacy policy and UK consumer rights.
- No supplier production files should become publicly accessible, including via UI success page.
- No automatic release to Prodigi; manual approval remains mandatory. Prodigi sandbox testing is a later milestone.
- Do not insert live Stripe secrets while test-mode guard is present.

## Test acceptance criteria

1. Select two real catalogue design codes and quantities 1 + 2.
2. Call the server endpoint with forged client price and confirm it is ignored.
3. Reject unknown, disabled, nonvalidated, mismatched and over-four-quantity designs.
4. Verify Stripe Checkout charges £60.00 and collects a UK shipping address.
5. Complete a sandbox payment; verify the matching order, design IDs, asset versions, quantities and authoritative `payment_status=paid`.
6. Replay webhook events and reorder deliveries; no double fulfilment or erroneous state changes.
7. Force incorrect amount, currency, session ID and missing artwork: order remains on HOLD.
8. Check fail-closed behavior and demonstrate that anonymous users cannot read private orders or assets.
9. No Prodigi production occurs.

Current work deliberately **stops before acceptance tests and deployment**.
