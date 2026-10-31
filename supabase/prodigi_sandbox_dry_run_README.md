# Prodigi sandbox integration — Phase 1: secure dry run

This is a **separate, manually invoked backend function**, not an automatic Stripe/Prodigi integration.

## What it does
- Accepts only a POST with `{"mode":"dry_run","design_code":"HBV2-0000"}`.
- Requires a private operator token in `Authorization: Bearer ...`.
- Reads the exact new Acacia Grove design and mug asset from Supabase.
- Verifies that the production file exists in the configured R2 bucket.
- Generates a 15-minute R2 signed GET URL and returns the payload details for inspection.
- **Never calls Prodigi**, creates an order, changes a database record or activates fulfilment.

## Secret configuration (Supabase Edge Function secrets)
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PRODIGI_PREVIEW_ADMIN_TOKEN`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.

Use an **R2 read-only token** for this service; do not reuse the Artwork Manager write-capable token.
Do not paste any credentials or signed URL into chat.

## Deployment
Keep this un-deployed until its secrets and access controls are reviewed.
The current function uses an independent secret token. If deploying with `--no-verify-jwt`,
enforce rate limits and operator-only access on the Edge Function. Never link it from the website.
Do not configure Prodigi production credentials. No automatic submission logic exists.

## Later phases
1. Verify the signed URL fetch from a clean client, image dimensions and SKU.
2. Confirm the current Prodigi API version, product attributes, and sandbox key.
3. Add an audited operator action with database idempotency and a Sandbox-only hostname.
4. Test one Sandbox order and inspect reported asset/download results.
5. Sample physically and explicitly approve artwork before any live integration.
