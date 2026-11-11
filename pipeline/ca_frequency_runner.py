#!/usr/bin/env python3
"""
ca_frequency_runner.py

Tracks gas price changes across all California Costco warehouses (119 stores)
at higher frequency, storing results in dedicated files isolated from production:
- History: ca_freq_history.json  (change-only delta format)
- Latest:  ca_freq_latest.json   (latest active snapshot)

Usage:
    python pipeline/ca_frequency_runner.py
"""

import sys

from scraper import get_gas_prices_ajax, load_history, load_latest_prices, load_store_locations, process_and_save
from paths import CA_STORES_FILE, snapshot_path

CA_FREQ_HISTORY_FILE = snapshot_path("ca_freq_history.json")
CA_FREQ_LATEST_FILE = snapshot_path("ca_freq_latest.json")
CA_LATEST_FILE = snapshot_path("ca_latest.json")

# True: only rewrite the latest file when a price actually changed (or it doesn't exist yet).
#       The file's "timestamp" then means "last change", not "last check".
# False: rewrite it every run (timestamp = last check).
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

    # Check the history BEFORE scraping: if it exists but can't be read, stop now so the
    # run never seeds a fresh history over the real one.
    if load_history(history_path) is None:
        print("Aborting to protect existing history. Fix or restore the file and re-run.")
        return False

    # Prefer the frequency tracker's own latest prices, falling back to production ca_latest.json.
    last_known = load_latest_prices(latest_path) or load_latest_prices(CA_LATEST_FILE)

    # Module globals are read here (not as defaults) so tests can monkeypatch them.
    return process_and_save(
        stores,
        history_path,
        latest_path,
        "CA frequency",
        verify_all_changes=True,
        last_known=last_known,
        write_latest_only_on_change=WRITE_LATEST_ONLY_ON_CHANGE,
        fetch_prices=get_gas_prices_ajax,
    )


def main():
    success = run_ca_tracker()
    if not success:
        sys.exit(1)


if __name__ == "__main__":
    main()
