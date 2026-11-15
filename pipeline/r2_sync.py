#!/usr/bin/env python3
"""
Sync utility between local JSON files and Cloudflare R2 object storage.
Used by GitHub Actions to download historical baselines before scraping
and upload updated snapshots after scraping, with automated daily backup snapshots.
"""

from __future__ import annotations

import os
import re
import sys
from datetime import datetime, timezone
from typing import Sequence

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from paths import SNAPSHOT_DIR, snapshot_path

DEFAULT_FILES = [
    "us_latest.json",
    "us_history.json",
    "ca_latest.json",
    "ca_history.json",
    "local_latest.json",
    "local_history.json",
]


def get_s3_client():
    required_envs = [
        "R2_ACCOUNT_ID",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
        "R2_BUCKET_NAME",
    ]
    missing = [var for var in required_envs if not os.environ.get(var)]
    if missing:
        print(f"❌ Missing required environment variables: {', '.join(missing)}")
        print("Please set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET_NAME.")
        sys.exit(1)

    account_id = os.environ["R2_ACCOUNT_ID"].strip()
    access_key = os.environ["R2_ACCESS_KEY_ID"].strip()
    secret_key = os.environ["R2_SECRET_ACCESS_KEY"].strip()

    endpoint = f"https://{account_id}.r2.cloudflarestorage.com"
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
        config=Config(signature_version="s3v4", retries={"max_attempts": 3, "mode": "standard"}),
    )


def test_connection():
    bucket = os.environ.get("R2_BUCKET_NAME")
    print(f"Testing connection to R2 bucket '{bucket}'...")
    client = get_s3_client()
    try:
        client.head_bucket(Bucket=bucket)
        print(f"✅ Successfully connected to R2 bucket '{bucket}'.")
        resp = client.list_objects_v2(Bucket=bucket, MaxKeys=10)
        contents = resp.get("Contents", [])
        if contents:
            print(f"Found {len(contents)} object(s) in bucket:")
            for obj in contents:
                print(f"  - {obj['Key']} ({obj['Size']:,} bytes)")
        else:
            print("Bucket is currently empty.")
    except ClientError as e:
        print(f"❌ Failed to connect to bucket: {e}")
        sys.exit(1)


def download_files(files: Sequence[str]):
    client = get_s3_client()
    bucket = os.environ["R2_BUCKET_NAME"]
    print(f"⬇️ Downloading baseline snapshots from R2 bucket '{bucket}' into {SNAPSHOT_DIR}...")
    os.makedirs(SNAPSHOT_DIR, exist_ok=True)

    # A file that is missing in R2 is fine (first run). Any other failure must stop the job:
    # carrying on without the history would make the scraper seed a fresh one-entry history,
    # and the upload step would then overwrite the real history in R2 with it.
    failed = []
    for filename in files:
        local_path = snapshot_path(filename)
        tmp_name = f"{local_path}.r2tmp"
        try:
            client.download_file(bucket, filename, tmp_name)
            os.replace(tmp_name, local_path)
            size = os.path.getsize(local_path)
            print(f"  ✓ Downloaded {filename} ({size:,} bytes)")
        except ClientError as e:
            if os.path.exists(tmp_name):
                os.remove(tmp_name)
            code = e.response.get("Error", {}).get("Code", "")
            if code in ("404", "NoSuchKey"):
                print(f"  ℹ {filename} does not exist in R2 yet (skipping)")
            else:
                print(f"  ❌ Failed to download {filename}: {e}")
                failed.append(filename)
        except Exception as e:
            if os.path.exists(tmp_name):
                os.remove(tmp_name)
            print(f"  ❌ Unexpected error downloading {filename}: {e}")
            failed.append(filename)

    if failed:
        print(f"❌ {len(failed)} download(s) failed: {', '.join(failed)}. "
              f"Stopping so stale or missing snapshots are never uploaded over the real ones.")
        sys.exit(1)


