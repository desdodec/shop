#!/usr/bin/env python3
"""Build/import postcode-sector discovery mappings from geometry candidates.

This is deliberately broader than the exact-postcode importer. It consumes
reports/postcode_candidates.json, groups nearby full-postcode candidates into UK
postcode sectors (for example HX7 5), and attaches only defensible sectors to the
canonical catalogue identity via the already-verified rule:

    GeoJSON feature index == street_id

No street-name matching is used for identity. By default this is a dry run; pass
--apply to replace design_postcode_sectors rows for resolved designs.
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

UK_POSTCODE = re.compile(r"^(GIR ?0AA|(?:[A-Z]{1,2}[0-9][0-9A-Z]?)[ ]?[0-9][A-Z]{2})$", re.I)


def required(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing environment variable: {name}")
    return value


def normalize_postcode(value: str) -> str:
    compact = re.sub(r"\s+", "", str(value).strip().upper())
    if not UK_POSTCODE.fullmatch(compact):
        raise ValueError(f"Invalid UK postcode: {value!r}")
    return compact


def sector_from_postcode(value: str) -> str:
    compact = normalize_postcode(value)
    # UK inward code is one digit + two letters; sector keeps the inward digit.
    sector_compact = compact[:-2]
    # Put a display space before the inward digit.
    return f"{sector_compact[:-1]} {sector_compact[-1]}"


def choose_sectors(street: dict) -> list[str]:
    """Choose broad-but-defensible sectors from all postcode candidates.

    A sector qualifies when at least one candidate in it:
      * hit at least 2 sampled street points, and
      * came within 100 m of a sampled point.

    Multiple sectors are allowed because a long street can legitimately cross a
    sector boundary. If more than three qualify, keep only sectors whose best hit
    count is within one of the strongest sector, capped at three.
    """
    grouped: dict[str, dict[str, float]] = defaultdict(lambda: {"best_hits": 0, "min_distance": 10_000.0})

    for candidate in street.get("candidates") or []:
        postcode = candidate.get("postcode")
        if not postcode:
            continue
        try:
            sector = sector_from_postcode(str(postcode))
        except ValueError:
            continue
        hits = int(candidate.get("hit_count") or 0)
        distance = candidate.get("min_distance_m")
        try:
            distance_f = float(distance) if distance is not None else 10_000.0
        except (TypeError, ValueError):
            distance_f = 10_000.0
        grouped[sector]["best_hits"] = max(grouped[sector]["best_hits"], hits)
        grouped[sector]["min_distance"] = min(grouped[sector]["min_distance"], distance_f)

    eligible = [
        (sector, stats)
        for sector, stats in grouped.items()
        if stats["best_hits"] >= 2 and stats["min_distance"] <= 100
    ]
    if not eligible:
        return []

    eligible.sort(key=lambda item: (-item[1]["best_hits"], item[1]["min_distance"], item[0]))
    best_hits = eligible[0][1]["best_hits"]
    chosen = [sector for sector, stats in eligible if stats["best_hits"] >= best_hits - 1]
    return chosen[:3]


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidates", type=Path, default=Path("reports/postcode_candidates.json"))
    parser.add_argument("--geojson", type=Path, default=Path("geojson/hebden_bridge_streets.geojson"))
    parser.add_argument("--apply", action="store_true", help="Write sector mappings to Supabase")
    args = parser.parse_args()

    candidates_payload = json.loads(args.candidates.read_text(encoding="utf-8"))
    streets = candidates_payload.get("streets") or []
    geojson = json.loads(args.geojson.read_text(encoding="utf-8"))
    features = geojson.get("features") or []

    if len(streets) != len(features):
        raise RuntimeError(f"Candidate streets ({len(streets)}) do not match GeoJSON features ({len(features)})")

    db = create_client(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"))
    designs_response = db.table("designs").select("id,design_code,street_id,street_name").execute()
    designs = designs_response.data or []
    by_street_id = {str(row["street_id"]).zfill(4): row for row in designs}

    resolved: list[tuple[str, str, str, list[str]]] = []
    skipped_no_design = 0
    skipped_no_sector = 0
    name_mismatches: list[str] = []

    for index, (street, feature) in enumerate(zip(streets, features)):
        street_id = f"{index:04d}"
        design = by_street_id.get(street_id)
        if not design:
            skipped_no_design += 1
            continue

        candidate_name = str(street.get("street_name") or "").strip()
        geo_name = str((feature.get("properties") or {}).get("name") or "").strip()
        design_name = str(design.get("street_name") or "").strip()
        if candidate_name != geo_name or design_name != geo_name:
            name_mismatches.append(f"{street_id}: candidate={candidate_name!r}, geo={geo_name!r}, design={design_name!r}")
            continue

        sectors = choose_sectors(street)
        if not sectors:
            skipped_no_sector += 1
            continue

        resolved.append((design["id"], design["design_code"], design_name, sectors))

    if name_mismatches:
        print("FAILED: name mismatches detected")
        for item in name_mismatches[:20]:
            print(f"- {item}")
        return 1

    total_mappings = sum(len(item[3]) for item in resolved)
    burnley = [item for item in resolved if item[2].lower() == "burnley road"]

    print("Postcode sector import")
    print("----------------------")
    print(f"geojson features:        {len(features)}")
    print(f"catalogue designs:       {len(designs)}")
    print(f"designs with sectors:    {len(resolved)}")
    print(f"sector mappings:         {total_mappings}")
    print(f"geojson streets no design: {skipped_no_design}")
    print(f"designs no sector:       {skipped_no_sector}")
    if burnley:
        print(f"Burnley Road sectors:    {', '.join(burnley[0][3])}")
    else:
        print("Burnley Road sectors:    NONE")

    if not args.apply:
        print("\nDRY RUN: no database changes made. Re-run with --apply to import.")
        return 0

    written = 0
    for design_id, _code, _name, sectors in resolved:
        db.table("design_postcode_sectors").delete().eq("design_id", design_id).execute()
        rows = [
            {"design_id": design_id, "sector": sector, "source": "geometry_candidates"}
            for sector in sectors
        ]
        if rows:
            db.table("design_postcode_sectors").insert(rows).execute()
            written += len(rows)

    print(f"\nPASS: wrote {written} postcode-sector mappings")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
