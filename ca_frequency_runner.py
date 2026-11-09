#!/usr/bin/env python3
"""
ca_frequency_runner.py

Tracks gas price changes across all California Costco warehouses (119 stores)
at higher frequency, storing results in dedicated files isolated from production:
- History: ca_freq_history.json  (change-only delta format)
- Latest:  ca_freq_latest.json   (latest active snapshot)

Usage:
    python ca_frequency_runner.py
"""

import json
import os
import sys

from scraper import (
    load_store_locations,
    load_latest_prices,
    get_gas_prices_ajax,
    validate_snapshot,
    compute_price_deltas,
    reconstruct_store_prices_at,
    find_trend_baseline,
    write_pretty_top_level,
)

CA_STORES_FILE = "ca_stores.json"
CA_FREQ_HISTORY_FILE = "ca_freq_history.json"
CA_FREQ_LATEST_FILE = "ca_freq_latest.json"

# True: only rewrite the latest file when a price actually changed (or it doesn't exist yet).
#       Avoids a commit on every run, but the file's "timestamp" then means "last change",
#       not "last check".
# False: rewrite it every run (timestamp = last check, but one commit per run).
WRITE_LATEST_ONLY_ON_CHANGE = True


def run_ca_tracker(
    stores_path: str = CA_STORES_FILE,
    history_path: str = CA_FREQ_HISTORY_FILE,
    latest_path: str = CA_FREQ_LATEST_FILE,
) -> bool:
    stores = load_store_locations(stores_path)
    if not stores:
        print(f"❌ Failed to load stores from {stores_path}")
        return False

    total_stores = sum(len(cities) for cities in stores.values())
    print(f"🚗 Starting California Gas Price Tracking ({total_stores} stores)...")

    # Load existing frequency history FIRST. If it exists but can't be read, abort before
    # doing any scraping so we never overwrite real history with a fresh seed.
    history = {}
    if os.path.exists(history_path) and os.path.getsize(history_path) > 0:
        try:
            with open(history_path, "r", encoding="utf-8") as f:
                history = json.load(f)
        except Exception as e:
            print(f"❌ Could not read {history_path}: {e}")
            print("Aborting to protect existing history. Fix or restore the file and re-run.")
            return False

    # Prioritize existing frequency latest, fall back to production ca_latest.json
    latest_known = load_latest_prices(latest_path)
    if not latest_known and os.path.exists("ca_latest.json"):
        latest_known = load_latest_prices("ca_latest.json")

    prices = get_gas_prices_ajax(
        stores,
        last_known_prices=latest_known,
        verify_all_changes=True,
    )

    timestamp = next(iter(prices))
    fetched = prices[timestamp]

    is_valid, reason = validate_snapshot(fetched, stores)
    if not is_valid:
        print(f"⚠️ REJECTED CA snapshot ({timestamp}): {reason}")
        print("Run's data looks incomplete; aborting save to avoid corrupting frequency history.")
        return False

    # Compute trend baseline (~72h lookback) from history as it stood before this run
    prev_prices, prev_timestamp = find_trend_baseline(history, timestamp)

    # Delta storage: only save when prices change
    changed = False
    if history:
        current_active = reconstruct_store_prices_at(history, timestamp)
        deltas = compute_price_deltas(fetched, current_active)
        if deltas:
            history[timestamp] = deltas
            write_pretty_top_level(history, history_path)
            changed = True
            num_changes = sum(len(cities) for cities in deltas.values())
            print(f"✨ Found {num_changes} store price change(s). Appended to {history_path}")
        else:
            print(f"ℹ️ No price changes detected since previous check. {history_path} left untouched.")
    else:
        # Seed first snapshot
        history[timestamp] = fetched
        write_pretty_top_level(history, history_path)
        changed = True
        print(f"🌱 Seeded initial CA frequency baseline in {history_path}")

    # Write latest snapshot
    if WRITE_LATEST_ONLY_ON_CHANGE and not changed and os.path.exists(latest_path):
        print(f"ℹ️ No changes; {latest_path} left untouched.")
        return True

    latest_payload = {
        "timestamp": timestamp,
        "prices": fetched,
        "previous": prev_prices,
        "previous_timestamp": prev_timestamp,
    }
    tmp_path = f"{latest_path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(latest_payload, f, separators=(',', ':'))
    os.replace(tmp_path, latest_path)

    print(f"✅ Saved latest CA snapshot -> {latest_path}")
    return True


def main():
    success = run_ca_tracker()
    if not success:
        sys.exit(1)


if __name__ == "__main__":
    main()
