# Mug Catalogue Import + Validation

This package validates the existing Cloudflare R2 mug assets and imports sellable catalogue rows into Supabase/PostgreSQL.

## Assumptions

Bucket: `mug-print-assets`

Prefixes:
- `front/`
- `rear/`
- `prodigi_h_mug_w/`

Prodigi SKU: `GLOBAL-MUG-W`

For dataset `20261009_112459_hebden_bridge_streets_parks_water_boundary_clip` and street `0024 Blenheim Street`, the importer expects:

- `front/20261009_112459_hebden_bridge_streets_parks_water_boundary_clip_0024_Blenheim_Street_front.png`
- `rear/20261009_112459_hebden_bridge_streets_parks_water_boundary_clip_0024_Blenheim_Street_rear.png`
- `prodigi_h_mug_w/20261009_112459_hebden_bridge_streets_parks_water_boundary_clip_0024_Blenheim_Street.png`

Public design code: `HB-0024`

## Setup

1. Create a Supabase project.
2. Run `schema.sql` in the Supabase SQL editor.
3. Install dependencies:

```bash
python -m pip install -r requirements.txt
```

4. Copy `.env.example` to `.env` and fill in R2/Supabase credentials.
5. Run:

```bash
python catalogue_import_validator.py /path/to/mockup_export_report.json
```

Only source records where `eligibility == "READY"` and `result == "EXPORTED"` are processed.

Each design must have all three R2 objects: front mockup, rear mockup, and production artwork. Missing assets put the design on hold automatically.

Reports are written to:
- `reports/catalogue_validation.csv`
- `reports/catalogue_validation.json`

Do not commit `.env` or expose the R2 credentials or Supabase service-role key to frontend code.
