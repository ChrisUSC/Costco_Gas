from __future__ import annotations

import json
import os
import random
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
]

MAX_FETCH_ATTEMPTS = 5
EXCLUDED_STATES = {"PR"}

# Circuit breakers protecting *_stores.json from mass deletion during rate-limits/outages.
FAILURE_RATE_THRESHOLD = 0.25
MIN_STORES_FOR_CIRCUIT_BREAKER = 10
HIGH_FAILURE_RATE_THRESHOLD = 0.8
MIN_STORES_FOR_HIGH_RATE_CHECK = 3

# Snapshot completeness thresholds required before saving *_latest.json / *_history.json.
SNAPSHOT_STATE_COVERAGE_THRESHOLD = 0.85
SNAPSHOT_STORE_COVERAGE_THRESHOLD = 0.75

LOCAL_HISTORY_FILE, LOCAL_LATEST_FILE = 'local_history.json', 'local_latest.json'
CA_HISTORY_FILE, CA_LATEST_FILE = 'ca_history.json', 'ca_latest.json'
US_HISTORY_FILE, US_LATEST_FILE = 'us_history.json', 'us_latest.json'

# Compare current prices against a snapshot ~72h back so trend arrows reflect meaningful moves.
TREND_LOOKBACK_HOURS = 72

# Price-jump sanity check and multi-sample quorum settings.
PRICE_JUMP_ABS_THRESHOLD = 0.30   # dollars
PRICE_JUMP_PCT_THRESHOLD = 0.08   # 8%
MAX_RECHECK_ATTEMPTS = 5
RECHECK_DELAY_RANGE = (2.0, 4.0)
CONFIRMATION_QUORUM = 3
PRICE_MATCH_TOLERANCE = 0.01

UNCONFIRMED_JUMPS_LOG_FILE = 'unconfirmed_jumps_log.jsonl'
GRADES = ("regular", "premium", "diesel")
STORE_DETAIL_FIELDS = ("phone", "gas_hours", "tz")

DATASETS = {
    1: ("Local", "local_stores.json", LOCAL_HISTORY_FILE, LOCAL_LATEST_FILE),
    2: ("CA", "ca_stores.json", CA_HISTORY_FILE, CA_LATEST_FILE),
    3: ("US", "us_stores.json", US_HISTORY_FILE, US_LATEST_FILE),
}


def format_price(v) -> float | None:
    """Format a raw price string into a float rounded to 2 decimals, or None if invalid."""
    if v is None or str(v).strip().lower() in ("", "n/a"):
        return None
    try:
        return round(float(str(v).replace('$', '').strip()), 2)
    except ValueError:
        return None


def create_session() -> requests.Session:
    session = requests.Session()
    retries = Retry(
        total=3,
        backoff_factor=2,
        status_forcelist=[500, 502, 503, 504],
        allowed_methods=["GET"],
    )
    session.mount('https://', HTTPAdapter(max_retries=retries))
    return session


def _cache_busted_url(base_url: str) -> str:
    """Appends a timestamp+random nonce query param to bypass CDN/edge caching on rechecks."""
    sep = '&' if '?' in base_url else '?'
    nonce = f"{int(time.time() * 1000)}{random.randint(1000, 9999)}"
    return f"{base_url}{sep}_={nonce}"


def get_warehouse_id(url: str) -> str:
    """Extracts warehouse ID from either /warehouse-locations/name-123.html or /w/-/st/name/123."""
    match = re.search(r'(\d+)(?:\.html|/?)$', url)
    if match:
        return match.group(1)
    return url.rstrip('/').split('/')[-1].replace('.html', '').replace('warehouseid=', '')


def _grade_price(prices: list, idx: int) -> float | None:
    """Safely reads prices[idx], returning None for shorter legacy 2-element price lists."""
    return prices[idx] if idx < len(prices) else None


def print_lowest_prices(prices: dict) -> None:
    grade_labels = ("Regular", "Premium", "Diesel")
    for timestamp, states_data in prices.items():
        lowest: dict[str, tuple[float, list[str]]] = {g: (float('inf'), []) for g in grade_labels}

        for state, cities in states_data.items():
            for city, gas_prices in cities.items():
                for idx, gas_type in enumerate(grade_labels):
                    price = _grade_price(gas_prices, idx)
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
    """Verifies that a fetched price snapshot meets state and store coverage thresholds."""
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


def compute_price_deltas(new_prices: dict, last_known_prices: dict) -> dict:
    """Returns a dictionary containing only states and cities whose prices
    differ from last_known_prices."""
    deltas = {}
    for state, cities in sorted(new_prices.items()):
        state_deltas = {}
        for city, price in sorted(cities.items()):
            prev = last_known_prices.get(state, {}).get(city)
            if prev != price:
                state_deltas[city] = price
        if state_deltas:
            deltas[state] = state_deltas
    return deltas


