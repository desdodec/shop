# Street Face — paid-order handoff audit and pilot contract

Status: **design and audit only** (2026-10-22). This document does not enable Etsy checkout or live Prodigi fulfilment.

## Findings from the current repository

- `site/index.html`: Etsy checkout button is disabled.
- `site/app.js`: selections are stored in localStorage under a collection-specific key. These are **not authoritative orders**, cannot be trusted for pricing or print-file identity, and are not transferred to Etsy.
- `supabase/public_catalogue.sql`: a read-only catalogue RPC returns design code, street ID, street name, locality, and PUBLIC mockup keys only. Production keys and design UUIDs are deliberately withheld. Preserve this boundary.
- `catalogue_import/schema.sql`: `designs` has `(dataset_id, street_id)` uniqueness and `design_code`; `design_assets` has SKU, version, production key and validation status. The existing `orders` table models a single design per row and does not yet provide receipt + multiple lines + quantity + idempotent fulfilment.
- `docs/architecture.md` already warns that an external selection cannot be assumed to arrive automatically in an Etsy cart.
- No Etsy OAuth, receipt webhook, basket reservation, checkout handoff, or Prodigi ordering code is present in this repository.

## Practical first-sale choice

**Pilot: one street mug per Etsy purchase, reviewed manually before any production.**

Candidate routes (neither is verified in this shop):
A. One Etsy listing with required buyer personalization containing a server-issued, single-use order reference. The buyer must enter/confirm the exact reference in Etsy, and the seller must verify the paid transaction's personalization and quantity.
B. One Etsy listing per sellable street design (or other Etsy-supported variation model), with a stable listing/product/SKU -> internal design mapping. No buyer-provided reference required, but listing maintenance becomes substantial as the catalogue grows.

**Recommended initial investigation:** test route A with a PRIVATE/DRAFT test listing or otherwise controlled Etsy setup and a real recorded example of the resulting receipt transaction. Do not publish a working purchase button until this is proven. Etsy personalization currently uses dedicated typed inputs; do not build on deprecated free-text listing fields.

External checkout cannot be assumed to preload Etsy cart items, and a mere deep link to an Etsy listing does **not** transmit the selected street.

## Immutable order intent — server side

A server-issued opaque reference should point to a snapshot, not to client-supplied street names or production paths:

- `intent_id`: random, opaque, non-enumerable reference. One-use or securely managed reuse.
- `collection_id`, `dataset_id`, `design_id` (internal UUID), `design_code`, `street_id`.
- `product_sku = GLOBAL-MUG-W`, `design_asset_version`, `production_key` resolved on the server at reservation time; **never** sent to browser or Etsy.
- `quantity = 1` for pilot, expected Etsy listing/product ID, expected currency and price, created/expiry timestamps.
- Status: `draft`, `awaiting_payment`, `paid_unverified`, `hold`, `validated`, `submitted`, `cancelled`, etc.
- Buyer-facing display: exact street, locality, mug preview, and an opaque reference. Buyer reference is not itself proof of payment.

Production keys must be looked up server-side from a validated, active design and a validated asset for the chosen SKU/version; fail closed on missing/ambiguous entries. Never trust catalogue data or localStorage as authority for a paid order.

## Etsy paid-order reconciliation

1. Confirm the seller has authorised Etsy OAuth with required scopes. Record shop ID and allowed listing/product IDs. Store credentials server-side only.
2. Receive Etsy `order.paid` webhook; verify its authenticity according to Etsy documentation, accept retry deliveries safely, and fetch the authoritative receipt and its transactions through the Etsy API. Polling can be a safety reconciliation fallback.
3. Validate receipt shop, paid status, listing/product identity, paid currency/price where applicable, quantity = 1 for pilot, and the buyer-supplied personalization reference (route A) or listing-product mapping (route B).
4. Match to exactly one unexpired intent, reject reused/cancelled/foreign intents, and ensure the immutable intent matches the expected design and asset version.
5. Atomically mark receipt/transaction matched. Store provider event IDs and receipt/transaction IDs with unique constraints for duplicate prevention.
6. Mark any mismatch `HOLD` with reason. **Never** automatically substitute artwork or submit to Prodigi.

Warning: Etsy `order.paid` can precede later cancellation/refund. Include cancellation and customer-support procedures; for the pilot require human verification before fulfilment.

## Prodigi fulfilment safety

- Test only in Prodigi **sandbox** until a sample receipt has been verified and artwork ownership/quality approved.
- Confirm the current product's actual print-area/asset requirements with Prodigi product lookup, not by guessing from SKU.
- Prodigi needs to fetch the print file by HTTP GET, without cookies/credentials. Supply a narrowly scoped, short-lived, signed download URL to the **private** production asset after validation; verify the URL lifetime accommodates Prodigi's download retries. Never expose it via public catalogue endpoints.
- Use provider-supported idempotency on order creation plus an internal unique fulfilment key. Prevent both duplicate and race-condition submissions.
- Manual approval gate for pilot. Only submit a live order after confirmed paid receipt, correct design/quantity/asset, shipping details and validated costs.
- Store Prodigi order ID and status; reconcile failures, cancellations, retries and shipment updates.

## Data migration needed (do not apply yet)

Build a separate migration with:
- `checkout_intents`: immutable line snapshots, expected Etsy listing/product, quantity, expiry and lifecycle.
- `etsy_receipts`: unique shop_id + receipt_id, webhook metadata, paid/cancelled state and audit.
- `etsy_order_lines`: unique shop_id + transaction_id, receipt FK, intent FK, qty, immutable design ID/SKU/asset version and state.
- `fulfilment_attempts`: unique order-line + attempt number, idempotency key, provider order ID, outcome and audit.
- Support separate order header and N lines before enabling a multi-mug basket.
- Row-level security/revoked browser access for all private order tables. Secrets never in public site config.

## Release gates

- [ ] Etsy shop ownership and API authorisation confirmed.
- [ ] A real example receipt/transaction shows the expected design reference or a reliable listing/SKU mapping.
- [ ] One-design purchase flow successfully reconciled end-to-end with the *exact* design.
- [ ] Duplicate paid events do not create duplicate fulfilment orders.
- [ ] Incorrect/missing design reference, quantity, payment or print asset produces HOLD.
- [ ] Prodigi sandbox accepts a verified print file for `GLOBAL-MUG-W`; mockup keys never used as print assets.
- [ ] Human approves first live paid order, fulfilment and customer address.
- [ ] Returns, cancellations, taxes, fulfilment cost, shipping and privacy obligations reviewed.
- [ ] Only then enable the Etsy checkout call-to-action.
- [ ] After the single-mug pilot, design a reliable multi-item Etsy receipt/transaction mapping and test it with 2 distinct streets and repeated quantities.

## Useful official references

- Etsy Open API: https://developers.etsy.com/
- Etsy webhooks / `order.paid`: https://developer.etsy.com/documentation/essentials/webhooks/
- Etsy personalization migration: https://developer.etsy.com/documentation/tutorials/personalization-migration/
- Etsy receipts and transactions: https://developer.etsy.com/documentation/reference
- Prodigi API / sandbox: https://www.prodigi.com/print-api/docs/reference/

**Decision still needed:** the actual Etsy shop/listing strategy and a sample transaction that proves the correct Street Face design is recoverable after payment.
