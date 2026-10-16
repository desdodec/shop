# GeoJSON inputs

Place local street geometry source files for catalogue enrichment in this folder.

For the Hebden Bridge postcode enrichment workflow, use:

- `hebden_bridge_streets.geojson` — preferred consolidated street geometry input
- `hebden_bridge_streets_segments.geojson` — optional provenance/raw segments

The postcode enrichment script can then be run from the repository root with:

```bash
python3 catalogue_import/enrich_postcodes_from_geometry.py geojson/hebden_bridge_streets.geojson
```

These files are source data only. They must not contain credentials or other secrets.
