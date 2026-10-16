#!/usr/bin/env python3
"""Verify the browser-safe Supabase catalogue RPC using the publishable key.

Reads SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY from catalogue_import/.env.
No keys are printed. Exits non-zero if the public API leaks unexpected fields or
fails to return the known HB-0024 design.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

from dotenv import load_dotenv


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
        fields = set(row)
        if fields != EXPECTED_FIELDS:
            extra = sorted(fields - EXPECTED_FIELDS)
            missing = sorted(EXPECTED_FIELDS - fields)
            failures.append(f"unexpected response fields; extra={extra}, missing={missing}")
        if row.get("design_code") != "HB-0024":
            failures.append(f"unexpected design_code: {row.get('design_code')!r}")
        if row.get("street_name") != "Blenheim Street":
            failures.append(f"unexpected street_name: {row.get('street_name')!r}")
        if not str(row.get("front_mockup_key", "")).startswith("front/"):
            failures.append("front_mockup_key does not start with front/")
        if not str(row.get("rear_mockup_key", "")).startswith("rear/"):
            failures.append("rear_mockup_key does not start with rear/")

    street_rows = rpc(url, key, "Blenheim")
    if not any(row.get("design_code") == "HB-0024" for row in street_rows):
        failures.append("street-name search for 'Blenheim' did not include HB-0024")

    browse_rows = rpc(url, key, "")
    if not browse_rows:
        failures.append("empty search returned no catalogue rows")
    if len(browse_rows) > 24:
        failures.append(f"empty search returned {len(browse_rows)} rows; expected <= 24")

    print("Public catalogue verification")
    print("-----------------------------")
    print(f"HB-0024 rows:    {len(rows)}")
    print(f"Blenheim rows:   {len(street_rows)}")
    print(f"Browse rows:     {len(browse_rows)}")

    if rows:
        print(f"Known design:    {rows[0].get('design_code')} — {rows[0].get('street_name')}")
        print(f"Returned fields: {', '.join(sorted(rows[0].keys()))}")

    if failures:
        print(f"\nFAILED: {len(failures)} check(s) failed", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1

    print("\nPASS: public RPC returns only browser-safe catalogue fields")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
