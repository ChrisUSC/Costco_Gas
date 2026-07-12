import os
import json
import random
import time
import requests
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from bs4 import BeautifulSoup
from datetime import datetime, timedelta


# List of User-Agents to rotate
USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'
]

MAX_FETCH_ATTEMPTS = 5
EXCLUDED_STATES = {"PR"}

# --- Safety valve against wiping the store database ---
# If more than this fraction of stores fail to return a price in a single run,
# treat it as a systemic problem (rate limiting / IP block / Costco outage)
# rather than individual stores losing their gas station, and skip deleting
# anything from the store file. Only applies once there are enough stores in
# the run for a failure *rate* to be meaningful.
FAILURE_RATE_THRESHOLD = 0.25
MIN_STORES_FOR_CIRCUIT_BREAKER = 10

# Second tier: catches near-total blackouts even on small runs (e.g. the 9-store
# local_stores.json), where the run is too small for the tier above to ever fire.
# Legitimate same-day closures essentially never hit 80%+ of a batch at once.
HIGH_FAILURE_RATE_THRESHOLD = 0.8
MIN_STORES_FOR_HIGH_RATE_CHECK = 3

# --- Snapshot completeness check (separate from the two breakers above) ---
# Those breakers only protect us_stores.json from having stores *deleted*.
# They don't stop a partially-failed run from still writing an incomplete
# snapshot to *_latest.json/*_history.json. This is that second check: it
# compares what actually came back against what we set out to fetch, and
# blocks the save entirely if too much of it is missing.
SNAPSHOT_STATE_COVERAGE_THRESHOLD = 0.85   # need prices for >=85% of expected states
SNAPSHOT_STORE_COVERAGE_THRESHOLD = 0.75   # need prices for >=75% of expected stores

# Each price file is now split in two:
#   *_history.json - full timestamped log (grows over time, used only for charts)
#   *_latest.json  - just the newest snapshot (small, used for the map/sidebar on every page load)
LOCAL_HISTORY_FILE, LOCAL_LATEST_FILE = 'local_history.json', 'local_latest.json'
CA_HISTORY_FILE, CA_LATEST_FILE = 'ca_history.json', 'ca_latest.json'
US_HISTORY_FILE, US_LATEST_FILE = 'us_history.json', 'us_latest.json'

# --- Trend baseline window ---
# Runs happen every ~8 hours, so comparing against "whatever the previous
# run was" (the old behavior) is only ~8h apart - not enough for gas prices
# to move visibly, which made every trend arrow look flat. Compare against
# a snapshot from further back instead.
TREND_LOOKBACK_HOURS = 72
TREND_LOOKBACK_TOLERANCE_HOURS = 12 # accept the closest match within +/- this many hours

# --- Price-jump sanity check ---
# Costco's AJAX endpoint occasionally returns a stale/cached or otherwise
# wrong price for a single store on a single fetch. Compare each fresh price
# against the last *saved* price for that store; if it moved by more than
# either threshold below, re-fetch a couple of times (with a short random
# delay) before trusting it, rather than writing a possibly-bogus number -
# which would also throw a false trend arrow at anyone looking at it.
PRICE_JUMP_ABS_THRESHOLD = 0.30   # dollars
PRICE_JUMP_PCT_THRESHOLD = 0.08   # 8%
MAX_RECHECK_ATTEMPTS = 2
RECHECK_DELAY_RANGE = (2.0, 4.0)  # random delay in seconds between rechecks, be polite to Costco's endpoint

def format_price(v) -> float | None:
    """Format a raw price string into a float rounded to 2 decimals, or None if invalid."""
    if v is None or str(v).strip().lower() in ("", "n/a"):
        return None
    try:
        val = float(str(v).replace('$', '').strip())
        return round(val, 2)
    except ValueError:
        return None


def create_session() -> requests.Session:
    session = requests.Session()
    retries = Retry(
        total=3,
        backoff_factor=2,
        status_forcelist=[500, 502, 503, 504],
        allowed_methods=["GET"]
    )
    session.mount('https://', HTTPAdapter(max_retries=retries))
    return session