def reconstruct_store_prices_at(history: dict, cutoff_ts: str) -> dict:
    """Reconstructs the active prices across all stores as of cutoff_ts.
    Works seamlessly with both delta-only history and legacy full snapshots."""
    active = {}
    valid_ts = sorted([t for t in history.keys() if t <= cutoff_ts], reverse=True)
    for ts in valid_ts:
        snap = history[ts]
        for state, cities in snap.items():
            if state not in active:
                active[state] = {}
            for city, price in cities.items():
                if city not in active[state]:
                    active[state][city] = price
    return {s: dict(sorted(c.items())) for s, c in sorted(active.items())}


def find_trend_baseline(history: dict, current_timestamp_str: str) -> tuple[dict, str | None]:
    """Returns the store prices in effect TREND_LOOKBACK_HOURS before current_timestamp_str.

    With delta-only history, entries are sparse, so we reconstruct the state "as of" the
    target time instead of picking the nearest entry. If history is shorter than the lookback,
    falls back to the most recent prior snapshot (same as before the delta change)."""
    try:
        current_dt = datetime.strptime(current_timestamp_str, "%Y-%m-%d %H:%M")
    except ValueError:
        return {}, None

    prior = [t for t in history if t < current_timestamp_str]
    if not prior:
        return {}, None

    target_str = (current_dt - timedelta(hours=TREND_LOOKBACK_HOURS)).strftime("%Y-%m-%d %H:%M")
    if any(t <= target_str for t in prior):
        return reconstruct_store_prices_at(history, target_str), target_str

    latest_prior = max(prior)
    return reconstruct_store_prices_at(history, latest_prior), latest_prior


def save_data(data: dict, history_path: str, latest_path: str, delta_mode: bool = False) -> None:
    """Appends snapshot to history_path (delta changes if delta_mode=True, full snapshot if False)
    and writes the compact latest snapshot to latest_path."""
    timestamp_str = next(iter(data.keys()), None)
    if not timestamp_str:
        return

    raw_states_data = data[timestamp_str]
    sorted_states_data = {
        str(state): dict(sorted(cities.items()))
        for state, cities in sorted(raw_states_data.items())
        if isinstance(cities, dict)
    }

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

    previous_prices, previous_timestamp = find_trend_baseline(save_prices, timestamp_str)

    if delta_mode and save_prices:
        current_active = reconstruct_store_prices_at(save_prices, timestamp_str)
        delta_prices = compute_price_deltas(sorted_states_data, current_active)
        if delta_prices:
            save_prices[timestamp_str] = delta_prices
            write_pretty_top_level(save_prices, history_path)
            total_chgs = sum(len(c) for c in delta_prices.values())
            print(f"Appended {total_chgs} store price changes -> {history_path}")
        else:
            print(f"No price changes detected. {history_path} left untouched.")
    else:
        save_prices[timestamp_str] = sorted_states_data
        write_pretty_top_level(save_prices, history_path)
        print(f"Saved initial snapshot -> {history_path}")

    latest_payload = {
        "timestamp": timestamp_str,
        "prices": sorted_states_data,
        "previous": previous_prices,
        "previous_timestamp": previous_timestamp,
    }
    with open(latest_path, 'w', encoding='utf-8') as f:
        json.dump(latest_payload, f, separators=(',', ':'))

    print(f"Saved latest snapshot -> {latest_path}")


def write_pretty_top_level(data: dict, file_path: str) -> None:
    """Writes JSON with one line per top-level key and compact nested content.
    Writes to a temp file and swaps it in, so a crash mid-write can't truncate the real file."""
    tmp_path = f"{file_path}.tmp"
    with open(tmp_path, "w", encoding='utf-8') as fp:
        fp.write("{\n")
        items = list(data.items())
        for i, (key, value) in enumerate(items):
            compact_value = json.dumps(value, separators=(',', ':'))
            comma = "," if i < len(items) - 1 else ""
            fp.write(f'  {json.dumps(key)}: {compact_value}{comma}\n')
        fp.write("}\n")
    os.replace(tmp_path, file_path)


def sort_stores_dict(stores: dict) -> dict:
    """Sorts stores dictionary by state code and city name alphabetically."""
    return {
        state: dict(sorted(cities.items()))
        for state, cities in sorted(stores.items())
    }


def load_store_locations(file_path: str) -> dict | None:
    try:
        with open(file_path, 'r', encoding='utf-8') as json_file:
            return json.load(json_file)
    except (FileNotFoundError, json.JSONDecodeError):
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

        out_data = sort_stores_dict(data) if not filepath.endswith("local_stores.json") else data
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(out_data, f, indent=4)
    except Exception as e:
        print(f"Failed to remove {city} from {filepath}: {e}")


