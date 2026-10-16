#!/usr/bin/env python3
"""Validate R2 mug assets and import catalogue rows into Supabase."""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from dotenv import load_dotenv
from supabase import create_client


@dataclass
class Asset:
    key: str
    exists: bool
    size: Optional[int] = None
    etag: Optional[str] = None
    error: Optional[str] = None


@dataclass
class Row:
    design_code: str
    dataset_id: str
    street_id: str
    street_name: str
    locality: str
    product_sku: str
    front_key: str
    rear_key: str
    production_key: str
    front_exists: bool
    rear_exists: bool
    production_exists: bool
    front_size: Optional[int]
    rear_size: Optional[int]
    production_size: Optional[int]
    front_etag: Optional[str]
    rear_etag: Optional[str]
    production_etag: Optional[str]
    status: str
    validation_status: str
    reason: Optional[str]


def required(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing environment variable: {name}")
    return value


def safe_name(name: str) -> str:
    value = name.strip().rstrip(".")
    value = re.sub(r"\s+", "_", value)
    return re.sub(r"[^A-Za-z0-9_'-]", "", value)


def keys(dataset_id: str, street_id: str, street_name: str):
    base = f"{dataset_id}_{street_id}_{safe_name(street_name)}"
    return (
        f"front/{base}_front.png",
        f"rear/{base}_rear.png",
        f"prodigi_h_mug_w/{base}.png",
    )


class R2:
    def __init__(self):
        account = required("R2_ACCOUNT_ID")
        self.bucket = os.getenv("R2_BUCKET_NAME", "mug-print-assets")
        self.client = boto3.client(
            "s3",
            endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
            aws_access_key_id=required("R2_ACCESS_KEY_ID"),
            aws_secret_access_key=required("R2_SECRET_ACCESS_KEY"),
            region_name="auto",
            config=Config(signature_version="s3v4", retries={"max_attempts": 5, "mode": "standard"}),
        )

    def head(self, key: str) -> Asset:
        try:
            result = self.client.head_object(Bucket=self.bucket, Key=key)
            etag = result.get("ETag")
            return Asset(key, True, result.get("ContentLength"), etag.strip('"') if etag else None)
        except ClientError as exc:
            err = exc.response.get("Error", {})
            code = str(err.get("Code", "Unknown"))
            if code in {"404", "NoSuchKey", "NotFound"}:
                return Asset(key, False, error="Object not found")
            return Asset(key, False, error=f"R2 error {code}: {err.get('Message', '')}")


def validation(front: Asset, rear: Asset, production: Asset):
    if not front.exists:
        return "hold", "missing_front", front.error
    if not rear.exists:
        return "hold", "missing_rear", rear.error
    if not production.exists:
        return "hold", "missing_production", production.error
    return "active", "valid", None


def write_reports(rows: list[Row], report_dir: Path, source: Path):
    report_dir.mkdir(parents=True, exist_ok=True)
    csv_path = report_dir / "catalogue_validation.csv"
    json_path = report_dir / "catalogue_validation.json"

    if rows:
        with csv_path.open("w", newline="", encoding="utf-8-sig") as fh:
            writer = csv.DictWriter(fh, fieldnames=list(asdict(rows[0]).keys()))
            writer.writeheader()
            writer.writerows(asdict(row) for row in rows)
    else:
        csv_path.write_text("", encoding="utf-8")

    valid = sum(row.validation_status == "valid" for row in rows)
    payload = {
        "source_report": str(source),
        "summary": {
            "eligible_designs": len(rows),
            "valid": valid,
            "hold": len(rows) - valid,
            "missing_front": sum(row.validation_status == "missing_front" for row in rows),
            "missing_rear": sum(row.validation_status == "missing_rear" for row in rows),
            "missing_production": sum(row.validation_status == "missing_production" for row in rows),
        },
        "designs": [asdict(row) for row in rows],
    }
    json_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return csv_path, json_path


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser()
    parser.add_argument("report", type=Path, help="Path to mockup_export_report.json")
    args = parser.parse_args()

    report_path = args.report.resolve()
    data = json.loads(report_path.read_text(encoding="utf-8"))
    source_items = [
        item for item in data.get("items", [])
        if item.get("eligibility") == "READY" and item.get("result") == "EXPORTED"
    ]

    r2 = R2()
    db = create_client(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"))
    prefix = os.getenv("DESIGN_CODE_PREFIX", "HB")
    locality = os.getenv("LOCALITY", "Hebden Bridge")
    sku = os.getenv("PRODUCT_SKU", "GLOBAL-MUG-W")
    rows: list[Row] = []

    for number, item in enumerate(source_items, 1):
        dataset_id = str(item["dataset_id"])
        street_id = str(item["street_id"]).zfill(4)
        street_name = str(item["street_name"]).strip()
        design_code = f"{prefix}-{street_id}"
        front_key, rear_key, production_key = keys(dataset_id, street_id, street_name)
        front, rear, production = r2.head(front_key), r2.head(rear_key), r2.head(production_key)
        status, check_status, reason = validation(front, rear, production)

        design_payload = {
            "design_code": design_code,
            "dataset_id": dataset_id,
            "street_id": street_id,
            "street_name": street_name,
            "locality": locality,
            "status": status,
        }
        response = db.table("designs").upsert(design_payload, on_conflict="dataset_id,street_id").execute()
        if not response.data:
            raise RuntimeError(f"Could not upsert design {design_code}")
        design_id = response.data[0]["id"]

        asset_payload = {
            "design_id": design_id,
            "product_sku": sku,
            "front_mockup_key": front_key,
            "rear_mockup_key": rear_key,
            "production_key": production_key,
            "version": 1,
            "validation_status": check_status,
            "front_size": front.size,
            "rear_size": rear.size,
            "production_size": production.size,
            "front_etag": front.etag,
            "rear_etag": rear.etag,
            "production_etag": production.etag,
        }
        db.table("design_assets").upsert(
            asset_payload, on_conflict="design_id,product_sku,version"
        ).execute()

        rows.append(Row(
            design_code, dataset_id, street_id, street_name, locality, sku,
            front_key, rear_key, production_key,
            front.exists, rear.exists, production.exists,
            front.size, rear.size, production.size,
            front.etag, rear.etag, production.etag,
            status, check_status, reason,
        ))
        print(f"[{number:03d}/{len(source_items):03d}] {'OK' if check_status == 'valid' else 'HOLD':4} {design_code} {street_name}")

    csv_path, json_path = write_reports(rows, Path(os.getenv("REPORT_DIR", "./reports")), report_path)
    valid = sum(row.validation_status == "valid" for row in rows)
    print(f"\nEligible: {len(rows)} | Valid: {valid} | Hold: {len(rows) - valid}")
    print(f"CSV:  {csv_path.resolve()}")
    print(f"JSON: {json_path.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