def get_warehouse_id(url: str) -> str:
    """Extracts warehouse ID from either /warehouse-locations/name-123.html or /w/-/st/name/123"""
    match = re.search(r'(\d+)(?:\.html|/?)$', url)
    if match:
        return match.group(1)
    # Fallback parsing
    return url.rstrip('/').split('/')[-1].replace('.html', '').replace('warehouseid=', '')


def print_lowest_prices(prices: dict) -> None:
    for timestamp, states_data in prices.items():
        lowest: dict[str, tuple[float, list[str]]] = {
            "Regular": (float('inf'), []),
            "Premium": (float('inf'), []),
        }

        for state, cities in states_data.items():
            for city, gas_prices in cities.items():
                for idx, gas_type in enumerate(["Regular", "Premium"]):
                    price = gas_prices[idx]
                    if price is None:
                        continue
                    cur_low, cur_cities = lowest[gas_type]
                    if price < cur_low:
                        lowest[gas_type] = (price, [f"{city} ({state})"])
                    elif price == cur_low:
                        cur_cities.append(f"{city} ({state})")

        for gas_type, (price, cities) in lowest.items():
            if price != float('inf'):
                print(f"Lowest {gas_type} price: {', '.join(cities)} @ ${price:.2f} as of {timestamp}")
            else:
                print(f"No {gas_type} prices available for {timestamp}.")


def validate_snapshot(fetched_prices: dict, locations: dict) -> tuple[bool, str]:
    """Sanity-checks a freshly-fetched price snapshot against the location
    list it was fetched from, before it's allowed to be saved.

    Returns (is_valid, reason). A run can pass the circuit breakers in
    get_gas_prices_ajax (so nothing gets deleted from the store file) and
    still be a bad, sparse snapshot - e.g. Costco rate-limits partway
    through and only 40 of 573 stores return a price. This catches that
    case and gives the caller a clear reason to refuse the save.
    """
    expected_states = len(locations)
    actual_states = len(fetched_prices)

    expected_stores = sum(len(cities) for cities in locations.values())
    actual_stores = sum(len(cities) for cities in fetched_prices.values())

    if expected_states == 0:
        return True, "no expected states to compare against"

    state_coverage = actual_states / expected_states
    store_coverage = (actual_stores / expected_stores) if expected_stores else 0

    if state_coverage < SNAPSHOT_STATE_COVERAGE_THRESHOLD:
        return False, (
            f"only {actual_states}/{expected_states} states ({state_coverage:.0%}) "
            f"returned any price data - below the {SNAPSHOT_STATE_COVERAGE_THRESHOLD:.0%} threshold"
        )

    if store_coverage < SNAPSHOT_STORE_COVERAGE_THRESHOLD:
        return False, (
            f"only {actual_stores}/{expected_stores} stores ({store_coverage:.0%}) "
            f"returned price data - below the {SNAPSHOT_STORE_COVERAGE_THRESHOLD:.0%} threshold"
        )

    return True, f"{actual_states}/{expected_states} states, {actual_stores}/{expected_stores} stores"


def find_trend_baseline(history: dict, current_timestamp_str: str) -> tuple[dict, str | None]:
    """Looks back through `history` (the full {timestamp: {state: {city: prices}}}
    log, NOT yet including the current run) for the snapshot closest to
    TREND_LOOKBACK_HOURS before the current run's timestamp.

    If nothing falls within TREND_LOOKBACK_TOLERANCE_HOURS (e.g. right after a
    fresh deploy, before enough history has accumulated), it gracefully falls back
    to the most recent previous run so trend arrows still function.
    """
    try:
        current_dt = datetime.strptime(current_timestamp_str, "%Y-%m-%d %H:%M")
    except ValueError:
        return {}, None

    target_dt = current_dt - timedelta(hours=TREND_LOOKBACK_HOURS)

    best_ts, best_diff = None, None
    latest_ts = None  # Track the most recent run for our fallback

    for ts_str in history:
        try:
            ts_dt = datetime.strptime(ts_str, "%Y-%m-%d %H:%M")
        except ValueError:
            continue

        # Track the absolute most recent previous snapshot
        if latest_ts is None or ts_str > latest_ts:
            if ts_str != current_timestamp_str:
                latest_ts = ts_str

        # Calculate the closest match to our ideal target
        diff = abs((ts_dt - target_dt).total_seconds())
        if best_diff is None or diff < best_diff:
            best_ts, best_diff = ts_str, diff

    # 1. Ideal scenario: We found a match within our tolerance window
    if best_ts is not None and best_diff <= TREND_LOOKBACK_TOLERANCE_HOURS * 3600:
        return history[best_ts], best_ts

    # 2. Fallback: We don't have data going back far enough yet.
    # Use the most recent previous run we DO have!
    if latest_ts is not None:
        return history[latest_ts], latest_ts

    # 3. Absolute fallback: No history exists at all
    return {}, None