# --- Store hours parsing -----------------------------------------------------
DAY_KEYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
_DAY_ALIASES = {
    "mon": "mon", "monday": "mon", "tue": "tue", "tues": "tue", "tuesday": "tue",
    "wed": "wed", "wednesday": "wed", "thu": "thu", "thur": "thu", "thurs": "thu",
    "thursday": "thu", "fri": "fri", "friday": "fri", "sat": "sat", "saturday": "sat",
    "sun": "sun", "sunday": "sun",
}
_DAY_RE = r"(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*"
_TIME_RE = r"\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?"
_HOURS_LINE_RE = re.compile(
    rf"({_DAY_RE})(?:\s*(?:-|–|to)\s*({_DAY_RE}))?\s*:?\s*"
    rf"(?:({_TIME_RE})\s*(?:-|–|to)\s*({_TIME_RE})|(closed))",
    re.IGNORECASE,
)


def _to_24h(t: str) -> str | None:
    """'6:00 AM' -> '06:00', '8:30 pm' -> '20:30', '10 PM' -> '22:00'."""
    m = re.match(r"(\d{1,2})(?::(\d{2}))?\s*([ap])", t.strip().lower())
    if not m:
        return None
    hour, minute, ap = int(m.group(1)), int(m.group(2) or 0), m.group(3)
    if not (1 <= hour <= 12 and 0 <= minute < 60):
        return None
    hour = hour % 12 + (12 if ap == "p" else 0)
    return f"{hour:02d}:{minute:02d}"


def _expand_days(start: str, end: str | None) -> list[str]:
    s = _DAY_ALIASES.get(start.lower())
    e = _DAY_ALIASES.get((end or start).lower())
    if not s or not e:
        return []
    i, j = DAY_KEYS.index(s), DAY_KEYS.index(e)
    return [DAY_KEYS[(i + k) % 7] for k in range((j - i) % 7 + 1)]


def parse_hours_text(text: str) -> dict | None:
    """Parses visible hours text like 'Mon-Fri: 6:00 AM - 10:00 PM Sat: ...' into a 7-day dict."""
    hours: dict = {}
    for m in _HOURS_LINE_RE.finditer(text or ""):
        start, end, t_open, t_close, closed = m.groups()
        if closed:
            value = None
        else:
            o, c = _to_24h(t_open), _to_24h(t_close)
            if not o or not c:
                continue
            value = [o, c]
        for day in _expand_days(start, end):
            hours[day] = value
    if set(hours) != set(DAY_KEYS):
        return None
    return {d: hours[d] for d in DAY_KEYS}


def _hours_from_opening_spec(spec) -> dict | None:
    """Converts schema.org openingHoursSpecification into our 7-day hours dict."""
    if isinstance(spec, dict):
        spec = [spec]
    if not isinstance(spec, list):
        return None
    hours: dict = {d: None for d in DAY_KEYS}
    found = False
    for item in spec:
        if not isinstance(item, dict):
            continue
        days = item.get("dayOfWeek", [])
        days = [days] if isinstance(days, str) else days
        opens, closes = str(item.get("opens", "")), str(item.get("closes", ""))
        om, cm = re.match(r"(\d{1,2}):(\d{2})", opens), re.match(r"(\d{1,2}):(\d{2})", closes)
        if not om or not cm:
            continue
        window = [f"{int(om.group(1)):02d}:{om.group(2)}", f"{int(cm.group(1)):02d}:{cm.group(2)}"]
        if window == ["00:00", "00:00"]:
            window = None
        for d in days:
            key = _DAY_ALIASES.get(str(d).rsplit("/", 1)[-1].lower())
            if key:
                hours[key] = window
                found = True
    return hours if found else None


def _normalize_departments(ld_data: dict) -> list[dict]:
    departments = ld_data.get("department", [])
    if isinstance(departments, dict):
        return [departments]
    return [d for d in departments if isinstance(d, dict)] if isinstance(departments, list) else []


def extract_gas_hours(html_content: str, ld_data: dict | None = None) -> dict | None:
    """Extracts 7-day gas station hours from JSON-LD or falls back to the visible HTML block."""
    if ld_data:
        for dept in _normalize_departments(ld_data):
            if dept.get("@type") == "GasStation" or dept.get("name") == "Gas Station":
                hours = _hours_from_opening_spec(dept.get("openingHoursSpecification"))
                if hours:
                    return hours

    text = BeautifulSoup(html_content, "html.parser").get_text(" ", strip=True)
    for m in re.finditer(r"Gas Station", text):
        segment = text[m.end(): m.end() + 400]
        cut = re.search(r"Prices shown here|Food Court|Pharmacy|Tire Service|Car Wash|Optical", segment)
        hours = parse_hours_text(segment[: cut.start()] if cut else segment)
        if hours:
            return hours
    return None


