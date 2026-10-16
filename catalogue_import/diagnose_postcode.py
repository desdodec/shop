#!/usr/bin/env python3
"""Diagnose one postcode against internal mappings and the public catalogue RPC."""
from __future__ import annotations

import argparse
import json
import os
import re
import urllib.error
import urllib.request

from dotenv import load_dotenv
from supabase import create_client


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


def sector_compact_from_full(value: str) -> str:
    c = compact(value)
    if not re.fullmatch(r"[A-Z]{1,2}[0-9][0-9A-Z]?[0-9][A-Z]{2}", c):
        raise ValueError(f"Not a full UK postcode: {value!r}")
    return c[:-2]


def rpc(url: str, key: str, search_text: str) -> list[dict]:
    payload = json.dumps({
        "search_text": search_text,
        "result_limit": 50,
        "result_offset": 0,
    }).encode("utf-8")
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("postcode", help="Full UK postcode, e.g. 'HX7 5DR'")
    args = parser.parse_args()

    load_dotenv()
    url = required("SUPABASE_URL")
    publishable_key = required("SUPABASE_PUBLISHABLE_KEY")
    service_key = required("SUPABASE_SERVICE_ROLE_KEY")

    query = display_postcode(args.postcode)
    query_compact = compact(query)
    sector_compact = sector_compact_from_full(query)

    db = create_client(url, service_key)

    designs = db.table("designs").select("id,design_code,street_name,status").execute().data or []
    assets = (
        db.table("design_assets")
        .select("design_id")
        .eq("product_sku", "GLOBAL-MUG-W")
        .eq("version", 1)
        .eq("validation_status", "valid")
        .execute().data
        or []
    )
    postcodes = db.table("design_postcodes").select("design_id,postcode").execute().data or []
    sectors = db.table("design_postcode_sectors").select("design_id,sector").execute().data or []

    valid_assets = {row["design_id"] for row in assets}
    public_designs = {
        row["id"]: row
        for row in designs
        if row.get("status") == "active" and row["id"] in valid_assets
    }
    by_code = {row["design_code"]: row for row in public_designs.values()}

    exact_ids = {
        row["design_id"]
        for row in postcodes
        if compact(str(row.get("postcode") or "")) == query_compact
        and row["design_id"] in public_designs
    }
    sector_ids = {
        row["design_id"]
        for row in sectors
        if compact(str(row.get("sector") or "")) == sector_compact
        and row["design_id"] in public_designs
    }

    exact_codes = {public_designs[i]["design_code"] for i in exact_ids}
    sector_codes = {public_designs[i]["design_code"] for i in sector_ids}

    public_rows = rpc(url, publishable_key, query)
    public_codes = {row["design_code"] for row in public_rows}

    extras = public_codes - exact_codes
    missing = exact_codes - public_codes

    print(f"Postcode diagnostic: {query}")
    print("-" * (21 + len(query)))
    print(f"Exact internal matches: {len(exact_codes)}")
    for code in sorted(exact_codes):
        print(f"  {code} — {by_code[code]['street_name']}")

    print(f"\nSector {sector_compact[:-1]} {sector_compact[-1]} internal matches: {len(sector_codes)}")
    print(f"Public RPC matches: {len(public_codes)}")
    for code in sorted(public_codes):
        row = by_code.get(code, {})
        marker = "EXACT" if code in exact_codes else ("SECTOR-ONLY" if code in sector_codes else "OTHER")
        print(f"  {marker:11} {code} — {row.get('street_name', '?')}")

    if exact_codes:
        print("\nExpected behaviour: full postcode has exact mappings, so public RPC should return only exact matches.")
    else:
        print("\nExpected behaviour: no exact mapping exists, so a full-postcode search should return no postcode-derived results.")
        print(f"Try the shorter sector {sector_compact[:-1]} {sector_compact[-1]} for broader discovery.")

    print(f"Extras vs exact: {len(extras)}")
    for code in sorted(extras):
        row = by_code.get(code, {})
        print(f"  {code} — {row.get('street_name', '?')}")
    print(f"Missing exact matches: {len(missing)}")
    for code in sorted(missing):
        row = by_code.get(code, {})
        print(f"  {code} — {row.get('street_name', '?')}")

    if extras or missing:
        print("\nFAIL: public results do not match exact canonical mappings")
        return 1

    print("\nPASS: public full-postcode behaviour matches exact canonical mappings")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
