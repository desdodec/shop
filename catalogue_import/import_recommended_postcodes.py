#!/usr/bin/env python3
"""Import reviewed postcode recommendations into Supabase deterministically.

This tool uses the proven bridge:

    GeoJSON feature index == catalogue street_id

It never resolves a catalogue design by street name. Street names are compared only
as a secondary safety invariant. Only review statuses `recommended` and
`recommended_multi` are eligible. `review_required`, `no_candidates`, and invalid
source rows are skipped.

By default this is a dry run. Pass --apply to replace postcode mappings for the
eligible designs in public.design_postcodes.
"""
from __future__ import annotations

import argparse
import json
import os
import re
from collections import defaultdict
from pathlib import Path

from dotenv import load_dotenv
from supabase import create_client

ELIGIBLE_STATUSES = {"recommended", "recommended_multi"}
UK_POSTCODE = re.compile(
    r"^(GIR ?0AA|(?:[A-Z]{1,2}[0-9][0-9A-Z]?)[ ]?[0-9][A-Z]{2})$",
    re.IGNORECASE,
)


def required(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing environment variable: {name}")
    return value


def normalize_name(value: object) -> str:
    text = str(value or "").strip().lower().rstrip(".")
    text = re.sub(r"\s+", " ", text)
    return text


def normalize_postcode(value: object) -> str:
    compact = re.sub(r"\s+", "", str(value or "").strip().upper())
    if not UK_POSTCODE.fullmatch(compact):
        raise ValueError(f"Invalid UK postcode: {value!r}")
    return f"{compact[:-3]} {compact[-3:]}"


def fetch_all_designs(db) -> list[dict]:
    rows: list[dict] = []
    start = 0
    page_size = 1000
    while True:
        response = (
            db.table("designs")
            .select("id,design_code,dataset_id,street_id,street_name,status")
            .order("street_id")
            .range(start, start + page_size - 1)
            .execute()
        )
        page = response.data or []
        rows.extend(page)
        if len(page) < page_size:
            break
        start += page_size
    return rows


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--review",
        type=Path,
        default=Path("reports/postcode_review.json"),
        help="Reviewed postcode JSON (default: reports/postcode_review.json)",
    )
    parser.add_argument(
        "--geojson",
        type=Path,
        default=Path("geojson/hebden_bridge_streets.geojson"),
        help="Street GeoJSON used to prove feature index == street_id",
    )
    parser.add_argument("--apply", action="store_true", help="Write mappings to Supabase")
    args = parser.parse_args()

    review_payload = json.loads(args.review.read_text(encoding="utf-8"))
    reviewed = review_payload.get("streets") or []
    if not isinstance(reviewed, list):
        raise RuntimeError("Review JSON does not contain a streets list")

    geo_payload = json.loads(args.geojson.read_text(encoding="utf-8"))
    features = geo_payload.get("features") or []
    if geo_payload.get("type") != "FeatureCollection" or not isinstance(features, list):
        raise RuntimeError("GeoJSON must be a FeatureCollection")

    if len(reviewed) != len(features):
        raise RuntimeError(
            f"Review/GeoJSON length mismatch: {len(reviewed)} reviewed streets vs {len(features)} features"
        )

    db = create_client(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"))
    designs = fetch_all_designs(db)

    by_street_id: dict[str, list[dict]] = defaultdict(list)
    for design in designs:
        by_street_id[str(design.get("street_id") or "").zfill(4)].append(design)

    errors: list[str] = []
    skipped_no_design = 0
    skipped_status = defaultdict(int)
    eligible_designs = 0
    mappings: list[dict] = []

    for feature_index, (feature, review) in enumerate(zip(features, reviewed)):
        street_id = str(feature_index).zfill(4)
        props = feature.get("properties") or {}
        geo_name = str(props.get("name") or props.get("display_name") or "").strip()
        review_name = str(review.get("street_name") or "").strip()
        review_status = str(review.get("status") or "").strip()

        # Review file must still correspond to the same GeoJSON feature order.
        if normalize_name(review_name) != normalize_name(geo_name):
            errors.append(
                f"review/geojson name mismatch at {street_id}: {review_name!r} vs {geo_name!r}"
            )
            continue

        design_rows = by_street_id.get(street_id, [])
        if not design_rows:
            skipped_no_design += 1
            continue
        if len(design_rows) != 1:
            errors.append(f"street_id {street_id} resolves to {len(design_rows)} catalogue designs")
            continue

        design = design_rows[0]
        if normalize_name(design.get("street_name")) != normalize_name(geo_name):
            errors.append(
                f"catalogue/geojson name mismatch at {street_id}: "
                f"{design.get('street_name')!r} vs {geo_name!r}"
            )
            continue

        if review_status not in ELIGIBLE_STATUSES:
            skipped_status[review_status or "missing_status"] += 1
            continue

        postcodes = sorted({normalize_postcode(v) for v in (review.get("recommended_postcodes") or [])})
        if not postcodes:
            errors.append(f"eligible review row {street_id} has no recommended postcodes")
            continue

        eligible_designs += 1
        for postcode in postcodes:
            mappings.append(
                {
                    "design_id": design["id"],
                    "design_code": design["design_code"],
                    "dataset_id": design["dataset_id"],
                    "street_id": street_id,
                    "street_name": design["street_name"],
                    "postcode": postcode,
                    "review_status": review_status,
                }
            )

    print("Recommended postcode import")
    print("---------------------------")
    print(f"geojson features:           {len(features)}")
    print(f"catalogue designs:          {len(designs)}")
    print(f"eligible catalogue designs: {eligible_designs}")
    print(f"postcode mappings:          {len(mappings)}")
    print(f"geojson streets no design:  {skipped_no_design}")
    for status in sorted(skipped_status):
        print(f"skipped {status + ':':18} {skipped_status[status]}")

    if errors:
        print(f"\nFAILED: {len(errors)} safety invariant(s) failed")
        for error in errors[:30]:
            print(f"- {error}")
        print("Nothing was written.")
        return 1

    if not mappings:
        print("\nFAILED: no eligible postcode mappings were produced. Nothing was written.")
        return 1

    # Final duplicate guard before writes.
    unique_pairs = {(m["design_id"], m["postcode"]) for m in mappings}
    if len(unique_pairs) != len(mappings):
        raise RuntimeError("Duplicate design/postcode mappings survived normalization")

    if not args.apply:
        print("\nDRY RUN: all invariants passed. No database changes made.")
        print("Re-run with --apply to replace mappings for these eligible designs.")
        return 0

    grouped: dict[str, list[str]] = defaultdict(list)
    for mapping in mappings:
        grouped[mapping["design_id"]].append(mapping["postcode"])

    written = 0
    for design_id, postcodes in grouped.items():
        db.table("design_postcodes").delete().eq("design_id", design_id).execute()
        rows = [{"design_id": design_id, "postcode": postcode} for postcode in sorted(set(postcodes))]
        db.table("design_postcodes").insert(rows).execute()
        written += len(rows)

    print(f"\nPASS: wrote {written} postcode mappings for {len(grouped)} designs")
    print("Review-required and no-candidate streets were not modified.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