def _lookup_timezone(lat: float, lng: float) -> str | None:
    """Returns the IANA timezone name for a coordinate if timezonefinder is installed."""
    try:
        from timezonefinder import TimezoneFinder
    except ImportError:
        return None
    global _TZ_FINDER
    try:
        _TZ_FINDER
    except NameError:
        _TZ_FINDER = TimezoneFinder()
    return _TZ_FINDER.timezone_at(lat=lat, lng=lng)


def extract_store_metadata(html_content: str) -> dict | None:
    """Extracts coordinates, address, phone, gas hours, and timezone from a store page."""
    soup = BeautifulSoup(html_content, 'html.parser')
    for script in soup.find_all('script', type='application/ld+json'):
        if not script.string:
            continue
        try:
            data = json.loads(script.string)
            if data.get('@type') != 'LocalBusiness':
                continue

            lat = float(data['geo']['latitude'])
            lng = float(data['geo']['longitude'])
            addr_obj = data.get('address', {})
            address = (
                f"{addr_obj.get('streetAddress')}, {addr_obj.get('addressLocality')}, "
                f"{addr_obj.get('addressRegion')} {addr_obj.get('postalCode')}"
            )

            has_gas = any(
                d.get('@type') == 'GasStation' or d.get('name') == 'Gas Station'
                for d in _normalize_departments(data)
            )

            meta = {"lat": lat, "lng": lng, "address": address, "has_gas": has_gas}
            if phone := data.get('telephone'):
                meta["phone"] = str(phone).strip()

            gas_hours = extract_gas_hours(html_content, data) if has_gas else None
            if gas_hours and all(h is None for h in gas_hours.values()):
                meta["has_gas"] = False
                gas_hours = None
            if gas_hours:
                meta["gas_hours"] = gas_hours

            if tz := _lookup_timezone(lat, lng):
                meta["tz"] = tz
            return meta
        except (json.JSONDecodeError, KeyError, ValueError, TypeError):
            continue

    return None


def _fetch_store_page_metadata(session: requests.Session, url: str) -> dict | None:
    try:
        resp = session.get(url, headers={'User-Agent': random.choice(USER_AGENTS)}, timeout=10)
        resp.raise_for_status()
        return extract_store_metadata(resp.text)
    except (requests.exceptions.RequestException, ValueError, KeyError):
        return None


def enrich_store_list(state_urls: dict) -> dict:
    enriched_data: dict = {state: {} for state in state_urls}
    session = create_session()

    print("Fetching exact store metadata (Coordinates & Addresses)...")
    with ThreadPoolExecutor(max_workers=10) as executor:
        future_to_store = {
            executor.submit(_fetch_store_page_metadata, session, url): (state, city, url)
            for state, cities in state_urls.items()
            for city, url in cities.items()
        }

        for future in as_completed(future_to_store):
            res_state, res_city, res_url = future_to_store[future]
            meta = future.result()

            if meta and meta["has_gas"]:
                wh_id = get_warehouse_id(res_url)
                entry = {
                    "url": res_url,
                    "warehouse_id": wh_id,
                    "lat": meta["lat"],
                    "lng": meta["lng"],
                    "address": meta["address"],
                }
                for optional in STORE_DETAIL_FIELDS:
                    if optional in meta:
                        entry[optional] = meta[optional]
                enriched_data[res_state][res_city] = entry
                print(f"Added {res_city}, {res_state} (ID: {wh_id})")
            elif meta and not meta["has_gas"]:
                print(f"Skipping {res_city}, {res_state} - No Gas Station.")

    return {k: v for k, v in enriched_data.items() if v}


def is_suspicious_jump(new_price: float | None, last_price: float | None) -> bool:
    """True if new_price moved from last_price by >= PRICE_JUMP_ABS_THRESHOLD or >= PRICE_JUMP_PCT_THRESHOLD."""
    if new_price is None or last_price is None:
        return False
    diff = round(abs(new_price - last_price), 2)
    if diff == 0:
        return False
    pct = (diff / last_price) if last_price else float('inf')
    return diff >= PRICE_JUMP_ABS_THRESHOLD or pct >= PRICE_JUMP_PCT_THRESHOLD


def _prices_match(a: float | None, b: float | None, tol: float = PRICE_MATCH_TOLERANCE) -> bool:
    if a is None or b is None:
        return a is None and b is None
    return abs(a - b) < tol


def _find_quorum(samples: list[float | None], quorum: int = CONFIRMATION_QUORUM) -> tuple[bool, float | None]:
    """Returns (True, winning_value) if any value reaches quorum agreeing samples, else (False, None)."""
    if not samples:
        return False, None
    clusters: list[list[float | None]] = []
    for val in samples:
        for cluster in clusters:
            if _prices_match(cluster[0], val):
                cluster.append(val)
                break
        else:
            clusters.append([val])

    winning = [c for c in clusters if len(c) >= quorum]
    if not winning:
        return False, None
    for val in reversed(samples):
        for cluster in winning:
            if _prices_match(cluster[0], val):
                return True, cluster[0]
    return True, winning[-1][0]