def save_data(data: dict, history_path: str, latest_path: str) -> None:
    """Appends the new snapshot to the history file AND overwrites the small
    'latest' file, so the frontend can load a tiny file for the map/sidebar
    instead of the entire (ever-growing) history on every page view."""
    timestamp_str = next(iter(data.keys()), None)
    if not timestamp_str:
        return

    raw_states_data = data[timestamp_str]
    sorted_states_data = {
        str(state): dict(sorted(cities.items()))
        for state, cities in sorted(raw_states_data.items())
        if isinstance(cities, dict)
    }

    # --- 1. Load existing history (needed to append the new snapshot AND to
    # find a trend baseline further back than "just the previous run") ---
    save_prices = {}
    if os.path.exists(history_path) and os.path.getsize(history_path) > 0:
        try:
            with open(history_path, 'r', encoding='utf-8') as json_file:
                save_prices = json.load(json_file)
        except json.JSONDecodeError as e:
            print(f"⚠️ ERROR: {history_path} contains invalid JSON ({e}).")
            print("Skipping save to prevent deleting historical data.")
            return
        except Exception as e:
            print(f"⚠️ ERROR reading {history_path}: {e}")
            return

    # --- 2. Find a trend baseline ~TREND_LOOKBACK_HOURS behind this run,
    # instead of just carrying forward the immediately-previous run's prices. ---
    previous_prices, previous_timestamp = find_trend_baseline(save_prices, timestamp_str)

    # --- 3. Append the new snapshot to history and write it back ---
    save_prices[timestamp_str] = sorted_states_data
    write_pretty_top_level(save_prices, history_path)

    # --- 4. Overwrite the latest-snapshot file ---
    latest_payload = {
        "timestamp": timestamp_str,
        "prices": sorted_states_data,
        "previous": previous_prices,
        "previous_timestamp": previous_timestamp,
    }
    with open(latest_path, 'w', encoding='utf-8') as f:
        json.dump(latest_payload, f, separators=(',', ':'))

    print(f"Saved latest snapshot -> {latest_path} | appended history -> {history_path}")

def write_pretty_top_level(data: dict, file_path: str) -> None:
    """Writes JSON with one line per top-level key, compact nested content."""
    with open(file_path, "w", encoding='utf-8') as fp:
        fp.write("{\n")
        items = list(data.items())
        for i, (key, value) in enumerate(items):
            compact_value = json.dumps(value, separators=(',', ':'))
            comma = "," if i < len(items) - 1 else ""
            fp.write(f'  {json.dumps(key)}: {compact_value}{comma}\n')
        fp.write("}\n")


def load_store_locations(file_path: str) -> dict | None:
    try:
        with open(file_path, 'r', encoding='utf-8') as json_file:
            return json.load(json_file)
    except FileNotFoundError:
        return None
    except json.JSONDecodeError:
        return None


def remove_location_from_file(filepath: str | None, state: str, city: str) -> None:
    """Opens the source JSON file, deletes the failing city, and resaves it."""
    if not filepath or not os.path.exists(filepath):
        return
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)

        if state in data and city in data[state]:
            del data[state][city]
            print(f"--> Removed {city}, {state} from {filepath}")
            if not data[state]:
                del data[state]

        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=4)
    except Exception as e:
        print(f"Failed to remove {city} from {filepath}: {e}")


