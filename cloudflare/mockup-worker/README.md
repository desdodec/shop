# Public mockup delivery Worker

This Worker exposes only customer-facing mockups from the private `mug-print-assets` R2 bucket.

Allowed object prefixes:

- `front/`
- `rear/`

Everything else returns `404`, including `prodigi_h_mug_w/`.

The R2 bucket itself should remain private.

## Deploy

From this directory:

```bash
npx wrangler deploy
```

You can use the generated `*.workers.dev` hostname initially, then attach a custom domain such as `images.example.com` in Cloudflare when ready.

No R2 access keys are required by the Worker. Access comes from the `MUG_ASSETS` R2 binding configured in `wrangler.toml`.

## Verify before using in production

Replace `$BASE_URL` with the deployed Worker origin and use exact existing keys:

```bash
curl -I "$BASE_URL/front/<existing-front-key>.png"
curl -I "$BASE_URL/rear/<existing-rear-key>.png"
curl -I "$BASE_URL/prodigi_h_mug_w/<existing-production-key>.png"
```

Expected results:

- front: `200`
- rear: `200`
- production: `404`

Also verify that the bucket's Cloudflare R2 public access / `r2.dev` public development URL is disabled. The public surface should be the Worker, not the bucket.

## Catalogue use

The browser should receive only `front_mockup_key` and `rear_mockup_key`, then construct image URLs as:

```text
<PUBLIC_MOCKUP_BASE_URL>/<front_mockup_key>
<PUBLIC_MOCKUP_BASE_URL>/<rear_mockup_key>
```

Do not expose `production_key` in the browser-facing catalogue API.