def _quorum_value(samples: list[float | None]) -> float | None:
    """Returns the value that has reached CONFIRMATION_QUORUM agreeing samples (favoring the freshest cluster)."""
    has_quorum, val = _find_quorum(samples)
    return val if has_quorum else None


def confirm_or_revert_price(
    state: str,
    city: str,
    grade_prices: dict[str, float | None],
    last_grade_prices: dict[str, float | None],
    refetch_fn,
    verify_all_changes: bool = False,
    revert_unconfirmed: bool | None = None,
    max_attempts: int = MAX_RECHECK_ATTEMPTS,
    quorum: int = CONFIRMATION_QUORUM,
    initial_delay: bool = True,
) -> tuple[dict[str, float | None], bool]:
    """Re-fetches up to max_attempts times when a price jump looks suspicious or
    when verify_all_changes is enabled, requiring quorum agreeing recheck samples to confirm."""
    if revert_unconfirmed is None:
        revert_unconfirmed = verify_all_changes

    if verify_all_changes:
        suspicious = {
            grade: not _prices_match(grade_prices.get(grade), last_grade_prices.get(grade))
            for grade in GRADES
        }
    else:
        suspicious = {
            grade: is_suspicious_jump(grade_prices.get(grade), last_grade_prices.get(grade))
            for grade in GRADES
        }

    details = [f"{grade} {last_grade_prices.get(grade)}->{grade_prices.get(grade)}"
               for grade in GRADES if suspicious[grade]]
    action_label = "Price change" if verify_all_changes else "Suspicious jump"
    print(f"  ⚠ {action_label} for {city}, {state}: {', '.join(details)}. Re-checking...")

    samples: dict[str, list[float | None]] = {grade: [] for grade in GRADES}
    final_prices = dict(grade_prices)

    for attempt in range(max_attempts):
        if attempt > 0 or initial_delay:
            time.sleep(random.uniform(*RECHECK_DELAY_RANGE))
        recheck_prices = refetch_fn()
        if recheck_prices is None:
            continue

        for grade in GRADES:
            if not suspicious[grade]:
                continue
            samples[grade].append(recheck_prices.get(grade))
            has_quorum, quorum_val = _find_quorum(samples[grade], quorum=quorum)
            if has_quorum:
                final_prices[grade] = quorum_val
                suspicious[grade] = False
            else:
                final_prices[grade] = recheck_prices.get(grade)

        if not any(suspicious.values()):
            break

    unconfirmed = any(suspicious.values())
    if unconfirmed:
        if revert_unconfirmed:
            for grade in GRADES:
                if suspicious[grade]:
                    final_prices[grade] = last_grade_prices.get(grade)
            print(f"  ⚠ {city}, {state}: couldn't confirm after {max_attempts} recheck(s) - "
                  f"reverting to last known ({final_prices}), flagging as unconfirmed "
                  f"[samples: {samples}]")
        else:
            print(f"  ⚠ {city}, {state}: couldn't confirm after {max_attempts} recheck(s) - "
                  f"keeping most recent fetch ({final_prices}), flagging as unconfirmed "
                  f"[samples: {samples}]")
    else:
        print(f"  ✓ Resolved {city}, {state}: {final_prices}")

    return final_prices, unconfirmed


def log_unconfirmed_jumps(records: list[dict], filepath: str = UNCONFIRMED_JUMPS_LOG_FILE) -> None:
    """Appends one JSON line per unconfirmed price jump for diagnostic tracking."""
    if not records:
        return
    try:
        with open(filepath, 'a', encoding='utf-8') as f:
            for record in records:
                f.write(json.dumps(record, separators=(',', ':')) + '\n')
    except OSError as e:
        print(f"⚠️  Couldn't write to unconfirmed-jumps log '{filepath}': {e}")