def extract_store_metadata(html_content: str) -> dict | None:
    """Extracts coordinates, address, and checks for gas from hidden JSON-LD script."""
    soup = BeautifulSoup(html_content, 'html.parser')
    scripts = soup.find_all('script', type='application/ld+json')

    for script in scripts:
        script_content = script.string
        if not script_content:
            continue
        try:
            data = json.loads(script_content)

            if data.get('@type') == 'LocalBusiness':
                lat = float(data['geo']['latitude'])
                lng = float(data['geo']['longitude'])

                addr_obj = data.get('address', {})
                address = f"{addr_obj.get('streetAddress')}, {addr_obj.get('addressLocality')}, {addr_obj.get('addressRegion')} {addr_obj.get('postalCode')}"

                has_gas = False
                departments = data.get('department', [])
                if isinstance(departments, list):
                    for dept in departments:
                        if dept.get('@type') == 'GasStation' or dept.get('name') == 'Gas Station':
                            has_gas = True
                            break
                elif isinstance(departments, dict):
                    if departments.get('@type') == 'GasStation' or departments.get('name') == 'Gas Station':
                        has_gas = True

                return {"lat": lat, "lng": lng, "address": address, "has_gas": has_gas}
        except (json.JSONDecodeError, KeyError, ValueError, TypeError):
            continue

    return None


def enrich_store_list(state_urls: dict) -> dict:
    enriched_data = {}
    session = create_session()

    # Changed parameter names to avoid shadowing the loop below
    def fetch_single_store(target_state, target_city, target_url):
        try:
            resp = session.get(target_url, headers={'User-Agent': random.choice(USER_AGENTS)}, timeout=10)
            resp.raise_for_status()
            metadata = extract_store_metadata(resp.text)
            # No parentheses!
            return target_state, target_city, target_url, metadata
        except (requests.exceptions.RequestException, ValueError, KeyError):
            return target_state, target_city, target_url, None

    print("Fetching exact store metadata (Coordinates & Addresses)...")

    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = []
        for state, cities in state_urls.items():
            enriched_data[state] = {}
            for city, url in cities.items():
                futures.append(executor.submit(fetch_single_store, state, city, url))

        for future in as_completed(futures):
            # Renamed these variables so they don't shadow the 'state' and 'city' loops above
            res_state, res_city, res_url, meta = future.result()

            if meta and meta["has_gas"]:
                wh_id = get_warehouse_id(res_url)
                enriched_data[res_state][res_city] = {
                    "url": res_url,
                    "warehouse_id": wh_id,
                    "lat": meta["lat"],
                    "lng": meta["lng"],
                    "address": meta["address"]
                }
                print(f"Added {res_city}, {res_state} (ID: {wh_id})")
            elif meta and not meta["has_gas"]:
                print(f"Skipping {res_city}, {res_state} - No Gas Station.")

    return {k: v for k, v in enriched_data.items() if v}


def is_suspicious_jump(new_price: float | None, last_price: float | None) -> bool:
    """True if new_price moved far enough from last_price to warrant a
    re-check before trusting it. Either threshold alone is enough to flag -
    a small absolute move on a cheap tank of gas and a large dollar move on
    an expensive one should both be catchable."""
    if new_price is None or last_price is None:
        return False
    diff = abs(new_price - last_price)
    if diff == 0:
        return False
    pct = (diff / last_price) if last_price else float('inf')
    return diff >= PRICE_JUMP_ABS_THRESHOLD or pct >= PRICE_JUMP_PCT_THRESHOLD


def _prices_match(a: float | None, b: float | None, tol: float = 0.01) -> bool:
    if a is None or b is None:
        return a is None and b is None
    return abs(a - b) < tol


