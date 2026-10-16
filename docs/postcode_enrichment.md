# Postcode enrichment workflow

The storefront can search by postcode, but postcode mappings must be populated first.

## Source

Use the consolidated street geometry GeoJSON from the image-generation pipeline, for example:

```text
hebden_bridge_streets.geojson
```

Each feature should contain:

- `street_key`
- `name`
- `postcode_district` (for this pilot, normally `HX7`)
- a `LineString` or `MultiLineString` geometry in longitude/latitude coordinates

## Generate candidates

From `catalogue_import/`:

```bash
python3 enrich_postcodes_from_geometry.py /path/to/hebden_bridge_streets.geojson
```

The script samples five points along each street and uses the free Postcodes.io bulk reverse-geocoding endpoint. It filters out any candidate whose outcode does not match the street's expected `postcode_district`.

No API key is needed.

No database writes are performed.

Reports are written to:

```text
reports/postcode_candidates.csv
reports/postcode_candidates.json
```

Useful tuning options:

```bash
python3 enrich_postcodes_from_geometry.py /path/to/hebden_bridge_streets.geojson \
  --samples 7 \
  --radius 100 \
  --limit 10
```

## Review rules

The candidate generator is intentionally conservative. A postcode centroid being near a sampled street point does not prove that every address on that street uses that postcode.

Review candidates before import, especially when:

- a street has many candidate postcodes
- candidates occur at only one sample point
- the minimum candidate distance is relatively large
- a street lies close to another parallel street
- the street is long enough to span several postcode units

The report includes:

- candidate postcode
- expected outcode/district
- number of sampled positions that returned the candidate
- sample coverage
- minimum and maximum reported distance
- a simple `strong`, `possible`, or `weak` evidence label

These evidence labels are triage aids, not an authority on postal addressing.

## Canonical identity rule

The enrichment output stays keyed by `street_key`. It does **not** write to Supabase and does **not** attach a postcode to a catalogue design by street name alone.

Before importing confirmed postcodes into `design_postcodes`, the geometry record must be resolved to the catalogue's canonical identity:

```text
dataset_id + street_id
```

That later mapping step must fail closed when identity cannot be established deterministically.
