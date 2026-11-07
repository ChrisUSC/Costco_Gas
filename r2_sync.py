#!/usr/bin/env python3
"""
Sync utility between local JSON files and Cloudflare R2 object storage.
Used by GitHub Actions to download historical baselines before scraping
and upload updated snapshots after scraping.
"""

from __future__ import annotations

import os
import sys
from typing import Sequence

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

DEFAULT_FILES = [
    "us_latest.json",
    "us_history.json",
    "ca_latest.json",
    "ca_history.json",
    "local_latest.json",
    "local_history.json",
    "ca_freq_latest.json",
    "ca_freq_history.json",
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
    print(f"⬇️ Downloading baseline snapshots from R2 bucket '{bucket}'...")

    for filename in files:
        tmp_name = f"{filename}.r2tmp"
        try:
            client.download_file(bucket, filename, tmp_name)
            os.replace(tmp_name, filename)
            size = os.path.getsize(filename)
            print(f"  ✓ Downloaded {filename} ({size:,} bytes)")
        except ClientError as e:
            if os.path.exists(tmp_name):
                os.remove(tmp_name)
            code = e.response.get("Error", {}).get("Code", "")
            if code in ("404", "NoSuchKey"):
                print(f"  ℹ {filename} does not exist in R2 yet (skipping)")
            else:
                print(f"  ⚠️ Warning: Failed to download {filename}: {e}")
        except Exception as e:
            if os.path.exists(tmp_name):
                os.remove(tmp_name)
            print(f"  ⚠️ Warning: Unexpected error downloading {filename}: {e}")


def upload_files(files: Sequence[str]):
    client = get_s3_client()
    bucket = os.environ["R2_BUCKET_NAME"]
    print(f"⬆️ Uploading updated snapshots to R2 bucket '{bucket}'...")

    uploaded_count = 0
    for filename in files:
        if not os.path.exists(filename):
            print(f"  - Skipping {filename} (file does not exist locally)")
            continue

        cache_control = (
            "public, max-age=300" if "latest" in filename else "public, max-age=3600"
        )
        try:
            client.upload_file(
                filename,
                bucket,
                filename,
                ExtraArgs={
                    "ContentType": "application/json",
                    "CacheControl": cache_control,
                },
            )
            size = os.path.getsize(filename)
            print(f"  ✓ Uploaded {filename} ({size:,} bytes) [Cache-Control: {cache_control}]")
            uploaded_count += 1
        except Exception as e:
            print(f"  ❌ Error uploading {filename}: {e}")
            sys.exit(1)

    print(f"🎉 Successfully uploaded {uploaded_count} file(s) to R2.")


def main():
    if len(sys.argv) < 2:
        print("Usage: python r2_sync.py [download|upload|test] [file1 file2 ...]")
        sys.exit(1)

    action = sys.argv[1].lower()
    custom_files = sys.argv[2:] if len(sys.argv) > 2 else DEFAULT_FILES

    if action == "download":
        download_files(custom_files)
    elif action == "upload":
        upload_files(custom_files)
    elif action == "test":
        test_connection()
    else:
        print(f"Unknown action: {action}. Choose from: download, upload, test")
        sys.exit(1)


if __name__ == "__main__":
    main()
