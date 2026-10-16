#!/usr/bin/env python3
"""Read-only verification of imported mug catalogue rows in Supabase.

Uses the same local .env as catalogue_import_validator.py. No secrets are printed.
Exits non-zero when an invariant fails.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from collections import Counter

from dotenv import load_dotenv
from supabase import create_client


def required(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing environment variable: {name}")
    return value


def fetch_all(table, columns: str) -> list[dict]:
    """Fetch all rows in deterministic pages without assuming Supabase's row cap."""
    rows: list[dict] = []
    start = 0
    page_size = 500
    while True:
        response = table.select(columns).range(start, start + page_size - 1).execute()
        batch = response.data or []
        rows.extend(batch)
        if len(batch) < page_size:
            return rows
        start += page_size


def main() -> int:
    load_dotenv()

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--expected-designs",
        type=int,
        default=205,
        help="Expected imported design count (default: 205)",
    )
    args = parser.parse_args()

    db = create_client(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"))
    expected_sku = os.getenv("PRODUCT_SKU", "GLOBAL-MUG-W")
    expected_prefix = os.getenv("DESIGN_CODE_PREFIX", "HB")
    expected_locality = os.getenv("LOCALITY", "Hebden Bridge")

    designs = fetch_all(
        db.table("designs"),
        "id,design_code,dataset_id,street_id,street_name,locality,status",
    )
    assets = fetch_all(
        db.table("design_assets"),
        "id,design_id,product_sku,front_mockup_key,rear_mockup_key,production_key,version,validation_status,front_size,rear_size,production_size",
    )
    orders = fetch_all(db.table("orders"), "id,status,design_id,product_sku")

    failures: list[str] = []
    design_by_id = {row["id"]: row for row in designs}

    if len(designs) != args.expected_designs:
        failures.append(f"designs count is {len(designs)}, expected {args.expected_designs}")
    if len(assets) != args.expected_designs:
        failures.append(f"design_assets count is {len(assets)}, expected {args.expected_designs}")

    canonical = [(row["dataset_id"], row["street_id"]) for row in designs]
    duplicate_canonical = [key for key, count in Counter(canonical).items() if count > 1]
    if duplicate_canonical:
        failures.append(f"duplicate (dataset_id, street_id) identities: {duplicate_canonical[:5]}")

    duplicate_codes = [key for key, count in Counter(row["design_code"] for row in designs).items() if count > 1]
    if duplicate_codes:
        failures.append(f"duplicate design_code values: {duplicate_codes[:5]}")

    code_pattern = re.compile(rf"^{re.escape(expected_prefix)}-(\d{{4}})$")
    for row in designs:
        match = code_pattern.fullmatch(row["design_code"])
        if not match:
            failures.append(f"invalid design_code format: {row['design_code']}")
        elif match.group(1) != row["street_id"]:
            failures.append(
                f"design_code/street_id mismatch: {row['design_code']} vs {row['street_id']}"
            )
        if row["status"] != "active":
            failures.append(f"non-active design: {row['design_code']} status={row['status']}")
        if row["locality"] != expected_locality:
            failures.append(
                f"unexpected locality: {row['design_code']} locality={row['locality']!r}"
            )

    asset_counts = Counter(row["design_id"] for row in assets)
    for design in designs:
        if asset_counts[design["id"]] != 1:
            failures.append(
                f"{design['design_code']} has {asset_counts[design['id']]} asset rows; expected 1"
            )

    for row in assets:
        design = design_by_id.get(row["design_id"])
        label = design["design_code"] if design else row["design_id"]
        if not design:
            failures.append(f"orphan design_assets row: {row['id']}")
            continue
        if row["product_sku"] != expected_sku:
            failures.append(f"{label} unexpected SKU: {row['product_sku']}")
        if row["version"] != 1:
            failures.append(f"{label} unexpected asset version: {row['version']}")
        if row["validation_status"] != "valid":
            failures.append(f"{label} validation_status={row['validation_status']}")
        if not row["front_mockup_key"].startswith("front/"):
            failures.append(f"{label} invalid front key prefix")
        if not row["rear_mockup_key"].startswith("rear/"):
            failures.append(f"{label} invalid rear key prefix")
        if not row["production_key"].startswith("prodigi_h_mug_w/"):
            failures.append(f"{label} invalid production key prefix")
        for field in ("front_size", "rear_size", "production_size"):
            if not row.get(field) or row[field] <= 0:
                failures.append(f"{label} missing/invalid {field}")

    print("Supabase catalogue verification")
    print("-------------------------------")
    print(f"designs:       {len(designs)}")
    print(f"design_assets: {len(assets)}")
    print(f"orders:        {len(orders)}")
    print(f"active:        {sum(row['status'] == 'active' for row in designs)}")
    print(f"valid assets:  {sum(row['validation_status'] == 'valid' for row in assets)}")

    if failures:
        print(f"\nFAILED: {len(failures)} invariant(s) failed", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1

    print("\nPASS: all catalogue invariants hold")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
