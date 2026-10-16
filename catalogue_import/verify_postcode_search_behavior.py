#!/usr/bin/env python3
"""Verify postcode search semantics against canonical Supabase mappings.

This script uses the service-role key only to establish the expected internal
mapping sets, then calls the public search_catalogue RPC with the publishable key.
It never prints keys.

Checks:
  * full postcode with exact mappings returns exactly those designs (no sector noise)
  * spaced/unspaced/lowercase variants return the same design set
  * HX7 5 sector discovery includes Burnley Road when sector data says it should
  * street-name and Design-ID search still work
  * a sample (or all, with --all) exact postcodes obey exact-match precedence
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from collections import defaultdict

from dotenv import load_dotenv
from supabase import create_client

TARGET_POSTCODE = "HX7 5ND"
TARGET_SECTOR = "HX7 5"
EXPECTED_FIELDS = {
    "design_code",
    "street_name",
    "locality",
    "front_mockup_key",
    "rear_mockup_key",
}


def required(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing environment variable: {name}")
    return value.rstrip("/") if name == "SUPABASE_URL" else value


def compact(value: str) -> str:
    return re.sub(r"\s+", "", value.strip().upper())


def display_postcode(value: str) -> str:
    c = compact(value)
    return f"{c[:-3]} {c[-3:]}" if len(c) > 3 else c


def rpc(url: str, key: str, search_text: str, limit: int = 50) -> list[dict]:
    payload = json.dumps(
        {
            "search_text": search_text,
            "result_limit": limit,
            "result_offset": 0,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{url}/rest/v1/rpc/search_catalogue",
        data=payload,
        method="POST",
        headers={
            "apikey": key,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"RPC failed with HTTP {exc.code}: {body}") from exc


def codes(rows: list[dict]) -> set[str]:
    return {str(row.get("design_code")) for row in rows if row.get("design_code")}


def names(rows: list[dict]) -> dict[str, str]:
    return {
        str(row.get("design_code")): str(row.get("street_name"))
        for row in rows
        if row.get("design_code")
    }


def check_public_fields(rows: list[dict], failures: list[str], label: str) -> None:
    for row in rows:
        actual = set(row)
        if actual != EXPECTED_FIELDS:
            failures.append(
                f"{label}: unexpected public fields extra={sorted(actual - EXPECTED_FIELDS)} "
                f"missing={sorted(EXPECTED_FIELDS - actual)}"
            )
            return


def fetch_internal_data(db):
    designs = db.table("designs").select("id,design_code,street_name,status").execute().data or []
    assets = (
        db.table("design_assets")
        .select("design_id,product_sku,version,validation_status")
        .eq("product_sku", "GLOBAL-MUG-W")
        .eq("version", 1)
        .eq("validation_status", "valid")
        .execute()
        .data
        or []
    )
    postcodes = db.table("design_postcodes").select("design_id,postcode").execute().data or []
    try:
        sectors = db.table("design_postcode_sectors").select("design_id,sector").execute().data or []
    except Exception:
        sectors = []

    valid_asset_ids = {row["design_id"] for row in assets}
    public_designs = {
        row["id"]: row
        for row in designs
        if row.get("status") == "active" and row["id"] in valid_asset_ids
    }
    return public_designs, postcodes, sectors


def exact_index(public_designs: dict, postcodes: list[dict]) -> dict[str, set[str]]:
    result: dict[str, set[str]] = defaultdict(set)
    for row in postcodes:
        design = public_designs.get(row.get("design_id"))
        if not design:
            continue
        result[compact(str(row.get("postcode") or ""))].add(design["design_code"])
    return result


def sector_index(public_designs: dict, sectors: list[dict]) -> dict[str, set[str]]:
    result: dict[str, set[str]] = defaultdict(set)
    for row in sectors:
        design = public_designs.get(row.get("design_id"))
        if not design:
            continue
        result[compact(str(row.get("sector") or ""))].add(design["design_code"])
    return result


def format_codes(code_set: set[str], design_names: dict[str, str]) -> str:
    if not code_set:
        return "NONE"
    return "; ".join(
        f"{code} — {design_names.get(code, '?')}" for code in sorted(code_set)
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--all",
        action="store_true",
        help="Test every unique exact postcode instead of a deterministic sample",
    )
    parser.add_argument(
        "--sample-size",
        type=int,
        default=25,
        help="Number of exact postcodes to sample when --all is not used (default: 25)",
    )
    args = parser.parse_args()

    load_dotenv()
    url = required("SUPABASE_URL")
    publishable_key = required("SUPABASE_PUBLISHABLE_KEY")
    service_key = required("SUPABASE_SERVICE_ROLE_KEY")

    db = create_client(url, service_key)
    public_designs, postcode_rows, sector_rows = fetch_internal_data(db)
    exact = exact_index(public_designs, postcode_rows)
    sectors = sector_index(public_designs, sector_rows)
    design_names = {row["design_code"]: row["street_name"] for row in public_designs.values()}

    failures: list[str] = []

    # 1) Known exact postcode: expected internal set must equal public RPC set.
    target_compact = compact(TARGET_POSTCODE)
    expected_target = exact.get(target_compact, set())
    target_rows = rpc(url, publishable_key, TARGET_POSTCODE)
    target_public = codes(target_rows)
    check_public_fields(target_rows, failures, TARGET_POSTCODE)

    if not expected_target:
        failures.append(f"{TARGET_POSTCODE}: no exact internal mappings exist; targeted test cannot be trusted")
    elif target_public != expected_target:
        failures.append(
            f"{TARGET_POSTCODE}: public results differ from exact internal mappings; "
            f"missing={sorted(expected_target - target_public)}, extras={sorted(target_public - expected_target)}"
        )

    # 2) Normalisation variants must be identical.
    variants = [TARGET_POSTCODE, target_compact, TARGET_POSTCODE.lower()]
    variant_sets = {variant: codes(rpc(url, publishable_key, variant)) for variant in variants}
    baseline = variant_sets[TARGET_POSTCODE]
    for variant, result_codes in variant_sets.items():
        if result_codes != baseline:
            failures.append(
                f"normalisation mismatch: {variant!r} returned {sorted(result_codes)} "
                f"instead of {sorted(baseline)}"
            )

    # 3) Sector discovery and Burnley Road.
    sector_compact = compact(TARGET_SECTOR)
    expected_sector = sectors.get(sector_compact, set())
    sector_rows_public = rpc(url, publishable_key, TARGET_SECTOR)
    sector_public = codes(sector_rows_public)
    check_public_fields(sector_rows_public, failures, TARGET_SECTOR)

    burnley_codes = {
        row["design_code"]
        for row in public_designs.values()
        if str(row.get("street_name", "")).lower() == "burnley road"
    }
    burnley_expected_in_sector = bool(burnley_codes & expected_sector)
    burnley_public_in_sector = bool(burnley_codes & sector_public)
    if burnley_expected_in_sector and not burnley_public_in_sector:
        failures.append(f"{TARGET_SECTOR}: Burnley Road is mapped to the sector but public search omitted it")

    # 4) Street and Design-ID regressions.
    blenheim_code_rows = rpc(url, publishable_key, "HB-0024")
    if codes(blenheim_code_rows) != {"HB-0024"}:
        failures.append(f"HB-0024 search returned {sorted(codes(blenheim_code_rows))}; expected only HB-0024")
    blenheim_name_rows = rpc(url, publishable_key, "Blenheim")
    if "HB-0024" not in codes(blenheim_name_rows):
        failures.append("Blenheim street-name search did not include HB-0024")

    # 5) Exact-match precedence across many postcodes.
    all_postcodes = sorted(code for code, expected_codes in exact.items() if expected_codes)
    if args.all:
        probes = all_postcodes
    else:
        step = max(1, len(all_postcodes) // max(1, args.sample_size))
        probes = all_postcodes[::step][: args.sample_size]
        if target_compact not in probes and target_compact in exact:
            probes = [target_compact, *probes]

    exact_failures = 0
    for postcode_compact in probes:
        expected_codes = exact[postcode_compact]
        rows = rpc(url, publishable_key, display_postcode(postcode_compact))
        actual_codes = codes(rows)
        check_public_fields(rows, failures, display_postcode(postcode_compact))
        if actual_codes != expected_codes:
            exact_failures += 1
            failures.append(
                f"{display_postcode(postcode_compact)} exact precedence: "
                f"expected={sorted(expected_codes)}, actual={sorted(actual_codes)}, "
                f"extras={sorted(actual_codes - expected_codes)}"
            )
            if exact_failures >= 10 and not args.all:
                break

    print("Postcode search behaviour verification")
    print("--------------------------------------")
    print(f"Active/valid catalogue designs: {len(public_designs)}")
    print(f"Exact postcode mappings:        {len(postcode_rows)}")
    print(f"Unique exact postcodes:         {len(exact)}")
    print(f"Sector mappings:                {len(sector_rows)}")
    print(f"Exact postcodes tested:         {len(probes)}")
    print()
    print(f"{TARGET_POSTCODE} internal exact:")
    print(f"  {format_codes(expected_target, design_names)}")
    print(f"{TARGET_POSTCODE} public RPC:")
    print(f"  {format_codes(target_public, design_names)}")
    print()
    print(f"{TARGET_SECTOR} internal sector count: {len(expected_sector)}")
    print(f"{TARGET_SECTOR} public result count:   {len(sector_public)}")
    print(f"Burnley Road expected in sector:      {burnley_expected_in_sector}")
    print(f"Burnley Road returned by sector RPC:  {burnley_public_in_sector}")

    aspinall_codes = {
        row["design_code"]
        for row in public_designs.values()
        if str(row.get("street_name", "")).lower() == "aspinall street"
    }
    if aspinall_codes:
        print(f"Aspinall Street exact {TARGET_POSTCODE}: {bool(aspinall_codes & expected_target)}")
        print(f"Aspinall Street returned for {TARGET_POSTCODE}: {bool(aspinall_codes & target_public)}")

    if failures:
        print(f"\nFAILED: {len(failures)} check(s) failed", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1

    print("\nPASS: postcode search behaviour matches the canonical mappings")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
