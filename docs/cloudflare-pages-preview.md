# Cloudflare Pages checkout pilot preview

This file documents the preview build for the `feature/stripe-sandbox-checkout` branch.

- Production branch: `main` (do not change).
- Preview branch: `feature/stripe-sandbox-checkout`.
- Build command: `node scripts/write-public-config.mjs`.
- Build output directory: `site`.
- Required public build variables: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `MOCKUP_BASE_URL`.
- Pilot checkout URL: `/checkout-pilot/` on the branch preview.
- The storefront checkout button remains disabled through `checkoutEnabled: false`.
- Turnstile hostname and `CHECKOUT_PILOT_ORIGIN` must be configured before pilot purchases.
- Stripe sandbox keys only; no automatic Prodigi fulfilment.

Created to trigger the first branch preview after connecting the GitHub repository to Cloudflare Pages.

GitHub connection was restored on 2026-10-30. This documentation-only change requests a new branch-preview build.