def confirm_or_revert_price(state: str, city: str, reg: float | None, prem: float | None,
                             last_reg: float | None, last_prem: float | None,
                             refetch_fn) -> tuple[float | None, float | None, bool]:
    """Called when a freshly-fetched price looks like a suspiciously big jump
    vs. the last saved price. Re-fetches (with a short randomized delay so
    we're not hammering Costco back-to-back) up to MAX_RECHECK_ATTEMPTS times
    to figure out, independently per gas grade, whether the jump was real or
    a one-off glitch.

    Returns (final_reg, final_prem, unconfirmed) where unconfirmed is True if
    at least one grade still couldn't be resolved either way after retries -
    in that case the freshest fetched value is kept (not the stale old one),
    just flagged for visibility.
    """
    reg_suspicious = is_suspicious_jump(reg, last_reg)
    prem_suspicious = is_suspicious_jump(prem, last_prem)

    details = []
    if reg_suspicious:
        details.append(f"reg {last_reg}->{reg}")
    if prem_suspicious:
        details.append(f"prem {last_prem}->{prem}")
    print(f"  ⚠ Suspicious jump for {city}, {state}: {', '.join(details)}. Re-checking...")

    final_reg, final_prem = reg, prem

    for attempt in range(MAX_RECHECK_ATTEMPTS):
        time.sleep(random.uniform(*RECHECK_DELAY_RANGE))
        recheck = refetch_fn()
        if recheck is None:
            continue
        recheck_reg, recheck_prem = recheck

        if reg_suspicious:
            if _prices_match(recheck_reg, reg):
                reg_suspicious = False  # confirmed - it really moved
            elif _prices_match(recheck_reg, last_reg):
                final_reg = last_reg  # original fetch was the glitch
                reg_suspicious = False

        if prem_suspicious:
            if _prices_match(recheck_prem, prem):
                prem_suspicious = False
            elif _prices_match(recheck_prem, last_prem):
                final_prem = last_prem
                prem_suspicious = False

        if not reg_suspicious and not prem_suspicious:
            break

    unconfirmed = reg_suspicious or prem_suspicious
    if unconfirmed:
        print(f"  ⚠ {city}, {state}: couldn't confirm after {MAX_RECHECK_ATTEMPTS} recheck(s) - "
              f"keeping most recent fetch (reg={final_reg}, prem={final_prem}), flagging as unconfirmed")
    else:
        print(f"  ✓ Resolved {city}, {state}: reg={final_reg}, prem={final_prem}")

    return final_reg, final_prem, unconfirmed


