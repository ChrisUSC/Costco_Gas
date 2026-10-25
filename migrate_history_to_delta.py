#!/usr/bin/env python3
"""
migrate_history_to_delta.py

Converts full-snapshot history JSON files to delta-based history JSON files.
In delta format:
- Each timestamp key only stores states and cities whose prices changed
  relative to their last known price.
- If no prices changed in a snapshot, it is omitted.
- The initial snapshot is preserved as the seed.
- Validates that every store's price at every historical timestamp is
  100% losslessly reconstructible.

Usage:
    python migrate_history_to_delta.py [file_to_convert] [--dry-run]
    python migrate_history_to_delta.py local_history.json --dry-run
    python migrate_history_to_delta.py us_history.json --dry-run
"""

import json
import os
import sys


def convert_to_delta(history: dict) -> tuple[dict, int, int]:
    timestamps = sorted(history.keys())
    if not timestamps:
        return {}, 0, 0

    delta_history = {}
    last_known = {}  # (state, city) -> price

    total_records_orig = 0
    total_records_delta = 0

    for ts in timestamps:
        snap = history[ts]
        delta_snap = {}

        for state, cities in sorted(snap.items()):
            state_deltas = {}
            for city, price in sorted(cities.items()):
                total_records_orig += 1
                key = (state, city)
                if key not in last_known or last_known[key] != price:
                    state_deltas[city] = price
                    last_known[key] = price
                    total_records_delta += 1

            if state_deltas:
                delta_snap[state] = state_deltas

        # Include if there are changes or if it's the very first timestamp
        if delta_snap or ts == timestamps[0]:
            delta_history[ts] = delta_snap

    return delta_history, total_records_orig, total_records_delta


def reconstruct_price_at(delta_history: dict, target_ts: str) -> dict:
    """Reconstructs the active prices across all stores as of target_ts."""
    active = {}
    valid_ts = sorted([t for t in delta_history.keys() if t <= target_ts], reverse=True)
    for ts in valid_ts:
        snap = delta_history[ts]
        for state, cities in snap.items():
            if state not in active:
                active[state] = {}
            for city, price in cities.items():
                if city not in active[state]:
                    active[state][city] = price
    return active


def verify_lossless(orig_history: dict, delta_history: dict) -> bool:
    """Verifies that for every timestamp and every store present in orig_history,
    the reconstructed delta price matches the original price exactly."""
    timestamps = sorted(orig_history.keys())
    mismatches = 0
    checks = 0

    for ts in timestamps:
        reconstructed = reconstruct_price_at(delta_history, ts)
        snap = orig_history[ts]
        for state, cities in snap.items():
            for city, orig_price in cities.items():
                checks += 1
                recon_price = reconstructed.get(state, {}).get(city)
                if recon_price != orig_price:
                    mismatches += 1
                    if mismatches <= 5:
                        print(f"  Mismatch at {ts} for {state}/{city}: expected {orig_price}, got {recon_price}")

    if mismatches > 0:
        print(f"❌ Verification failed: {mismatches}/{checks} mismatches.")
        return False
    print(f"✅ Lossless verification passed: {checks:,} data points checked with 0 errors (100% exact match).")
    return True


def write_pretty_top_level(data: dict, file_path: str) -> None:
    with open(file_path, "w", encoding="utf-8") as fp:
        fp.write("{\n")
        items = list(data.items())
        for i, (key, value) in enumerate(items):
            compact_value = json.dumps(value, separators=(',', ':'))
            comma = "," if i < len(items) - 1 else ""
            fp.write(f'  {json.dumps(key)}: {compact_value}{comma}\n')
        fp.write("}\n")


def main():
    if len(sys.argv) < 2:
        print("Usage: python migrate_history_to_delta.py <path_to_history.json> [--dry-run]")
        sys.exit(1)

    filepath = sys.argv[1]
    dry_run = "--dry-run" in sys.argv

    if not os.path.exists(filepath):
        print(f"File not found: {filepath}")
        sys.exit(1)

    with open(filepath, "r", encoding="utf-8") as f:
        orig = json.load(f)

    orig_bytes = os.path.getsize(filepath)
    delta_hist, total_orig, total_delta = convert_to_delta(orig)

    print(f"\nProcessing {filepath}:")
    print(f"• Original snapshots: {len(orig):,}  |  Delta snapshots: {len(delta_hist):,}")
    print(f"• Original store-price records: {total_orig:,}  |  Delta store-price records: {total_delta:,}")
    print(f"• Record reduction: {(1 - total_delta/total_orig)*100:.1f}% fewer records stored")

    # Verify
    is_valid = verify_lossless(orig, delta_hist)
    if not is_valid:
        print("Aborting: Delta reconstruction failed verification.")
        sys.exit(1)

    # Calculate serialized size
    temp_json = json.dumps(delta_hist, separators=(',', ':'))
    delta_bytes = len(temp_json)
    savings = (1.0 - (delta_bytes / orig_bytes)) * 100.0
    print(f"• File size: {orig_bytes / (1024*1024):.2f} MB -> {delta_bytes / (1024*1024):.2f} MB ({savings:.1f}% savings)")

    if dry_run:
        print("\n[Dry run] No files written. Remove --dry-run to apply.")
    else:
        backup_path = f"{filepath}.bak"
        print(f"\nCreating backup at {backup_path}...")
        with open(backup_path, "w", encoding="utf-8") as f:
            f.write(json.dumps(orig))
        print(f"Writing delta history to {filepath}...")
        write_pretty_top_level(delta_hist, filepath)
        print("Done!")


if __name__ == "__main__":
    main()
