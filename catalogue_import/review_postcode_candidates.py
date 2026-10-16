#!/usr/bin/env python3
"""Review postcode candidates generated from street geometry.

This tool is deliberately conservative. It does not write to Supabase and does not
attempt to map geometry rows to catalogue designs. It consumes
reports/postcode_candidates.json and produces two review files:

* postcode_recommended.csv  - compact per-street recommendations
* postcode_review.json      - full structured review

The Postcodes.io geometry enrichment is a proximity signal, not an authoritative
street/address directory. Recommendations therefore require repeated sample hits
and close proximity, and ambiguous streets are explicitly flagged for review.
"""
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path


def score(candidate: dict) -> tuple:
    """Sort strongest evidence first."""
    return (
        -int(candidate.get("hit_count") or 0),
        float(candidate.get("min_distance_m") if candidate.get("min_distance_m") is not None else 10_000),
        float(candidate.get("max_distance_m") if candidate.get("max_distance_m") is not None else 10_000),
        str(candidate.get("postcode") or ""),
    )


def recommend(candidates: list[dict], sample_count: int) -> tuple[list[dict], str, str]:
    """Return recommended candidates, status, and rationale.

    A candidate must:
      * hit at least 3 samples (or all samples when fewer than 3 exist)
      * cover at least 60% of sampled points
      * have a nearest centroid within 60 m

    We then retain candidates whose hit count is within one of the best candidate.
    This keeps plausible postcode transitions along a long street while dropping
    weaker neighbouring postcode centroids.
    """
    if not candidates:
        return [], "no_candidates", "No postcode candidates were returned."

    required_hits = min(3, max(1, sample_count))
    eligible = []
    for c in candidates:
        hits = int(c.get("hit_count") or 0)
        coverage = float(c.get("coverage") or 0)
        distance = c.get("min_distance_m")
        distance = float(distance) if distance is not None else 10_000
        if hits >= required_hits and coverage >= 0.60 and distance <= 60:
            eligible.append(c)

    if not eligible:
        return [], "review_required", "No candidate met the conservative repeat-hit and distance thresholds."

    eligible.sort(key=score)
    best_hits = int(eligible[0].get("hit_count") or 0)
    chosen = [c for c in eligible if int(c.get("hit_count") or 0) >= best_hits - 1]

    # Guard against a nearby cluster producing many equally plausible postcodes.
    if len(chosen) > 6:
        return chosen[:6], "review_required", f"More than six plausible postcodes remained ({len(chosen)}); manual review recommended."

    if len(chosen) == 1:
        return chosen, "recommended", "One postcode clearly met the conservative thresholds."

    return chosen, "recommended_multi", f"{len(chosen)} postcodes plausibly cover different parts of the street."


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "input",
        nargs="?",
        type=Path,
        default=Path("reports/postcode_candidates.json"),
        help="Candidate JSON (default: reports/postcode_candidates.json)",
    )
    parser.add_argument(
        "--report-dir",
        type=Path,
        default=Path("reports"),
        help="Output directory (default: reports)",
    )
    args = parser.parse_args()

    payload = json.loads(args.input.read_text(encoding="utf-8"))
    streets = payload.get("streets") or payload.get("results") or []
    if not isinstance(streets, list):
        raise RuntimeError("Candidate JSON does not contain a street list")

    reviewed = []
    csv_rows = []
    status_counts: dict[str, int] = {}
    total_recommended = 0

    for street in streets:
        candidates = list(street.get("candidates") or [])
        sample_count = int(street.get("sample_count") or 0)
        chosen, status, rationale = recommend(candidates, sample_count)

        source_problems = street.get("source_problems") or []
        if source_problems:
            status = "invalid_source"
            rationale = "Source geometry has problems: " + ", ".join(map(str, source_problems))
            chosen = []

        status_counts[status] = status_counts.get(status, 0) + 1
        total_recommended += len(chosen)

        chosen_postcodes = [str(c.get("postcode") or "") for c in chosen if c.get("postcode")]
        reviewed.append(
            {
                "street_key": street.get("street_key", ""),
                "street_name": street.get("street_name", ""),
                "postcode_district": street.get("postcode_district", ""),
                "status": status,
                "rationale": rationale,
                "recommended_postcodes": chosen_postcodes,
                "recommended_candidates": chosen,
                "all_candidates": sorted(candidates, key=score),
            }
        )

        csv_rows.append(
            {
                "street_key": street.get("street_key", ""),
                "street_name": street.get("street_name", ""),
                "postcode_district": street.get("postcode_district", ""),
                "status": status,
                "recommended_postcodes": "; ".join(chosen_postcodes),
                "recommended_count": len(chosen_postcodes),
                "candidate_count": len(candidates),
                "rationale": rationale,
            }
        )

    args.report_dir.mkdir(parents=True, exist_ok=True)
    csv_path = args.report_dir / "postcode_recommended.csv"
    json_path = args.report_dir / "postcode_review.json"

    fields = [
        "street_key",
        "street_name",
        "postcode_district",
        "status",
        "recommended_postcodes",
        "recommended_count",
        "candidate_count",
        "rationale",
    ]
    with csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(csv_rows)

    review_payload = {
        "source": str(args.input),
        "summary": {
            "streets": len(reviewed),
            "recommended_postcodes": total_recommended,
            "statuses": status_counts,
        },
        "streets": reviewed,
    }
    json_path.write_text(json.dumps(review_payload, indent=2, ensure_ascii=False), encoding="utf-8")

    print("Postcode candidate review")
    print("-------------------------")
    print(f"streets:                {len(reviewed)}")
    print(f"recommended postcodes:  {total_recommended}")
    for key in sorted(status_counts):
        print(f"{key + ':':22} {status_counts[key]}")
    print(f"CSV:  {csv_path.resolve()}")
    print(f"JSON: {json_path.resolve()}")
    print("\nNo database changes were made.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
