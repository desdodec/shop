#!/usr/bin/env python3
"""Verify the browser-safe Supabase catalogue RPC using the publishable key.

Reads SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY from catalogue_import/.env.
No keys are printed. Exits non-zero if the public API leaks unexpected fields,
fails to return the known HB-0024 design, or fails a postcode-search check when
local postcode review output is available.
"""
from __future__ import annotations

import csv
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

from dotenv import load_dotenv


EXPECTED_FIELDS = {
    "design_code",
    "street_name",
    "locality",
    "front_mockup_key",
    "rear_mockup_key",
}

REPO_ROOT = Path(__file__).resolve().parent.parent
POSTCODE_REVIEW_CSV = REPO_ROOT / "reports" / "postcode_recommended.csv"


def required(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing environment variable: {name}")
    return value.rstrip("/") if name == "SUPABASE_URL" else value


def rpc(url: str, key: str, search_text: str) -> list[dict]:
    payload = json.dumps(
        {
            "search_text": search_text,
            "result_limit": 24,
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


def check_fields(rows: list[dict], failures: list[str], context: str) -> None:
    for row in rows:
        fields = set(row)
        if fields != EXPECTED_FIELDS:
            extra = sorted(fields - EXPECTED_FIELDS)
            missing = sorted(EXPECTED_FIELDS - fields)
            failures.append(
                f"{context}: unexpected response fields; extra={extra}, missing={missing}"
            )
            return


def postcode_probe(url: str, key: str) -> tuple[str | None, str | None, list[dict]]:
    """Find one locally recommended postcode whose expected design is public.

    postcode_recommended.csv preserves GeoJSON feature order. The verified project
    invariant is zero-based GeoJSON feature index == catalogue street_id, and public
    design codes use HB-XXXX. We try several eligible rows so this remains robust if
    an early GeoJSON street has no corresponding catalogue design.
    """
    if not POSTCODE_REVIEW_CSV.exists():
        return None, None, []

    with POSTCODE_REVIEW_CSV.open(newline="", encoding="utf-8-sig") as handle:
        for feature_index, row in enumerate(csv.DictReader(handle)):
            if row.get("status") not in {"recommended", "recommended_multi"}:
                continue
            raw = (row.get("recommended_postcodes") or "").strip()
            if not raw:
                continue
            postcode = raw.split(";")[0].strip()
            expected_code = f"HB-{feature_index:04d}"
            rows = rpc(url, key, postcode)
            if any(result.get("design_code") == expected_code for result in rows):
                return postcode, expected_code, rows

    return "", "", []


def main() -> int:
    load_dotenv()
    url = required("SUPABASE_URL")
    key = required("SUPABASE_PUBLISHABLE_KEY")

    rows = rpc(url, key, "HB-0024")
    failures: list[str] = []

    if len(rows) != 1:
        failures.append(f"HB-0024 returned {len(rows)} rows; expected exactly 1")
    else:
        row = rows[0]
        check_fields(rows, failures, "HB-0024")
        if row.get("design_code") != "HB-0024":
            failures.append(f"unexpected design_code: {row.get('design_code')!r}")
        if row.get("street_name") != "Blenheim Street":
            failures.append(f"unexpected street_name: {row.get('street_name')!r}")
        if not str(row.get("front_mockup_key", "")).startswith("front/"):
            failures.append("front_mockup_key does not start with front/")
        if not str(row.get("rear_mockup_key", "")).startswith("rear/"):
            failures.append("rear_mockup_key does not start with rear/")

    street_rows = rpc(url, key, "Blenheim")
    check_fields(street_rows, failures, "street search")
    if not any(row.get("design_code") == "HB-0024" for row in street_rows):
        failures.append("street-name search for 'Blenheim' did not include HB-0024")

    browse_rows = rpc(url, key, "")
    check_fields(browse_rows, failures, "browse")
    if not browse_rows:
        failures.append("empty search returned no catalogue rows")
    if len(browse_rows) > 24:
        failures.append(f"empty search returned {len(browse_rows)} rows; expected <= 24")

    postcode, expected_code, postcode_rows = postcode_probe(url, key)
    if postcode is None:
        postcode_status = "not checked (reports/postcode_recommended.csv not found)"
    elif not postcode:
        postcode_status = "FAILED"
        failures.append(
            "no recommended postcode returned its expected catalogue design; "
            "postcode mappings may be missing or the postcode-aware RPC may not be deployed"
        )
    else:
        check_fields(postcode_rows, failures, "postcode search")
        postcode_status = f"{postcode} → {expected_code} ({len(postcode_rows)} row(s))"

    print("Public catalogue verification")
    print("-----------------------------")
    print(f"HB-0024 rows:    {len(rows)}")
    print(f"Blenheim rows:   {len(street_rows)}")
    print(f"Browse rows:     {len(browse_rows)}")
    print(f"Postcode search: {postcode_status}")

    if rows:
        print(f"Known design:    {rows[0].get('design_code')} — {rows[0].get('street_name')}")
        print(f"Returned fields: {', '.join(sorted(rows[0].keys()))}")

    if failures:
        print(f"\nFAILED: {len(failures)} check(s) failed", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1

    print("\nPASS: public RPC supports browser-safe street, Design ID, and postcode search")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