def summarize_unconfirmed_jumps(filepath: str = UNCONFIRMED_JUMPS_LOG_FILE, top_n: int = 15) -> None:
    """Prints the stores that appear most frequently in the unconfirmed-jumps log."""
    if not os.path.exists(filepath):
        print(f"No unconfirmed-jumps log found at '{filepath}' yet.")
        return

    counts: dict[tuple[str, str], int] = {}
    total = 0
    with open(filepath, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            key = (record.get("state", "?"), record.get("city", "?"))
            counts[key] = counts.get(key, 0) + 1
            total += 1

    if total == 0:
        print(f"'{filepath}' exists but has no valid records yet.")
        return

    print(f"{total} unconfirmed jump(s) logged across {len(counts)} store(s). Top offenders:")
    for (state, city), count in sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[:top_n]:
        print(f"  {count:>3}x  {city}, {state}")


def load_latest_prices(latest_path: str) -> dict:
    """Loads the 'prices' dict from an existing *_latest.json file, or {} if missing/corrupt."""
    if not os.path.exists(latest_path):
        return {}
    try:
        with open(latest_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data.get('prices', {}) if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def get_gas_prices_ajax(
    locations: dict,
    source_filepath: str | None = None,
    last_known_prices: dict | None = None,
    jump_log_filepath: str | None = None,
    dataset_label: str | None = None,
    verify_all_changes: bool = False,
    revert_unconfirmed: bool | None = None,
) -> dict:
    """Concurrently fetches gas prices (regular, premium, diesel) from Costco's AJAX API.
    Uses a two-phase sweep:
      Phase 1: Rapid initial probe across all stores in parallel without artificial delays.
      Phase 2: Targeted confirmation quorum rounds only for stores with detected price changes.
    """
    fetched_prices = {}
    session = create_session()
    last_known_prices = last_known_prices or {}

    def fetch_single_store(target_info):
        wh_id = target_info.get("warehouse_id") if isinstance(target_info, dict) else get_warehouse_id(target_info)
        ajax_url = f"https://www.costco.com/AjaxGetGasPricesService?warehouseid={wh_id}"

        for attempt in range(MAX_FETCH_ATTEMPTS):
            try:
                time.sleep(1 + attempt)
                resp = session.get(
                    _cache_busted_url(ajax_url),
                    headers={
                        'User-Agent': random.choice(USER_AGENTS),
                        'Cache-Control': 'no-cache, no-store',
                        'Pragma': 'no-cache',
                    },
                    timeout=15,
                )
                resp.raise_for_status()

                raw_data = resp.json()
                if not raw_data:
                    raise ValueError("Empty response")

                inner_data = next(iter(raw_data.values()))
                normalized = {k.lower(): v for k, v in inner_data.items()}
                prices_by_grade = {g: format_price(normalized.get(g)) for g in GRADES}

                if any(v is not None for v in prices_by_grade.values()):
                    return prices_by_grade
            except (requests.exceptions.RequestException, json.JSONDecodeError, ValueError, KeyError):
                pass
        return None

    def probe_store(state, city, info):
        res = fetch_single_store(info)
        return state, city, info, res

    print("Fetching live gas prices (Phase 1: sweep)...")
    total_stores = 0
    failed_stores: list[tuple[str, str]] = []
    candidates = []
    unconfirmed_jumps: list[tuple[str, str]] = []
    jump_log_records: list[dict] = []
    run_timestamp = time.strftime("%Y-%m-%d %H:%M", time.localtime())
    phase1_start = time.time()

    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = [
            executor.submit(probe_store, state, city, info)
            for state, cities in locations.items()
            for city, info in cities.items()
        ]
        for future in as_completed(futures):
            state, city, info, result = future.result()
            total_stores += 1
            if result is None:
                failed_stores.append((state, city))
                continue

            last = last_known_prices.get(state, {}).get(city)
            last_grade_prices = {
                grade: _grade_price(last, idx) if last else None
                for idx, grade in enumerate(GRADES)
            }
            has_baseline = last is not None and any(v is not None for v in last_grade_prices.values())
            should_check = False
            if has_baseline:
                if verify_all_changes:
                    should_check = any(not _prices_match(result.get(g), last_grade_prices.get(g)) for g in GRADES)
                else:
                    should_check = any(is_suspicious_jump(result.get(g), last_grade_prices.get(g)) for g in GRADES)

            if should_check:
                candidates.append((state, city, info, result, last_grade_prices))
            else:
                fetched_prices.setdefault(state, {})[city] = [result[g] for g in GRADES]

    if candidates:
        phase1_duration = time.time() - phase1_start
        need_initial_delay = phase1_duration < 5.0
        print(f"\nPhase 2: Verifying {len(candidates)} candidate store(s) with confirmation quorum...")

        def verify_candidate(cand):
            c_state, c_city, c_info, c_raw_result, c_last_grades = cand
            refetch_fn = lambda: fetch_single_store(c_info)
            final_prices, flagged = confirm_or_revert_price(
                c_state,
                c_city,
                c_raw_result,
                c_last_grades,
                refetch_fn,
                verify_all_changes=verify_all_changes,
                revert_unconfirmed=revert_unconfirmed,
                max_attempts=MAX_RECHECK_ATTEMPTS,
                quorum=CONFIRMATION_QUORUM,
                initial_delay=need_initial_delay,
            )
            return c_state, c_city, c_raw_result, c_last_grades, final_prices, flagged

        with ThreadPoolExecutor(max_workers=min(10, len(candidates))) as executor:
            cand_futures = [executor.submit(verify_candidate, c) for c in candidates]
            for future in as_completed(cand_futures):
                c_state, c_city, c_raw_result, c_last_grades, final_prices, flagged = future.result()
                fetched_prices.setdefault(c_state, {})[c_city] = [final_prices[g] for g in GRADES]
                if flagged:
                    unconfirmed_jumps.append((c_state, c_city))
                    jump_detail = {
                        "last_reg": c_last_grades["regular"], "last_prem": c_last_grades["premium"],
                        "last_diesel": c_last_grades["diesel"],
                        "raw_reg": c_raw_result["regular"], "raw_prem": c_raw_result["premium"],
                        "raw_diesel": c_raw_result["diesel"],
                        "final_reg": final_prices["regular"], "final_prem": final_prices["premium"],
                        "final_diesel": final_prices["diesel"],
                    }
                    jump_log_records.append({
                        "timestamp": run_timestamp,
                        "state": c_state,
                        "city": c_city,
                        "dataset": dataset_label,
                        **jump_detail,
                    })

    if unconfirmed_jumps:
        print(
            f"⚠️  {len(unconfirmed_jumps)} store(s) had a large price jump that couldn't be "
            f"confirmed by a recheck this run. Kept the freshest fetched value for each - "
            f"worth a manual look if the same store keeps showing up here:"
        )
        for state, city in unconfirmed_jumps:
            print(f"  - {city}, {state}")

        if jump_log_filepath:
            log_unconfirmed_jumps(jump_log_records, jump_log_filepath)

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

    fetched_prices = {k: v for k, v in fetched_prices.items() if v}
    return {run_timestamp: fetched_prices}


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
    """Extracts {store_name: full_url} from a Costco state warehouse directory page."""
    soup = BeautifulSoup(html_content, 'html.parser')
    store_dict = {}
    for link in soup.find_all('a', href=True):
        url = str(link.get('href', ''))
        if '/warehouse-locations/' in url or '/w/-/' in url:
            name = link.get_text(strip=True)
            if not url.startswith('http'):
                url = f"https://www.costco.com{url}"
            store_dict[name] = url
    return store_dict


def fetch_state_codes() -> list[str]:
    """Fetches Costco's main warehouse-by-state sitemap and returns sorted 2-letter state codes."""
    raw_html = fetch_directory_html("https://www.costco.com/sitemaps/warehouses-by-state")
    if not raw_html:
        print("Failed to fetch the main state directory. Exiting.")
        sys.exit(1)

    soup = BeautifulSoup(raw_html, 'html.parser')
    states = {
        code
        for link in soup.find_all('a', href=True)
        if "/sitemaps/warehouses-by-state/" in link['href']
        and len(code := str(link.get('href', '')).rstrip('/').split('/')[-1]) == 2
        and code not in EXCLUDED_STATES
    }
    return sorted(states)


def discover_new_stores(states_to_check: list, existing_stores: dict, output_filepath: str) -> dict:
    """Scans state directories and enriches only stores not already in existing_stores."""
    existing_urls = {
        info["url"] for cities in existing_stores.values() for info in cities.values()
        if isinstance(info, dict) and "url" in info
    }

    new_stores_by_state = {}
    for state in states_to_check:
        print(f"\n--- Checking {state} for new stores ---")
        html = fetch_directory_html(f"https://www.costco.com/sitemaps/warehouses-by-state/{state}")
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

    enriched_new = enrich_store_list(new_stores_by_state)
    total_added = sum(len(c) for c in enriched_new.values())
    if total_added == 0:
        print("No new stores with gas found.")
        return existing_stores

    for state, cities in enriched_new.items():
        existing_stores.setdefault(state, {}).update(cities)

    sorted_stores = sort_stores_dict(existing_stores)

    with open(output_filepath, 'w', encoding='utf-8') as f:
        json.dump(sorted_stores, f, indent=4)

    print(f"\nAdded {total_added} new store(s) with gas to '{output_filepath}'.")
    return sorted_stores


def build_and_save_master_db(states_to_update: list, output_filepath: str) -> None:
    master_stores = {}
    for state in states_to_update:
        print(f"\n--- Processing {state} Directory ---")
        html = fetch_directory_html(f"https://www.costco.com/sitemaps/warehouses-by-state/{state}")
        if html and (standard_stores := extract_stores_from_html(html)):
            enriched = enrich_store_list({state: standard_stores})
            if state in enriched:
                master_stores[state] = enriched[state]

    new_total = sum(len(cities) for cities in master_stores.values())

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

    sorted_stores = sort_stores_dict(master_stores)

    with open(output_filepath, 'w', encoding='utf-8') as f:
        json.dump(sorted_stores, f, indent=4)
    print(f"\nMaster database '{output_filepath}' updated successfully.")


def refresh_store_details(stores: dict, filepath: str) -> int:
    """Re-fetches each store's page and updates optional detail fields (phone, gas_hours, tz) additively."""
    session = create_session()
    jobs = [(s, c, i) for s, cities in stores.items() for c, i in cities.items() if isinstance(i, dict)]
    legacy = sum(1 for cities in stores.values() for i in cities.values() if not isinstance(i, dict))
    if legacy:
        print(f"Note: {legacy} entr{'y' if legacy == 1 else 'ies'} in '{filepath}' use the old plain-URL format "
              f"and can't be refreshed (no warehouse details stored).")

    changed = failed = 0
    with ThreadPoolExecutor(max_workers=10) as executor:
        future_to_job = {
            executor.submit(_fetch_store_page_metadata, session, info.get("url", "")): (state, city)
            for state, city, info in jobs
        }
        for future in as_completed(future_to_job):
            state, city = future_to_job[future]
            meta = future.result()
            if not meta:
                failed += 1
                continue
            info = stores[state][city]
            for field in STORE_DETAIL_FIELDS:
                if field in meta and info.get(field) != meta[field]:
                    info[field] = meta[field]
                    changed += 1

    print(f"Refreshed details for {len(jobs) - failed}/{len(jobs)} stores in '{filepath}' "
          f"({changed} field(s) changed, {failed} fetch/parse failure(s)).")
    if changed:
        out_stores = sort_stores_dict(stores) if not filepath.endswith("local_stores.json") else stores
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(out_stores, f, indent=4)
    return changed


def process_and_save(
    locations: dict,
    source_filepath: str,
    history_file: str,
    latest_file: str,
    label: str,
    verify_all_changes: bool = True,
) -> bool:
    """Fetches prices for one dataset, validates completeness, and saves if healthy."""
    prices = get_gas_prices_ajax(
        locations,
        source_filepath,
        load_latest_prices(latest_file),
        jump_log_filepath=UNCONFIRMED_JUMPS_LOG_FILE,
        dataset_label=label,
        verify_all_changes=verify_all_changes,
    )
    timestamp = next(iter(prices))
    fetched = prices[timestamp]

    is_valid, reason = validate_snapshot(fetched, locations)
    if not is_valid:
        print(f"⚠️  REJECTED {label} snapshot ({timestamp}): {reason}")
        print(f"Not saving to {latest_file} / {history_file} - this run's data looks incomplete.")
        return False

    print(f"✅ {label} snapshot looks healthy: {reason}")
    save_data(prices, history_file, latest_file, delta_mode=True)
    print_lowest_prices(prices)
    return True


def main() -> None:
    if len(sys.argv) > 1:
        run_type = int(sys.argv[1])
        print(f"Automated run detected. Executing Option {run_type}")
    else:
        print("1: Update Local Prices")
        print("2: Update CA Prices")
        print("3: Update US Prices")
        print("4: Update All Prices")
        print("5: FULL REBUILD (Fetch ALL store addresses, coordinates, and prices for the US)")
        print("6: Discover new stores")
        print("7: Show unconfirmed price-jump summary (which stores flag most often)")
        print("8: Refresh store details (gas hours, phone, timezone) for existing stores")
        try:
            run_type = int(input("Enter choice: "))
        except ValueError:
            print("Invalid input. Exiting.")
            sys.exit(1)

    if run_type in DATASETS:
        label, store_file, hist_file, latest_file = DATASETS[run_type]
        stores = load_store_locations(store_file)
        if stores and not process_and_save(stores, store_file, hist_file, latest_file, label):
            sys.exit(1)

    elif run_type == 4:
        ok = True
        for label, store_file, hist_file, latest_file in DATASETS.values():
            if stores := load_store_locations(store_file):
                ok &= process_and_save(stores, store_file, hist_file, latest_file, label)
        if not ok:
            sys.exit(1)

    elif run_type == 5:
        states_to_scrape = fetch_state_codes()
        print(f"Found {len(states_to_scrape)} states to process.")
        build_and_save_master_db(states_to_scrape, "us_stores.json")

    elif run_type == 6:
        states_to_scrape = fetch_state_codes()
        us_stores = load_store_locations('us_stores.json') or {}
        us_stores = discover_new_stores(states_to_scrape, us_stores, 'us_stores.json')
        refresh_store_details(us_stores, 'us_stores.json')

    elif run_type == 7:
        summarize_unconfirmed_jumps()

    elif run_type == 8:
        for _, path, _, _ in DATASETS.values():
            if stores := load_store_locations(path):
                refresh_store_details(stores, path)
            else:
                print(f"Skipping '{path}': file is missing, empty, or not valid JSON.")


if __name__ == '__main__':
    main()