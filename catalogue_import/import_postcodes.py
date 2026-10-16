#!/usr/bin/env python3
"""Import postcode mappings for catalogue designs without guessing.

Supported inputs:
  * mockup_export_report.json items containing `postcode` or `postcodes`
  * CSV with columns: dataset_id, street_id, postcode

Mappings are keyed only by (dataset_id, street_id). Street names are never used for
identity matching. By default this script is a dry run; pass --apply to write.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
from collections import defaultdict
from pathlib import Path

from dotenv import load_dotenv
from supabase import create_client

UK_POSTCODE = re.compile(
    r"^(GIR ?0AA|(?:[A-Z]{1,2}[0-9][0-9A-Z]?)[ ]?[0-9][A-Z]{2})$",
    re.IGNORECASE,
)


def required(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing environment variable: {name}")
    return value


def normalize_postcode(value: str) -> str:
    compact = re.sub(r"\s+", "", value.strip().upper())
    if not UK_POSTCODE.fullmatch(compact):
        raise ValueError(f"Invalid UK postcode: {value!r}")
    return f"{compact[:-3]} {compact[-3:]}"


def identity(dataset_id: object, street_id: object) -> tuple[str, str]:
    return str(dataset_id).strip(), str(street_id).strip().zfill(4)


def values_from_item(item: dict) -> list[str]:
    raw = item.get("postcodes")
    if raw is None:
        raw = item.get("postcode")
    if raw is None:
        return []
    if isinstance(raw, str):
        return [raw]
    if isinstance(raw, list):
        return [str(value) for value in raw if str(value).strip()]
    raise ValueError(f"Unsupported postcode value type: {type(raw).__name__}")


def load_json(path: Path) -> dict[tuple[str, str], set[str]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    mappings: dict[tuple[str, str], set[str]] = defaultdict(set)
    items = data.get("items", [])

    for item in items:
        if "dataset_id" not in item or "street_id" not in item:
            continue
        values = values_from_item(item)
        if not values:
            continue
        key = identity(item["dataset_id"], item["street_id"])
        for value in values:
            mappings[key].add(normalize_postcode(value))

    return mappings


def load_csv(path: Path) -> dict[tuple[str, str], set[str]]:
    mappings: dict[tuple[str, str], set[str]] = defaultdict(set)
    with path.open(newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        required_columns = {"dataset_id", "street_id", "postcode"}
        missing = required_columns - set(reader.fieldnames or [])
        if missing:
            raise ValueError(f"CSV missing columns: {', '.join(sorted(missing))}")
        for row in reader:
            key = identity(row["dataset_id"], row["street_id"])
            mappings[key].add(normalize_postcode(row["postcode"]))
    return mappings


def load_mappings(path: Path) -> dict[tuple[str, str], set[str]]:
    if path.suffix.lower() == ".csv":
        return load_csv(path)
    return load_json(path)


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--apply", action="store_true", help="Write mappings to Supabase")
    args = parser.parse_args()

    mappings = load_mappings(args.source.resolve())
    postcode_count = sum(len(values) for values in mappings.values())

    print("Postcode import")
    print("---------------")
    print(f"design identities with postcodes: {len(mappings)}")
    print(f"unique design/postcode mappings:  {postcode_count}")

    if not mappings:
        print("\nNo postcode data found in this source.")
        print("Expected JSON item fields named `postcode` or `postcodes`, or a CSV")
        print("with dataset_id, street_id, postcode columns. Nothing was written.")
        return 2

    db = create_client(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"))
    unresolved: list[tuple[str, str]] = []
    resolved: list[tuple[str, list[str]]] = []

    for (dataset_id, street_id), postcodes in sorted(mappings.items()):
        response = (
            db.table("designs")
            .select("id,design_code")
            .eq("dataset_id", dataset_id)
            .eq("street_id", street_id)
            .limit(2)
            .execute()
        )
        rows = response.data or []
        if len(rows) != 1:
            unresolved.append((dataset_id, street_id))
            continue
        resolved.append((rows[0]["id"], sorted(postcodes)))

    if unresolved:
        print(f"\nFAILED: {len(unresolved)} identities did not resolve uniquely in Supabase")
        for dataset_id, street_id in unresolved[:20]:
            print(f"- {dataset_id} / {street_id}")
        return 1

    print(f"resolved identities:             {len(resolved)}")

    if not args.apply:
        print("\nDRY RUN: no database changes made. Re-run with --apply to import.")
        return 0

    written = 0
    for design_id, postcodes in resolved:
        db.table("design_postcodes").delete().eq("design_id", design_id).execute()
        rows = [{"design_id": design_id, "postcode": postcode} for postcode in postcodes]
        if rows:
            db.table("design_postcodes").insert(rows).execute()
            written += len(rows)

    print(f"\nPASS: wrote {written} postcode mappings")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