def upload_files(files: Sequence[str]):
    client = get_s3_client()
    bucket = os.environ["R2_BUCKET_NAME"]
    print(f"⬆️ Uploading updated snapshots to R2 bucket '{bucket}'...")

    uploaded_count = 0
    today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    for filename in files:
        local_path = snapshot_path(filename)
        if not os.path.exists(local_path):
            print(f"  - Skipping {filename} (file does not exist locally)")
            continue

        cache_control = (
            "public, max-age=300" if "latest" in filename else "public, max-age=3600"
        )
        try:
            # 1. Upload current live object
            client.upload_file(
                local_path,
                bucket,
                filename,
                ExtraArgs={
                    "ContentType": "application/json",
                    "CacheControl": cache_control,
                },
            )
            size = os.path.getsize(local_path)
            print(f"  ✓ Uploaded {filename} ({size:,} bytes) [Cache-Control: {cache_control}]")
            uploaded_count += 1

            # 2. For history files, also keep a dated backup (one key per UTC day; each run
            #    overwrites that day's copy, so it holds the day's latest state)
            if "history" in filename:
                base_name = os.path.splitext(filename)[0]
                backup_key = f"backups/{base_name}_{today_str}.json"
                client.upload_file(
                    local_path,
                    bucket,
                    backup_key,
                    ExtraArgs={
                        "ContentType": "application/json",
                        "CacheControl": "public, max-age=86400",
                    },
                )
                print(f"  🔒 Saved daily backup snapshot -> {backup_key}")

        except Exception as e:
            print(f"  ❌ Error uploading {filename}: {e}")
            sys.exit(1)

    print(f"🎉 Successfully uploaded {uploaded_count} file(s) to R2.")


def list_backups():
    client = get_s3_client()
    bucket = os.environ["R2_BUCKET_NAME"]
    print(f"Listing backup snapshots in R2 bucket '{bucket}' (prefix: backups/)...")
    try:
        resp = client.list_objects_v2(Bucket=bucket, Prefix="backups/")
        contents = resp.get("Contents", [])
        if not contents:
            print("No backup snapshots found yet.")
            return

        print(f"Found {len(contents)} backup snapshot(s):")
        for obj in contents:
            size_kb = obj["Size"] / 1024
            last_mod = obj["LastModified"].strftime("%Y-%m-%d %H:%M UTC")
            print(f"  - {obj['Key']} ({size_kb:,.1f} KB, modified: {last_mod})")
    except ClientError as e:
        print(f"❌ Error listing backups: {e}")
        sys.exit(1)


def restore_backup(backup_key: str, target_file: str | None = None):
    client = get_s3_client()
    bucket = os.environ["R2_BUCKET_NAME"]

    if not target_file:
        # Infer target file, e.g. backups/us_history_2026-11-07.json -> data/snapshots/us_history.json
        base = os.path.basename(backup_key)
        target_file = snapshot_path(re.sub(r'_\d{4}-\d{2}-\d{2}\.json$', '.json', base))
        os.makedirs(SNAPSHOT_DIR, exist_ok=True)

    print(f"Restoring '{backup_key}' from R2 to local file '{target_file}'...")
    try:
        client.download_file(bucket, backup_key, target_file)
        print(f"✅ Successfully restored {backup_key} -> {target_file} ({os.path.getsize(target_file):,} bytes)")
    except ClientError as e:
        print(f"❌ Error restoring backup: {e}")
        sys.exit(1)


def main():
    if len(sys.argv) < 2:
        print("Usage:")
        print("  python pipeline/r2_sync.py download [file1 file2 ...]")
        print("  python pipeline/r2_sync.py upload [file1 file2 ...]")
        print("  python pipeline/r2_sync.py list-backups")
        print("  python pipeline/r2_sync.py restore <backup_key> [target_file]")
        print("  python pipeline/r2_sync.py test")
        sys.exit(1)

    action = sys.argv[1].lower()
    custom_files = sys.argv[2:] if len(sys.argv) > 2 else DEFAULT_FILES

    if action == "download":
        download_files(custom_files)
    elif action == "upload":
        upload_files(custom_files)
    elif action == "list-backups":
        list_backups()
    elif action == "restore":
        if len(sys.argv) < 3:
            print("Usage: python pipeline/r2_sync.py restore <backup_key> [target_file]")
            sys.exit(1)
        target = sys.argv[3] if len(sys.argv) > 3 else None
        restore_backup(sys.argv[2], target)
    elif action == "test":
        test_connection()
    else:
        print(f"Unknown action: {action}.")
        print("Valid actions: download, upload, list-backups, restore, test")
        sys.exit(1)


if __name__ == "__main__":
    main()
