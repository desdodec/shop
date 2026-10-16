# Storefront deployment

This phase exposes the validated catalogue to a public Netlify site without exposing production artwork or Supabase server credentials.

## Security boundary

- R2 bucket remains private.
- Cloudflare Worker exposes only `front/` and `rear/` keys.
- `prodigi_h_mug_w/` remains inaccessible through the Worker.
- Browser has no direct SELECT permission on `designs`, `design_assets`, or `orders`.
- Browser calls only `search_catalogue(...)`.
- The RPC returns only:
  - `design_code`
  - `street_name`
  - `locality`
  - `front_mockup_key`
  - `rear_mockup_key`
- `production_key`, internal UUIDs, sizes, ETags and order data are not returned.

## 1. Apply the Supabase public catalogue API

Open the Supabase SQL editor and run the complete contents of:

```text
supabase/public_catalogue.sql
```

The migration revokes browser roles from the internal tables and grants them execute permission only on the browser-safe catalogue function.

## 2. Create or locate a Supabase publishable key

In the Supabase dashboard open the project's API Keys settings / Connect dialog and use a publishable key beginning with:

```text
sb_publishable_
```

Do not use the server secret/service-role key in Netlify or browser code.

## 3. Create the Netlify site

Create a Netlify project from the GitHub repository:

```text
https://github.com/desdodec/shop
```

`netlify.toml` already defines:

```text
build command: node scripts/write-public-config.mjs
publish directory: site
```

## 4. Add Netlify environment variables

In Netlify, under Project configuration -> Environment variables, add:

```text
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
MOCKUP_BASE_URL=https://shop-mockup-delivery.tessellnationstation.workers.dev
```

Do not add `SUPABASE_SERVICE_ROLE_KEY` or any R2 secret to the frontend project.

The build script generates `site/config.js`. That generated file is gitignored.

## 5. Deploy

Trigger a Netlify deploy. The initial page should load up to 24 valid street designs and allow searches such as:

```text
Blenheim Street
HB-0024
```

The known Blenheim Street result should show Design ID `HB-0024` and load both front and reverse mockups through the Cloudflare Worker.

## 6. Validation checks

Before connecting Etsy, verify all of the following:

1. Search for `HB-0024` returns Blenheim Street.
2. Search for `Blenheim` returns the same design.
3. Front and reverse images load.
4. Browser network requests contain the Supabase publishable key only.
5. No response contains `production_key`.
6. Direct REST queries to `designs`, `design_assets`, and `orders` using the publishable key are denied.
7. The Cloudflare production-artwork URL still returns HTTP 404.

## Next phase

Once these checks pass, connect the selected public `design_code` to Etsy order capture. The server-side order path must resolve the unique design code to the internal design row and validated asset version before an order can become eligible for manual Prodigi submission.
