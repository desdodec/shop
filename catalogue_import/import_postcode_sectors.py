#!/usr/bin/env python3
"""Build/import postcode-sector discovery mappings from geometry candidates.

This is deliberately broader than the exact-postcode importer. It consumes
reports/postcode_candidates.json, groups nearby full-postcode candidates into UK
postcode sectors (for example HX7 5), and attaches only defensible sectors to the
canonical catalogue identity via the already-verified rule:

    GeoJSON feature index == street_id

Exact postcode mappings remain conservative. Sector mappings are discovery-only:
several different nearby full postcodes can collectively provide strong evidence
for the same postcode sector even when no single full postcode is strong enough.

Long streets are allowed to keep more than one credible sector because they can
legitimately cross postcode-sector boundaries. Shorter streets use stricter
secondary-sector rules to reduce neighbouring-sector bleed.

No street-name matching is used for identity. By default this is a dry run; pass
--apply to replace design_postcode_sectors rows for resolved designs.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
from collections import defaultdict
from pathlib import Path

from dotenv import load_dotenv
from supabase import create_client

UK_POSTCODE = re.compile(r"^(GIR ?0AA|(?:[A-Z]{1,2}[0-9][0-9A-Z]?)[ ]?[0-9][A-Z]{2})$", re.I)
LONG_STREET_METRES = 800.0


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
    sector_compact = compact[:-2]
    return f"{sector_compact[:-1]} {sector_compact[-1]}"


def haversine_m(a: list[float], b: list[float]) -> float:
    """Approximate distance between two [lon, lat] coordinates in metres."""
    lon1, lat1 = map(math.radians, (float(a[0]), float(a[1])))
    lon2, lat2 = map(math.radians, (float(b[0]), float(b[1])))
    dlon = lon2 - lon1
    dlat = lat2 - lat1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * 6_371_000.0 * math.asin(min(1.0, math.sqrt(h)))


def geometry_length_m(geometry: dict | None) -> float:
    """Return total line length for LineString or MultiLineString geometry."""
    if not geometry:
        return 0.0
    geometry_type = geometry.get("type")
    coordinates = geometry.get("coordinates") or []

    if geometry_type == "LineString":
        lines = [coordinates]
    elif geometry_type == "MultiLineString":
        lines = coordinates
    else:
        return 0.0

    total = 0.0
    for line in lines:
        for a, b in zip(line, line[1:]):
            total += haversine_m(a, b)
    return total


def sector_stats(street: dict) -> dict[str, dict[str, float]]:
    """Aggregate candidate evidence by postcode sector."""
    grouped: dict[str, dict[str, float]] = defaultdict(
        lambda: {
            "total_hits": 0,
            "best_hits": 0,
            "candidate_count": 0,
            "close_candidates": 0,
            "min_distance": 10_000.0,
        }
    )

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

        stats = grouped[sector]
        stats["total_hits"] += hits
        stats["best_hits"] = max(stats["best_hits"], hits)
        stats["candidate_count"] += 1
        if distance_f <= 150:
            stats["close_candidates"] += 1
        stats["min_distance"] = min(stats["min_distance"], distance_f)

    return grouped


def choose_sectors(street: dict, street_length_m: float) -> list[str]:
    """Choose discovery sectors from grouped nearby postcode evidence.

    The strongest qualifying sector is always retained.

    Shorter streets use strict secondary-sector rules:
      * at least 70% as many aggregate hits as the strongest sector,
      * nearest candidate no more than 40 m farther away,
      * at least two nearby candidate postcodes.

    Long streets (>= 800 m) may legitimately cross a sector boundary, so a
    secondary sector can survive with:
      * at least 45% as many aggregate hits,
      * nearest candidate no more than 75 m farther away,
      * at least two nearby candidate postcodes.

    A maximum of three sectors is retained.
    """
    grouped = sector_stats(street)
    if not grouped:
        return []

    eligible = [
        (sector, stats)
        for sector, stats in grouped.items()
        if stats["min_distance"] <= 150
        and (stats["total_hits"] >= 2 or stats["close_candidates"] >= 2)
    ]

    if not eligible:
        closest = sorted(
            grouped.items(),
            key=lambda item: (item[1]["min_distance"], -item[1]["total_hits"], item[0]),
        )
        if closest and closest[0][1]["min_distance"] <= 200:
            return [closest[0][0]]
        return []

    eligible.sort(
        key=lambda item: (
            -item[1]["total_hits"],
            -item[1]["best_hits"],
            -item[1]["close_candidates"],
            item[1]["min_distance"],
            item[0],
        )
    )

    best_sector, best_stats = eligible[0]
    chosen = [best_sector]
    best_hits = float(best_stats["total_hits"])
    best_distance = float(best_stats["min_distance"])

    is_long = street_length_m >= LONG_STREET_METRES
    hit_ratio = 0.45 if is_long else 0.70
    distance_allowance = 75.0 if is_long else 40.0

    for sector, stats in eligible[1:]:
        comparable_hits = float(stats["total_hits"]) >= best_hits * hit_ratio
        comparable_distance = float(stats["min_distance"]) <= best_distance + distance_allowance
        enough_close_candidates = int(stats["close_candidates"]) >= 2
        if comparable_hits and comparable_distance and enough_close_candidates:
            chosen.append(sector)
        if len(chosen) >= 3:
            break

    return chosen


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
    burnley_debug: dict[str, dict[str, float]] | None = None
    burnley_length_m: float | None = None

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

        length_m = geometry_length_m(feature.get("geometry"))

        if design_name.lower() == "burnley road":
            burnley_debug = sector_stats(street)
            burnley_length_m = length_m

        sectors = choose_sectors(street, length_m)
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
    if burnley_length_m is not None:
        classification = "long" if burnley_length_m >= LONG_STREET_METRES else "short"
        print(f"Burnley Road length:     {burnley_length_m:.0f} m ({classification})")

    if burnley_debug:
        print("Burnley Road evidence:")
        for sector, stats in sorted(
            burnley_debug.items(),
            key=lambda item: (-item[1]["total_hits"], item[1]["min_distance"], item[0]),
        ):
            print(
                f"  {sector}: total_hits={int(stats['total_hits'])}, "
                f"best_hits={int(stats['best_hits'])}, "
                f"candidates={int(stats['candidate_count'])}, "
                f"close={int(stats['close_candidates'])}, "
                f"min_distance={stats['min_distance']:.1f}m"
            )

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
