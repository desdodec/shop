# Hebden Bridge v2 — production-readiness gate

**Status:** Design release remains HOLD. Do not enable live checkout or fulfilment.

## Confirmed evidence
- 311 v2 geographic identities and mockups linked correctly.
- Local Artwork Manager technical print validation: 311 / 311 passed for 2670 × 1110 PNG.
- Prodigi v4 Sandbox order `ord_1194085` for `HBV2-0000` returned:
  - `downloadAssets: Complete`
  - `printReadyAssetsPrepared: Complete`
  - `allocateProductionLocation: Complete`
  - product `GLOBAL-MUG-W`, item `Ok`, artwork `Complete`, no issues.
- This confirms **one** design's sandbox path, not all 311.

## Release gates still open
1. Verify every v2 production PNG in R2 matches the locally audited file (e.g., checksums).
2. Resolve the 16 geographic location-review flags against map positions.
3. Review visual proof for wrap alignment, lettering and print-safe margins.
4. Obtain physical sample feedback and explicit print-proof approval.
5. Implement and test *paid order → asset snapshot → fulfiller* with an idempotent queue, shipping address validation, separate sandbox/live secrets, and a deliberate release control.
6. Audit historical 205 designs/8 test checkout orders to ensure v2 activation never accidentally fulfils old test orders.
7. Stage availability by collection/dataset only. Keep production checkout disabled until the release decision.

## Read-only audit
Run `supabase/hebden_v2_production_readiness_audit.sql` from the Supabase SQL Editor.
This reports counts and possible database inconsistencies. It does not validate file pixels or grant product approval.

## Do not do yet
- Change designs.status to active or assets.validation_status to valid.
- Change create-checkout's dataset secret to v2.
- Deploy any live Prodigi order-creation function.
- Re-run the one-shot Acacia Grove Sandbox order.