def load_latest_prices(latest_path: str) -> dict:
    """Loads just the {state: {city: [reg, prem]}} prices out of an existing
    *_latest.json, used as the baseline for the jump-confirmation check.
    Returns {} if the file doesn't exist yet or is unreadable - in that case
    the check simply has nothing to compare against and skips (no baseline,
    no false positives on the very first run)."""
    if not os.path.exists(latest_path):
        return {}
    try:
        with open(latest_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data.get('prices', {}) if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def get_gas_prices_ajax(locations: dict, source_filepath: str | None = None,
                         last_known_prices: dict | None = None) -> dict:
    """Concurrently fetches gas prices from Costco's AJAX API."""
    fetched_prices = {}
    session = create_session()
    last_known_prices = last_known_prices or {}

    def fetch_price(target_state, target_city, target_info):
        # Handle backwards compatibility if location file is in the old string URL format
        wh_id = target_info.get("warehouse_id") if isinstance(target_info, dict) else get_warehouse_id(target_info)

        ajax_url = f"https://www.costco.com/AjaxGetGasPricesService?warehouseid={wh_id}"

        def attempt_fetch():
            for attempt in range(MAX_FETCH_ATTEMPTS):
                try:
                    time.sleep(1 + attempt)  # Delay to respect rate limits
                    resp = session.get(ajax_url, headers={'User-Agent': random.choice(USER_AGENTS)}, timeout=15)
                    resp.raise_for_status()

                    raw_data = resp.json()
                    if not raw_data:
                        raise ValueError("Empty response")

                    inner_data = next(iter(raw_data.values()))
                    normalized = {k.lower(): v for k, v in inner_data.items()}

                    reg = format_price(normalized.get('regular'))
                    prem = format_price(normalized.get('premium'))

                    if reg is not None or prem is not None:
                        return reg, prem

                except (requests.exceptions.RequestException, json.JSONDecodeError, ValueError, KeyError):
                    pass
            return None

        result = attempt_fetch()
        if result is None:
            return target_state, target_city, None, False

        reg, prem = result
        last = last_known_prices.get(target_state, {}).get(target_city)
        last_reg, last_prem = (last[0], last[1]) if last else (None, None)

        flagged = False
        if is_suspicious_jump(reg, last_reg) or is_suspicious_jump(prem, last_prem):
            reg, prem, flagged = confirm_or_revert_price(
                target_state, target_city, reg, prem, last_reg, last_prem, attempt_fetch
            )

        return target_state, target_city, [reg, prem], flagged

    print("Fetching live gas prices...")
    total_stores = 0
    failed_stores: list[tuple[str, str]] = []
    unconfirmed_jumps: list[tuple[str, str]] = []

    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = []
        for state, cities in locations.items():
            fetched_prices[state] = {}
            for city, info in cities.items():
                total_stores += 1
                futures.append(executor.submit(fetch_price, state, city, info))

        for future in as_completed(futures):
            state, city, prices, flagged = future.result()
            if prices:
                fetched_prices[state][city] = prices
                if flagged:
                    unconfirmed_jumps.append((state, city))
            else:
                failed_stores.append((state, city))

    if unconfirmed_jumps:
        print(
            f"⚠️  {len(unconfirmed_jumps)} store(s) had a large price jump that couldn't be "
            f"confirmed by a recheck this run. Kept the freshest fetched value for each - "
            f"worth a manual look if the same store keeps showing up here:"
        )
        for state, city in unconfirmed_jumps:
            print(f"  - {city}, {state}")

    # Prices that WERE fetched successfully are always kept - a partial run
    # still produces useful, fresher data for the stores that responded.
    # Deleting stores from the master file is the one *irreversible* action
    # here, so it gets a safety check: only prune individual failures when
    # they look like isolated cases (e.g. one store's gas station closed),
    # not when a large fraction of the whole run failed, which is a much
    # stronger signal of rate limiting/blocking than of mass store closures.
    failure_rate = (len(failed_stores) / total_stores) if total_stores else 0
    circuit_tripped = (
        (len(failed_stores) >= MIN_STORES_FOR_CIRCUIT_BREAKER and failure_rate > FAILURE_RATE_THRESHOLD)
        or (len(failed_stores) >= MIN_STORES_FOR_HIGH_RATE_CHECK and failure_rate >= HIGH_FAILURE_RATE_THRESHOLD)
    )

    if failed_stores:
        if circuit_tripped:
            print(
                f"⚠️  WARNING: {len(failed_stores)}/{total_stores} stores "
                f"({failure_rate:.0%}) returned no price data this run. That failure "
                f"rate usually means Costco rate-limited/blocked the scraper rather "
                f"than that many stores losing their gas station on the same day. "
                f"Leaving '{source_filepath}' untouched - nothing will be removed. "
                f"Retry the run later; investigate if this keeps happening."
            )
            for state, city in failed_stores:
                print(f"  - no data (left in place): {city}, {state}")
        else:
            for state, city in failed_stores:
                print(f"Removing {city}, {state} - Max retries hit or no gas available.")
                remove_location_from_file(source_filepath, state, city)

    # Clean up empty states
    fetched_prices = {k: v for k, v in fetched_prices.items() if v}
    timestamp = time.strftime("%Y-%m-%d %H:%M", time.localtime())

    return {timestamp: fetched_prices}


def fetch_directory_html(url: str) -> str | None:
    session = create_session()
    headers = {
        'User-Agent': random.choice(USER_AGENTS),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    }
    try:
        response = session.get(url, headers=headers, timeout=15)
        response.raise_for_status()
        return response.text
    except requests.exceptions.RequestException as e:
        print(f"Failed to fetch {url}. Error: {e}")
        return None


def extract_stores_from_html(html_content: str) -> dict:
    """Robust extraction looking for specific URL patterns instead of hardcoded <ul> indices."""
    soup = BeautifulSoup(html_content, 'html.parser')
    store_dict = {}

    links = soup.find_all('a', href=True)
    for link in links:
        url = str(link.get('href', ''))
        if '/warehouse-locations/' in url or '/w/-/' in url:
            name = link.get_text(strip=True)
            if not url.startswith('http'):
                url = f"https://www.costco.com{url}"
            store_dict[name] = url

    return store_dict


def discover_new_stores(states_to_check: list, existing_stores: dict, output_filepath: str) -> dict:
    """Cheap scan of state directories; only enriches stores not already in the master file."""
    existing_urls = {
        info["url"] for cities in existing_stores.values() for info in cities.values()
    }

    new_stores_by_state = {}
    for state in states_to_check:
        print(f"\n--- Checking {state} for new stores ---")
        url = f"https://www.costco.com/sitemaps/warehouses-by-state/{state}"
        html = fetch_directory_html(url)
        if not html:
            continue

        all_stores = extract_stores_from_html(html)
        new_in_state = {
            name: store_url for name, store_url in all_stores.items()
            if store_url not in existing_urls
        }
        if new_in_state:
            print(f"Found {len(new_in_state)} potential new store(s) in {state}.")
            new_stores_by_state[state] = new_in_state

    if not new_stores_by_state:
        print("No new stores found.")
        return existing_stores

    enriched_new = enrich_store_list(new_stores_by_state)  # confirms has_gas, gets coords

    for state, cities in enriched_new.items():
        existing_stores.setdefault(state, {}).update(cities)

    with open(output_filepath, 'w', encoding='utf-8') as f:
        json.dump(existing_stores, f, indent=4)

    total_added = sum(len(c) for c in enriched_new.values())
    print(f"\nAdded {total_added} new store(s) with gas to '{output_filepath}'.")
    return existing_stores


def build_and_save_master_db(states_to_update: list, output_filepath: str):
    master_stores = {}
    for state in states_to_update:
        print(f"\n--- Processing {state} Directory ---")
        url = f"https://www.costco.com/sitemaps/warehouses-by-state/{state}"
        html = fetch_directory_html(url)

        if html:
            standard_stores = extract_stores_from_html(html)
            if standard_stores:
                # This fetches coordinates and prunes locations without gas
                enriched = enrich_store_list({state: standard_stores})
                if state in enriched:
                    master_stores[state] = enriched[state]

    new_total = sum(len(cities) for cities in master_stores.values())

    # Same safety valve as get_gas_prices_ajax: a full rebuild rebuilds
    # us_stores.json from scratch, so a network block/rate-limit here would
    # otherwise silently overwrite a good file with a much smaller one.
    if os.path.exists(output_filepath):
        existing = load_store_locations(output_filepath) or {}
        existing_total = sum(len(cities) for cities in existing.values())
        if existing_total > 0 and new_total < existing_total * (1 - FAILURE_RATE_THRESHOLD):
            drop_pct = 1 - (new_total / existing_total)
            print(
                f"⚠️  WARNING: Rebuild produced {new_total} store(s) vs. {existing_total} "
                f"currently in '{output_filepath}' ({drop_pct:.0%} fewer). That looks like "
                f"fetch failures (rate limiting/blocking) rather than that many stores "
                f"actually closing on the same day. Refusing to overwrite "
                f"'{output_filepath}' - re-run the rebuild later."
            )
            return

    with open(output_filepath, 'w', encoding='utf-8') as f:
        json.dump(master_stores, f, indent=4)
    print(f"\nMaster database '{output_filepath}' updated successfully.")


def process_and_save(locations: dict, source_filepath: str, history_file: str, latest_file: str, label: str) -> bool:
    """Fetches prices for one dataset (local/CA/US), validates the resulting
    snapshot's completeness, and only saves it if it passes. Returns True if
    saved, False if rejected - callers should treat False as a failed run
    (e.g. exit non-zero) so CI doesn't push an incomplete update."""
    prices = get_gas_prices_ajax(locations, source_filepath, load_latest_prices(latest_file))
    timestamp = next(iter(prices))
    fetched = prices[timestamp]

    is_valid, reason = validate_snapshot(fetched, locations)
    if not is_valid:
        print(f"⚠️  REJECTED {label} snapshot ({timestamp}): {reason}")
        print(f"Not saving to {latest_file} / {history_file} - this run's data looks incomplete.")
        return False

    print(f"✅ {label} snapshot looks healthy: {reason}")
    save_data(prices, history_file, latest_file)
    print_lowest_prices(prices)
    return True


def main():
    nearby_stores = load_store_locations('local_stores.json')
    ca_stores = load_store_locations('ca_stores.json')
    us_stores = load_store_locations('us_stores.json')

    if len(sys.argv) > 1:
        run_type = int(sys.argv[1])
        print(f"Automated run detected. Executing Option {run_type}")
    else:
        print("1: Update Local Prices")
        print("2: Update CA Prices")
        print("3: Update US Prices")
        print("4: Update All Prices")
        print("5: FULL REBUILD (Fetch ALL store addresses, coordinates, and prices for the US)")
        try:
            run_type = int(input("Enter choice: "))
        except ValueError:
            print("Invalid input. Exiting.")
            sys.exit(1)

    if run_type == 1 and nearby_stores:
        if not process_and_save(nearby_stores, 'local_stores.json', LOCAL_HISTORY_FILE, LOCAL_LATEST_FILE, "Local"):
            sys.exit(1)

    elif run_type == 2 and ca_stores:
        if not process_and_save(ca_stores, 'ca_stores.json', CA_HISTORY_FILE, CA_LATEST_FILE, "CA"):
            sys.exit(1)

    elif run_type == 3 and us_stores:
        if not process_and_save(us_stores, 'us_stores.json', US_HISTORY_FILE, US_LATEST_FILE, "US"):
            sys.exit(1)

    elif run_type == 4:
        ok = True
        if nearby_stores:
            ok &= process_and_save(nearby_stores, 'local_stores.json', LOCAL_HISTORY_FILE, LOCAL_LATEST_FILE, "Local")
        if ca_stores:
            ok &= process_and_save(ca_stores, 'ca_stores.json', CA_HISTORY_FILE, CA_LATEST_FILE, "CA")
        if us_stores:
            ok &= process_and_save(us_stores, 'us_stores.json', US_HISTORY_FILE, US_LATEST_FILE, "US")
        if not ok:
            sys.exit(1)

    elif run_type == 5:
        target_url = "https://www.costco.com/sitemaps/warehouses-by-state"
        raw_html = fetch_directory_html(target_url)
        if not raw_html:
            print("Failed to fetch the main state directory. Exiting.")
            sys.exit(1)

        soup = BeautifulSoup(raw_html, 'html.parser')
        states_to_scrape = set()
        for link in soup.find_all('a', href=True):
            if "/sitemaps/warehouses-by-state/" in link['href']:
                state_code = str(link.get('href', '')).rstrip('/').split('/')[-1]
                if len(state_code) == 2 and state_code not in EXCLUDED_STATES:
                    states_to_scrape.add(state_code)

        print(f"Found {len(states_to_scrape)} states to process.")
        build_and_save_master_db(list(states_to_scrape), "us_stores.json")
        us_stores = load_store_locations('us_stores.json') or {}
        if not process_and_save(us_stores, 'us_stores.json', US_HISTORY_FILE, US_LATEST_FILE, "US"):
            sys.exit(1)

    elif run_type == 6:
        target_url = "https://www.costco.com/sitemaps/warehouses-by-state"
        raw_html = fetch_directory_html(target_url)
        if not raw_html:
            print("Failed to fetch the main state directory. Exiting.")
            sys.exit(1)
        soup = BeautifulSoup(raw_html, 'html.parser')

        states_to_scrape = set()
        for link in soup.find_all('a', href=True):
            if "/sitemaps/warehouses-by-state/" in link['href']:
                state_code = str(link.get('href', '')).rstrip('/').split('/')[-1]
                if len(state_code) == 2 and state_code not in EXCLUDED_STATES:
                    states_to_scrape.add(state_code)

        us_stores = load_store_locations('us_stores.json') or {}
        discover_new_stores(list(states_to_scrape), us_stores, 'us_stores.json')


if __name__ == '__main__':
    main() 