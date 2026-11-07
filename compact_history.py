#!/usr/bin/env python3
"""
compact_history.py

One-time conversion of a full-snapshot history file (e.g. us_history.json) into the
change-only delta format used by scraper.save_data(delta_mode=True).

Safety:
  * Nothing is written unless the delta version reconstructs to EXACTLY the same
    store prices as the original at every timestamp.
  * A backup of the original is saved as <file>.bak (never overwritten) before it is replaced.
  * Running it on a file that is already delta-only is a no-op.

Usage:
    python compact_history.py us_history.json [local_history.json ca_history.json ...]
    python compact_history.py us_history.json --dry-run
"""

import json
import os
import shutil
import sys

from scraper import compute_price_deltas, reconstruct_store_prices_at, write_pretty_top_level


def to_deltas(history: dict) -> dict:
    """Keeps only the entries/stores whose prices differ from the last known state."""
    active: dict = {}
    out: dict = {}
    for ts in sorted(history):
        snapshot = history[ts]
        delta = compute_price_deltas(snapshot, active)
        for state, cities in snapshot.items():
            active.setdefault(state, {}).update(cities)
        if delta:
            out[ts] = delta
    return out


def verify(original: dict, compacted: dict) -> tuple[bool, str]:
    """Checks the as-of state matches at every original timestamp (incrementally),
    then spot-checks with the real reconstruct_store_prices_at() function."""
    state_a: dict = {}
    state_b: dict = {}
    for ts in sorted(set(original) | set(compacted)):
        for src, dst in ((original, state_a), (compacted, state_b)):
            for state, cities in src.get(ts, {}).items():
                dst.setdefault(state, {}).update(cities)
        if ts in original and state_a != state_b:
            return False, f"state mismatch at {ts}"

    timestamps = sorted(original)
    step = max(1, len(timestamps) // 25)
    sample = timestamps[::step] + [timestamps[-1]]
    for ts in sample:
        if reconstruct_store_prices_at(original, ts) != reconstruct_store_prices_at(compacted, ts):
            return False, f"reconstruct_store_prices_at mismatch at {ts}"
    return True, f"{len(original)} timestamps checked"


def compact_file(path: str, dry_run: bool = False) -> bool:
    if not os.path.exists(path):
        print(f"- {path}: not found, skipping")
        return True

    with open(path, "r", encoding="utf-8") as f:
        original = json.load(f)
    if not original:
        print(f"- {path}: empty, skipping")
        return True

    compacted = to_deltas(original)
    ok, detail = verify(original, compacted)
    if not ok:
        print(f"✗ {path}: verification FAILED ({detail}). File left untouched.")
        return False

    before = os.path.getsize(path)
    records_before = sum(len(c) for snap in original.values() for c in snap.values())
    records_after = sum(len(c) for snap in compacted.values() for c in snap.values())
    print(f"✓ {path}: verified ({detail})")
    print(f"    entries {len(original)} -> {len(compacted)}, "
          f"store-records {records_before:,} -> {records_after:,}")

    if compacted == original:
        print("    already compact: nothing to do")
        return True

    if dry_run:
        print("    dry run: nothing written")
        return True

    # Never overwrite an existing backup (it may be the only copy of the full snapshots).
    backup = f"{path}.bak"
    n = 1
    while os.path.exists(backup):
        n += 1
        backup = f"{path}.bak{n}"
    shutil.copy2(path, backup)
    write_pretty_top_level(compacted, path)
    after = os.path.getsize(path)
    print(f"    size {before/1e6:.2f} MB -> {after/1e6:.2f} MB  (backup: {backup})")
    return True


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry_run = "--dry-run" in sys.argv
    if not args:
        print(__doc__)
        sys.exit(1)
    results = [compact_file(p, dry_run) for p in args]
    if not all(results):
        sys.exit(1)


if __name__ == "__main__":
    main()
