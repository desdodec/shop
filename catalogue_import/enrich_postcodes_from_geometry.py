#!/usr/bin/env python3
"""Generate reviewable postcode candidates for street geometries using Postcodes.io.

This script is deliberately enrichment-only. It DOES NOT write to Supabase and it
DOES NOT map candidates to catalogue designs by street name. Output remains keyed
by the geometry source's durable ``street_key`` so a later, explicitly validated
mapping step can attach confirmed postcodes to ``dataset_id + street_id``.

The input must be a GeoJSON FeatureCollection containing LineString or
MultiLineString geometries. Expected properties include:

    name
    street_key
    postcode_district

Postcodes.io requires no API key. The script samples points along every street,
uses the bulk reverse-geocoding endpoint, filters results to the expected postcode
district, and writes CSV + JSON reports for human review.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import time
import urllib.error
import urllib.request
from collections import defaultdict
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Iterable, Sequence

API_URL = "https://api.postcodes.io/postcodes"
USER_AGENT = "street-face-shop-postcode-enrichment/1.0"


@dataclass(frozen=True)
class SamplePoint:
    street_index: int
    sample_index: int
    longitude: float
    latitude: float


@dataclass
class CandidateStats:
    postcode: str
    outcode: str
    hit_samples: set[int]
    distances_m: list[float]

    def add(self, sample_index: int, distance: float | None) -> None:
        self.hit_samples.add(sample_index)
        if distance is not None:
            self.distances_m.append(float(distance))


def normalise_postcode(value: str) -> str:
    return " ".join(str(value).upper().strip().split())


def normalise_compact(value: str) -> str:
    return "".join(normalise_postcode(value).split())


def district_matches(postcode: str, outcode: str | None, district: str) -> bool:
    expected = normalise_compact(district)
    if not expected:
        return False
    if outcode and normalise_compact(outcode) == expected:
        return True
    compact = normalise_compact(postcode)
    return compact.startswith(expected)


def haversine_m(a: Sequence[float], b: Sequence[float]) -> float:
    lon1, lat1 = math.radians(a[0]), math.radians(a[1])
    lon2, lat2 = math.radians(b[0]), math.radians(b[1])
    dlon = lon2 - lon1
    dlat = lat2 - lat1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * 6_371_008.8 * math.asin(math.sqrt(h))


def geometry_lines(geometry: dict) -> list[list[list[float]]]:
    gtype = geometry.get("type")
    coordinates = geometry.get("coordinates")
    if gtype == "LineString":
        return [coordinates or []]
    if gtype == "MultiLineString":
        return coordinates or []
    return []


def combined_segments(lines: Iterable[Sequence[Sequence[float]]]):
    segments: list[tuple[Sequence[float], Sequence[float], float]] = []
    total = 0.0
    for line in lines:
        for start, end in zip(line, line[1:]):
            length = haversine_m(start, end)
            if length <= 0:
                continue
            segments.append((start, end, length))
            total += length
    return segments, total


def interpolate(start: Sequence[float], end: Sequence[float], fraction: float) -> tuple[float, float]:
    return (
        float(start[0]) + (float(end[0]) - float(start[0])) * fraction,
        float(start[1]) + (float(end[1]) - float(start[1])) * fraction,
    )


def sample_geometry(geometry: dict, count: int) -> list[tuple[float, float]]:
    lines = geometry_lines(geometry)
    segments, total = combined_segments(lines)
    if not segments:
        # A degenerate one-coordinate LineString is unusual, but preserving it as
        # one sample is safer than silently dropping the street.
        for line in lines:
            if line:
                return [(float(line[0][0]), float(line[0][1]))]
        return []

    count = max(1, count)
    # Stay slightly inside the endpoints because postcode centroids near junctions
    # are more likely to belong to an adjoining street.
    fractions = [0.5] if count == 1 else [(i + 0.5) / count for i in range(count)]
    targets = [total * fraction for fraction in fractions]

    samples: list[tuple[float, float]] = []
    segment_start_distance = 0.0
    target_index = 0

    for start, end, length in segments:
        segment_end_distance = segment_start_distance + length
        while target_index < len(targets) and targets[target_index] <= segment_end_distance:
            within = (targets[target_index] - segment_start_distance) / length
            samples.append(interpolate(start, end, max(0.0, min(1.0, within))))
            target_index += 1
        segment_start_distance = segment_end_distance
        if target_index >= len(targets):
            break

    return samples


def post_json(url: str, payload: dict, timeout: float) -> dict:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def query_batch(points: list[SamplePoint], radius: int, limit: int, timeout: float, retries: int) -> list[dict]:
    payload = {
        "geolocations": [
            {
                "longitude": point.longitude,
                "latitude": point.latitude,
                "radius": radius,
                "limit": limit,
            }
            for point in points
        ]
    }

    delay = 1.0
    for attempt in range(retries + 1):
        try:
            response = post_json(API_URL, payload, timeout)
            if response.get("status") != 200:
                raise RuntimeError(f"Postcodes.io status {response.get('status')}: {response.get('error', 'unknown error')}")
            result = response.get("result")
            if not isinstance(result, list) or len(result) != len(points):
                raise RuntimeError("Unexpected Postcodes.io bulk response shape")
            return result
        except (urllib.error.URLError, TimeoutError, RuntimeError) as exc:
            if attempt >= retries:
                raise RuntimeError(f"Postcodes.io request failed after {retries + 1} attempts: {exc}") from exc
            time.sleep(delay)
            delay *= 2

    raise AssertionError("unreachable")


def confidence(hit_count: int, sample_count: int, min_distance: float | None) -> str:
    coverage = hit_count / max(sample_count, 1)
    if coverage >= 0.6 and (min_distance is None or min_distance <= 75):
        return "strong"
    if coverage >= 0.3 and (min_distance is None or min_distance <= 120):
        return "possible"
    return "weak"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("geojson", type=Path, help="Street GeoJSON FeatureCollection")
    parser.add_argument("--samples", type=int, default=5, help="Sample points per street (default: 5)")
    parser.add_argument("--radius", type=int, default=100, help="Postcodes.io search radius in metres (default: 100)")
    parser.add_argument("--limit", type=int, default=10, help="Nearest postcodes returned per sample point (default: 10)")
    parser.add_argument("--batch-size", type=int, default=80, help="Bulk geolocation queries per request (default: 80)")
    parser.add_argument("--timeout", type=float, default=30.0, help="HTTP timeout seconds (default: 30)")
    parser.add_argument("--retries", type=int, default=3, help="Retries for transient API failures (default: 3)")
    parser.add_argument("--report-dir", type=Path, default=Path("reports"), help="Output directory (default: reports)")
    args = parser.parse_args()

    if args.samples < 1 or args.samples > 25:
        parser.error("--samples must be between 1 and 25")
    if args.radius < 10 or args.radius > 1000:
        parser.error("--radius must be between 10 and 1000 metres")
    if args.limit < 1 or args.limit > 100:
        parser.error("--limit must be between 1 and 100")
    if args.batch_size < 1 or args.batch_size > 100:
        parser.error("--batch-size must be between 1 and 100")

    source = json.loads(args.geojson.read_text(encoding="utf-8"))
    features = source.get("features", [])
    if source.get("type") != "FeatureCollection" or not isinstance(features, list):
        raise RuntimeError("Input must be a GeoJSON FeatureCollection")

    street_rows: list[dict] = []
    sample_points: list[SamplePoint] = []

    for street_index, feature in enumerate(features):
        props = feature.get("properties") or {}
        name = str(props.get("name") or props.get("display_name") or "").strip()
        street_key = str(props.get("street_key") or "").strip()
        district = str(props.get("postcode_district") or props.get("postcode") or "").strip().upper()
        geometry = feature.get("geometry") or {}

        problems: list[str] = []
        if not name:
            problems.append("missing_name")
        if not street_key:
            problems.append("missing_street_key")
        if not district:
            problems.append("missing_postcode_district")

        samples = sample_geometry(geometry, args.samples)
        if not samples:
            problems.append("unsupported_or_empty_geometry")

        street_rows.append(
            {
                "street_index": street_index,
                "street_key": street_key,
                "street_name": name,
                "postcode_district": district,
                "geometry_type": geometry.get("type", ""),
                "sample_count": len(samples),
                "problems": problems,
            }
        )

        if not problems:
            for sample_index, (lon, lat) in enumerate(samples):
                sample_points.append(SamplePoint(street_index, sample_index, lon, lat))

    print("Postcode geometry enrichment")
    print("----------------------------")
    print(f"streets:        {len(street_rows)}")
    print(f"sample points:  {len(sample_points)}")
    print(f"radius:         {args.radius} m")
    print(f"candidates/sample: {args.limit}")

    response_by_sample: dict[tuple[int, int], list[dict]] = {}
    for start in range(0, len(sample_points), args.batch_size):
        batch = sample_points[start : start + args.batch_size]
        print(f"Querying samples {start + 1}-{start + len(batch)} / {len(sample_points)} ...")
        results = query_batch(batch, args.radius, args.limit, args.timeout, args.retries)
        for point, item in zip(batch, results):
            response_by_sample[(point.street_index, point.sample_index)] = item.get("result") or []

    report_rows: list[dict] = []
    json_streets: list[dict] = []

    for street in street_rows:
        candidates: dict[str, CandidateStats] = {}
        raw_result_count = 0
        rejected_district = 0

        if not street["problems"]:
            for sample_index in range(street["sample_count"]):
                results = response_by_sample.get((street["street_index"], sample_index), [])
                raw_result_count += len(results)
                for result in results:
                    postcode = normalise_postcode(result.get("postcode", ""))
                    outcode = normalise_postcode(result.get("outcode", ""))
                    if not postcode:
                        continue
                    if not district_matches(postcode, outcode, street["postcode_district"]):
                        rejected_district += 1
                        continue
                    stats = candidates.setdefault(
                        postcode,
                        CandidateStats(postcode, outcode, set(), []),
                    )
                    distance = result.get("distance")
                    try:
                        parsed_distance = float(distance) if distance is not None else None
                    except (TypeError, ValueError):
                        parsed_distance = None
                    stats.add(sample_index, parsed_distance)

        ordered = sorted(
            candidates.values(),
            key=lambda item: (
                -len(item.hit_samples),
                min(item.distances_m) if item.distances_m else float("inf"),
                item.postcode,
            ),
        )

        if street["problems"]:
            review_status = "invalid_source"
        elif not ordered:
            review_status = "no_candidates"
        else:
            review_status = "review_required"

        candidate_payloads: list[dict] = []
        for stats in ordered:
            min_distance = min(stats.distances_m) if stats.distances_m else None
            max_distance = max(stats.distances_m) if stats.distances_m else None
            item = {
                "postcode": stats.postcode,
                "outcode": stats.outcode,
                "hit_count": len(stats.hit_samples),
                "sample_count": street["sample_count"],
                "coverage": round(len(stats.hit_samples) / max(street["sample_count"], 1), 3),
                "min_distance_m": round(min_distance, 1) if min_distance is not None else None,
                "max_distance_m": round(max_distance, 1) if max_distance is not None else None,
                "confidence": confidence(len(stats.hit_samples), street["sample_count"], min_distance),
            }
            candidate_payloads.append(item)
            report_rows.append(
                {
                    "street_key": street["street_key"],
                    "street_name": street["street_name"],
                    "postcode_district": street["postcode_district"],
                    "review_status": review_status,
                    **item,
                }
            )

        if not ordered:
            report_rows.append(
                {
                    "street_key": street["street_key"],
                    "street_name": street["street_name"],
                    "postcode_district": street["postcode_district"],
                    "review_status": review_status,
                    "postcode": "",
                    "outcode": "",
                    "hit_count": 0,
                    "sample_count": street["sample_count"],
                    "coverage": 0,
                    "min_distance_m": "",
                    "max_distance_m": "",
                    "confidence": "",
                }
            )

        json_streets.append(
            {
                "street_key": street["street_key"],
                "street_name": street["street_name"],
                "postcode_district": street["postcode_district"],
                "geometry_type": street["geometry_type"],
                "sample_count": street["sample_count"],
                "review_status": review_status,
                "source_problems": street["problems"],
                "raw_result_count": raw_result_count,
                "rejected_wrong_district": rejected_district,
                "candidates": candidate_payloads,
            }
        )

    args.report_dir.mkdir(parents=True, exist_ok=True)
    csv_path = args.report_dir / "postcode_candidates.csv"
    json_path = args.report_dir / "postcode_candidates.json"

    fields = [
        "street_key",
        "street_name",
        "postcode_district",
        "review_status",
        "postcode",
        "outcode",
        "hit_count",
        "sample_count",
        "coverage",
        "min_distance_m",
        "max_distance_m",
        "confidence",
    ]
    with csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(report_rows)

    summary = {
        "source": str(args.geojson.resolve()),
        "settings": {
            "samples_per_street": args.samples,
            "radius_m": args.radius,
            "limit_per_sample": args.limit,
        },
        "summary": {
            "streets": len(street_rows),
            "streets_with_candidates": sum(bool(row["candidates"]) for row in json_streets),
            "streets_without_candidates": sum(not row["candidates"] for row in json_streets),
            "candidate_postcodes": sum(len(row["candidates"]) for row in json_streets),
            "strong_candidates": sum(
                candidate["confidence"] == "strong"
                for row in json_streets
                for candidate in row["candidates"]
            ),
        },
        "streets": json_streets,
    }
    json_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")

    print("\nFinished. No database changes were made.")
    print(f"streets with candidates:    {summary['summary']['streets_with_candidates']}")
    print(f"streets without candidates: {summary['summary']['streets_without_candidates']}")
    print(f"candidate postcodes:        {summary['summary']['candidate_postcodes']}")
    print(f"strong candidates:          {summary['summary']['strong_candidates']}")
    print(f"CSV:  {csv_path.resolve()}")
    print(f"JSON: {json_path.resolve()}")
    print("\nReview the candidates before any canonical design/postcode import.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
