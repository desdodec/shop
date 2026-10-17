# Storefront deployment

This phase exposes the validated catalogue to a public Netlify site without exposing production artwork or Supabase server credentials.

## Security boundary

- R2 bucket remains private.
- Cloudflare Worker exposes only `front/` and `rear/` keys.
- `prodigi_h_mug_w/` remains inaccessible through the Worker.
- Browser has no direct SELECT permission on `designs`, `design_assets`, `design_postcodes`, `design_postcode_sectors`, or `orders`.
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

Full postcodes use exact mappings only. Partial postcode/sector discovery remains available in the backend for future use, although the current pilot UI is intentionally street-name-first.

## 2. Create or locate a Supabase publishable key

In the Supabase dashboard open the project's API Keys settings / Connect dialog and use a publishable key beginning with:

```text
sb_publishable_
```

Do not use the server secret/service-role key in Netlify or browser code.

## 3. Collection manifest

The pilot collection is defined in:

```text
collections/hebden-bridge.json
```

The manifest contains the collection name, canonical dataset ID, public Design ID prefix, GeoJSON source, published GeoJSON URL and map style. The browser reads those values from generated `site/config.js` instead of hard-coding Hebden Bridge map paths or the `HB-` prefix.

The build defaults to:

```text
COLLECTION_ID=hebden-bridge
```

There is no need to set this variable for the pilot. A later single-area deployment can point at another collection manifest by setting `COLLECTION_ID` in Netlify after the new manifest and GeoJSON have been added.

This is deliberately not a multi-area customer UI yet. It only keeps the current implementation from being tied unnecessarily to Hebden Bridge.

## 4. Create the Netlify site

Create a Netlify project from the GitHub repository:

```text
https://github.com/desdodec/shop
```

`netlify.toml` already defines:

```text
build command: node scripts/write-public-config.mjs
publish directory: site
```

The build script reads the active collection manifest, writes `site/config.js`, and copies that collection's GeoJSON into the published site.

## 5. Add Netlify environment variables

In Netlify, under Project configuration -> Environment variables, add:

```text
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
MOCKUP_BASE_URL=https://shop-mockup-delivery.tessellnationstation.workers.dev
```

Do not add `SUPABASE_SERVICE_ROLE_KEY` or any R2 secret to the frontend project.

The generated `site/config.js` is gitignored.

## 6. Deploy and validate

Trigger a Netlify deploy. The pilot should:

1. Show the current collection name and interactive street map.
2. Report 205 available street designs for the Hebden Bridge pilot.
3. Highlight an available street on hover.
4. Allow several streets to be selected from the map without clearing earlier selections.
5. Allow several streets to be selected from rapid text-search results.
6. Search `Blenheim` and find Design ID `HB-0024`.
7. Load front and reverse mockups through the Cloudflare Worker.
8. Keep selected designs in browser storage scoped to the active collection.
9. Send only the Supabase publishable key from the browser.
10. Never return `production_key`, internal UUIDs, sizes, ETags or order data.
11. Deny direct browser REST access to internal catalogue/order tables.
12. Keep the Cloudflare production-artwork URL returning HTTP 404.

## Adding another area later

Do not add an area selector until the pilot justifies it. When another area is ready, the expected sequence is:

1. Generate the area's designs and canonical dataset.
2. Add its GeoJSON file.
3. Add a new `collections/<area>.json` manifest with its own dataset ID and Design ID prefix.
4. Import/validate its catalogue records and assets.
5. Decide whether to deploy it as a separate collection first or introduce an area selector that filters the public catalogue by dataset.

The canonical fulfilment identity remains `dataset_id + street_id`; street names are never used as database-write or fulfilment identity.

## Next phase

Once the pilot UX is stable, connect the selected public `design_code` values to Etsy order capture. The server-side order path must resolve each unique Design ID to the internal design row and validated asset version before an order can become eligible for manual Prodigi submission.
