#!/usr/bin/env python3
"""Verify that GeoJSON feature index maps deterministically to catalogue street_id.

Read-only safety check. It compares every Supabase design row against the GeoJSON
feature at index == int(street_id). The numeric index is the proposed bridge;
street names are checked only as a secondary consistency signal and are never used
to resolve identity.
"""
from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path

from dotenv import load_dotenv
from supabase import create_client


def required(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing environment variable: {name}")
    return value


def normalise_name(value: str) -> str:
    value = str(value or "").strip().rstrip(".")
    value = value.replace("–", "-").replace("—", "-")
    value = re.sub(r"\s+", " ", value)
    return value.casefold()


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "geojson",
        nargs="?",
        type=Path,
        default=Path("geojson/hebden_bridge_streets.geojson"),
        help="GeoJSON path (default: geojson/hebden_bridge_streets.geojson)",
    )
    args = parser.parse_args()

    source = json.loads(args.geojson.read_text(encoding="utf-8"))
    features = source.get("features", [])
    if source.get("type") != "FeatureCollection" or not isinstance(features, list):
        raise RuntimeError("Input must be a GeoJSON FeatureCollection")

    db = create_client(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"))
    response = (
        db.table("designs")
        .select("design_code,dataset_id,street_id,street_name,status")
        .order("street_id")
        .execute()
    )
    designs = response.data or []

    index_errors: list[str] = []
    name_mismatches: list[str] = []
    matched = 0

    for design in designs:
        street_id = str(design.get("street_id") or "")
        try:
            index = int(street_id)
        except ValueError:
            index_errors.append(f"{design.get('design_code')}: non-numeric street_id {street_id!r}")
            continue

        if index < 0 or index >= len(features):
            index_errors.append(
                f"{design.get('design_code')}: street_id {street_id} outside GeoJSON feature range 0-{len(features)-1}"
            )
            continue

        feature = features[index]
        props = feature.get("properties") or {}
        geo_name = str(props.get("name") or props.get("display_name") or "").strip()
        catalogue_name = str(design.get("street_name") or "").strip()

        if normalise_name(geo_name) != normalise_name(catalogue_name):
            name_mismatches.append(
                f"{design.get('design_code')} / street_id {street_id}: catalogue={catalogue_name!r} geojson={geo_name!r}"
            )
            continue

        matched += 1

    print("GeoJSON → catalogue mapping verification")
    print("--------------------------------------")
    print(f"geojson features: {len(features)}")
    print(f"catalogue designs: {len(designs)}")
    print(f"exact index/name matches: {matched}")
    print(f"index errors: {len(index_errors)}")
    print(f"name mismatches: {len(name_mismatches)}")

    if index_errors:
        print("\nIndex errors:")
        for item in index_errors[:25]:
            print(f"  - {item}")
        if len(index_errors) > 25:
            print(f"  ... and {len(index_errors) - 25} more")

    if name_mismatches:
        print("\nName mismatches:")
        for item in name_mismatches[:25]:
            print(f"  - {item}")
        if len(name_mismatches) > 25:
            print(f"  ... and {len(name_mismatches) - 25} more")

    if index_errors or name_mismatches:
        print("\nFAIL: do not use GeoJSON feature index as the canonical bridge yet.")
        return 1

    if matched != len(designs):
        print("\nFAIL: not every catalogue design was verified.")
        return 1

    print("\nPASS: every catalogue design maps to GeoJSON feature index == street_id")
    print("The bridge can be used without resolving designs by street name.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
