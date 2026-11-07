# Storefront deployment — Cloudflare Workers

Street Face is hosted on **Cloudflare Workers Static Assets**, not Netlify. The storefront consists of static files in `site/` and a generated public `site/config.js`.

The separate Cloudflare Worker at `cloudflare/mockup-worker/` continues to serve **only public front/rear mockups** from R2. It must not serve high-resolution production artwork.

## Security boundary

- Cloudflare R2 production artwork stays private.
- The image-delivery Worker exposes only permitted `front/` and `rear/` mockup paths.
- Browser clients never receive Supabase service-role credentials or R2 secrets.
- Browser database access is restricted to `search_catalogue(...)`.
- The public catalogue returns Design ID, street name, locality, and front/rear mockup keys — not print-ready object keys.
- Never commit `site/config.js`; it is generated using **public-only** frontend values.

## 1. Database API

Apply `supabase/public_catalogue.sql` in the Supabase SQL editor if it has not already been applied.

In the Supabase dashboard, locate the project's URL and **publishable** API key (`sb_publishable_...`). Do **not** use a service-role/secret key.

## 2. Collection manifest

The pilot uses `collections/hebden-bridge.json`. It specifies the collection name, dataset ID, GeoJSON source, browser map style and design-code prefix.

The build script `scripts/write-public-config.mjs` writes `site/config.js` and copies the selected GeoJSON to the site directory.

To deploy a different area later, set `COLLECTION_ID` to the area manifest's filename stem. The default is `hebden-bridge`.

## 3. Configure Cloudflare Workers build/deployment

The repository root includes `wrangler.jsonc`:

```json
{
  "name": "street-face-shop",
  "compatibility_date": "2026-11-07",
  "assets": { "directory": "./site" }
}
```

Use a **Cloudflare Workers** project linked to the GitHub repository, with these build settings:

```text
Build command: npm run build
Deploy command: npx wrangler deploy
Root directory: repository root
```

Set these **build-time** environment variables in Cloudflare's project settings:

```text
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
MOCKUP_BASE_URL=https://YOUR_EXISTING_MOCKUP_WORKER.workers.dev
```

All three values are intended to be visible to browsers; never put secret credentials in the public build environment. The generated `config.js` is public and contains only these non-secret values.

If the site is deployed manually instead of through GitHub integration, create a local untracked `.env` or export these environment variables for the build process, then:

```bash
npm install
npm run build
npx wrangler deploy
```

Wrangler may require a one-time Cloudflare login for local deployment.

## 4. Validate

1. Check that the Cloudflare deployment opens the Street Face landing page.
2. Search for a street and see the front/reverse mug mockups.
3. Confirm the map loads and available streets highlight on pointer hover.
4. Select multiple streets from search and the map; verify the basket persists.
5. Confirm the front/reverse mug viewer opens, zooms and closes.
6. Check that `/config.js` loads and contains **no secrets**.
7. Check that production artwork is **not** accessible via the mockup delivery Worker.
8. Check that internal Supabase tables cannot be selected directly by the browser.

## 5. Custom domain

Point the existing Street Face domain to the Cloudflare Worker in Cloudflare's domain/route settings. Verify DNS and Worker routing before retiring any previous hosting configuration. A GitHub commit alone does **not** guarantee a Cloudflare deployment until the project is connected and its build variables are set.

## Future checkout

Etsy checkout and Prodigi order handling are not part of this static storefront deployment. Add server-side order processing separately, without exposing Etsy, Prodigi or R2 production credentials to the browser.
