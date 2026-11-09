#!/usr/bin/env python3
"""
analyze_price_frequency.py

Analyzes gas price change velocity and frequency across Costco warehouses.
Works with us_history.json, ca_history.json, local_history.json, or any
frequency experiment history file.

Usage:
    python pipeline/analyze_price_frequency.py [history_file]
    python pipeline/analyze_price_frequency.py data/snapshots/ca_freq_history.json

With no argument, the first of us/ca/local_history.json found in data/snapshots/ is used.
"""

import json
import os
import sys
from collections import defaultdict
from datetime import datetime

from paths import snapshot_path


def load_history(filepath: str) -> dict:
    if not os.path.exists(filepath):
        print(f"Error: File not found: {filepath}")
        sys.exit(1)
    with open(filepath, "r", encoding="utf-8") as f:
        return json.load(f)


def analyze(history: dict, filename: str) -> None:
    timestamps = sorted(history.keys())
    if len(timestamps) < 2:
        print(f"File {filename} has fewer than 2 snapshots; cannot analyze frequency.")
        return

    # Basic stats
    first_dt = datetime.strptime(timestamps[0], "%Y-%m-%d %H:%M")
    last_dt = datetime.strptime(timestamps[-1], "%Y-%m-%d %H:%M")
    total_days = max(1.0, (last_dt - first_dt).total_seconds() / 86400.0)

    # Scrape intervals
    intervals_hours = []
    for i in range(1, len(timestamps)):
        t1 = datetime.strptime(timestamps[i - 1], "%Y-%m-%d %H:%M")
        t2 = datetime.strptime(timestamps[i], "%Y-%m-%d %H:%M")
        intervals_hours.append((t2 - t1).total_seconds() / 3600.0)

    avg_interval = sum(intervals_hours) / len(intervals_hours) if intervals_hours else 0.0
    sorted_intervals = sorted(intervals_hours)
    median_interval = sorted_intervals[len(sorted_intervals) // 2] if sorted_intervals else 0.0

    # Track stores and changes
    all_stores = set()
    store_change_timestamps = defaultdict(list)
    store_observations = defaultdict(int)
    store_price_sequence = defaultdict(list)

    # Hourly distribution of changes (PT)
    hourly_changes = defaultdict(int)
    hourly_runs = defaultdict(int)
    hourly_comparisons = defaultdict(int)

    # Day of week distribution
    dow_changes = defaultdict(int)
    dow_runs = defaultdict(int)

    # Grade moves
    reg_moves, prem_moves, diesel_moves = 0, 0, 0
    flapping_count, total_flappable_changes = 0, 0

    # Per-run stats
    pct_changed_per_run = []
    stores_changed_per_run = []

    # Store-date intraday changes: store -> date_str -> count
    store_date_changes = defaultdict(lambda: defaultdict(int))

    # Initialize running state from baseline snapshot
    running_prices = {}
    first_snap = history[timestamps[0]]
    for state, cities in first_snap.items():
        running_prices[state] = {}
        for city, price in cities.items():
            store_key = f"{state} - {city}"
            all_stores.add(store_key)
            running_prices[state][city] = price
            store_price_sequence[store_key].append(price)

    # Detect if this history is delta-only (change-only entries)
    baseline_store_count = len(all_stores)
    is_delta_history = False
    for ts in timestamps[1:]:
        snap_count = sum(len(c) for c in history[ts].values())
        if baseline_store_count > 10 and snap_count < baseline_store_count * 0.7:
            is_delta_history = True
            break

    for i in range(1, len(timestamps)):
        t_curr = timestamps[i]
        d_curr = history[t_curr]

        dt_curr = datetime.strptime(t_curr, "%Y-%m-%d %H:%M")
        hour = dt_curr.hour
        dow = dt_curr.strftime("%A")
        date_str = dt_curr.strftime("%Y-%m-%d")

        hourly_runs[hour] += 1
        dow_runs[dow] += 1

        run_comparable = 0
        run_changes = 0

        for state, cities in d_curr.items():
            if state not in running_prices:
                running_prices[state] = {}
            for city, p_curr in cities.items():
                store_key = f"{state} - {city}"
                all_stores.add(store_key)

                p_prev = running_prices[state].get(city)
                if p_prev is not None:
                    run_comparable += 1
                    store_observations[store_key] += 1
                    hourly_comparisons[hour] += 1

                    if p_prev != p_curr:
                        run_changes += 1
                        hourly_changes[hour] += 1
                        dow_changes[dow] += 1
                        store_change_timestamps[store_key].append(t_curr)
                        store_date_changes[store_key][date_str] += 1

                        # Flapping test: store moved A -> B -> A
                        store_price_sequence[store_key].append(p_curr)
                        if len(store_price_sequence[store_key]) >= 3:
                            total_flappable_changes += 1
                            if store_price_sequence[store_key][-1] == store_price_sequence[store_key][-3]:
                                flapping_count += 1

                        # Grade breakdown
                        r0 = p_prev[0] if len(p_prev) > 0 else None
                        r1 = p_curr[0] if len(p_curr) > 0 else None
                        if r0 != r1 and r0 is not None and r1 is not None:
                            reg_moves += 1

                        p0 = p_prev[1] if len(p_prev) > 1 else None
                        p1 = p_curr[1] if len(p_curr) > 1 else None
                        if p0 != p1 and p0 is not None and p1 is not None:
                            prem_moves += 1

                        d0 = p_prev[2] if len(p_prev) > 2 else None
                        d1 = p_curr[2] if len(p_curr) > 2 else None
                        if d0 != d1 and d0 is not None and d1 is not None:
                            diesel_moves += 1
                else:
                    store_price_sequence[store_key].append(p_curr)

                running_prices[state][city] = p_curr

        effective_comparable = len(all_stores) if is_delta_history else run_comparable
        if effective_comparable > 0:
            stores_changed_per_run.append(run_changes)
            pct_changed_per_run.append((run_changes / effective_comparable) * 100.0)

    # Intraday changes breakdown
    single_change_days = 0
    multiple_change_days = 0
    for store_key, dates in store_date_changes.items():
        for d_str, count in dates.items():
            if count == 1:
                single_change_days += 1
            else:
                multiple_change_days += 1
    total_change_days = single_change_days + multiple_change_days

    # Per-store monthly frequency
    monthly_rates = []
    for store_key in all_stores:
        changes = len(store_change_timestamps[store_key])
        monthly_rates.append(changes / (total_days / 30.0))

    sorted_monthly = sorted(monthly_rates)
    avg_monthly = sum(monthly_rates) / len(monthly_rates) if monthly_rates else 0.0
    med_monthly = sorted_monthly[len(sorted_monthly) // 2] if sorted_monthly else 0.0

    # Calculate delta storage savings
    compact_orig = len(json.dumps(history, separators=(',', ':')))
    delta_hist = {}
    last_known = {}
    for ts in timestamps:
        snap = history[ts]
        delta_snap = {}
        for state, cities in snap.items():
            for city, price in cities.items():
                k = (state, city)
                if k not in last_known or last_known[k] != price:
                    if state not in delta_snap:
                        delta_snap[state] = {}
                    delta_snap[state][city] = price
                    last_known[k] = price
        if delta_snap:
            delta_hist[ts] = delta_snap
    compact_delta = len(json.dumps(delta_hist, separators=(',', ':')))
    savings_pct = (1.0 - (compact_delta / compact_orig)) * 100.0 if compact_orig else 0

    # --- Print Structured Analysis ---
    sep = "=" * 70
    print(sep)
    print(f" GAS PRICE SCRAPING FREQUENCY & VELOCITY ANALYSIS: {os.path.basename(filename)}")
    print(sep)
    print(f"• Total Snapshots:     {len(timestamps):,} snapshots" + (" (delta change events)" if is_delta_history else ""))
    print(f"• Date Range:          {timestamps[0]}  to  {timestamps[-1]} ({total_days:.1f} days)")
    print(f"• Unique Stores:       {len(all_stores):,} warehouses tracked")
    interval_label = "Change Event Interval" if is_delta_history else "Scrape Interval"
    print(f"• {interval_label}: Mean: {avg_interval:.1f}h  |  Median: {median_interval:.1f}h" + (" (runs with no changes not stored in delta history)" if is_delta_history else ""))
    print()
    print("─── 1. ARE WE CHECKING OFTEN ENOUGH OR TOO OFTEN? ───")
    if pct_changed_per_run:
        avg_pct = sum(pct_changed_per_run) / len(pct_changed_per_run)
        avg_stores = sum(stores_changed_per_run) / len(stores_changed_per_run)
        print(f"• Stores changing price per scrape:  {avg_stores:.1f} stores ({avg_pct:.1f}% of all stores)")
        print(f"• Min / Max stores changed in a run: {min(stores_changed_per_run)} ({min(pct_changed_per_run):.1f}%) / {max(stores_changed_per_run)} ({max(pct_changed_per_run):.1f}%)")
    print(f"• Individual store change frequency: {avg_monthly:.1f} times/month (median: {med_monthly:.1f}/mo, ~{med_monthly/4.33:.1f}/week)")
    intraday_pct = (multiple_change_days / total_change_days * 100.0) if total_change_days > 0 else 0.0
    print(f"• Intraday price changes (>1 change/day): {multiple_change_days:,} out of {total_change_days:,} active store-days ({intraday_pct:.1f}%)")
    if total_flappable_changes > 0:
        flap_pct = (flapping_count / total_flappable_changes) * 100.0
        perm_pct = 100.0 - flap_pct
        print(f"• Flapping rate (A -> B -> A jitter): {flapping_count:,} of {total_flappable_changes:,} ({flap_pct:.1f}%) -> {perm_pct:.1f}% are permanent price moves")
    else:
        print("• Flapping rate (A -> B -> A jitter): 0 of 0 (insufficient history; requires ≥2 changes per store to detect oscillation)")
    print()
    print("─── 2. WHEN DO PRICES CHANGE? (HOURLY PT DISTRIBUTION) ───")
    sorted_hours = sorted(hourly_runs.keys())
    for h in sorted_hours:
        runs = hourly_runs[h]
        chgs = hourly_changes[h]
        comps = (len(all_stores) * runs) if is_delta_history else hourly_comparisons[h]
        pct = (chgs / comps * 100.0) if comps else 0
        bar = "█" * int(pct / 2.5)
        print(f"  Hour {h:02d}:00 PT | {runs:3d} runs | {chgs/runs:5.1f} changes/run | {pct:5.1f}% stores changed {bar}")
    print()
    print("─── 3. DAY OF WEEK PATTERNS (AVG CHANGES PER RUN) ───")
    for d in ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]:
        runs = dow_runs[d]
        chgs = dow_changes[d]
        avg = (chgs / runs) if runs else 0
        bar = "█" * int(avg / 10)
        print(f"  {d:<10} | {runs:3d} runs | {avg:5.1f} changes/run {bar}")
    print()
    print("─── 4. FUEL GRADE BREAKDOWN ───")
    total_grade_moves = reg_moves + prem_moves + diesel_moves
    if total_grade_moves:
        print(f"• Regular Unleaded moves: {reg_moves:,} ({reg_moves/total_grade_moves*100:.1f}%)")
        print(f"• Premium Unleaded moves: {prem_moves:,} ({prem_moves/total_grade_moves*100:.1f}%)")
        print(f"• Diesel moves:           {diesel_moves:,} ({diesel_moves/total_grade_moves*100:.1f}%)")
    print()
    print("─── 5. STORAGE & COMPRESSION IMPACT (DELTA-BASED STORAGE) ───")
    print(f"• Current snapshot file size:  {compact_orig / (1024*1024):.2f} MB ({compact_orig:,} bytes)")
    print(f"• Delta-only history size:     {compact_delta / (1024*1024):.2f} MB ({compact_delta:,} bytes)")
    print(f"• Immediate storage savings:   {savings_pct:.1f}% reduction ({((compact_orig - compact_delta)/(1024*1024)):.2f} MB saved)")
    print(sep)


def main():
    if len(sys.argv) > 1:
        target_file = sys.argv[1]
    else:
        candidates = [snapshot_path(n) for n in ("us_history.json", "ca_history.json", "local_history.json")]
        target_file = next((c for c in candidates if os.path.exists(c)), candidates[0])
    history = load_history(target_file)
    analyze(history, target_file)


if __name__ == "__main__":
    main()
