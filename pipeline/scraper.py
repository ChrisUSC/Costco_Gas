from __future__ import annotations

import json
import os
import random
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from functools import lru_cache
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from paths import CA_STORES_FILE, LOCAL_STORES_FILE, US_STORES_FILE, snapshot_path

USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
]

MAX_FETCH_ATTEMPTS = 5
EXCLUDED_STATES = {"PR"}

# Full rebuild (option 5) refuses to overwrite us_stores.json if it shrinks by more than this.
REBUILD_MAX_DROP = 0.25

# Snapshot completeness thresholds required before saving *_latest.json / *_history.json.
SNAPSHOT_STATE_COVERAGE_THRESHOLD = 0.85
SNAPSHOT_STORE_COVERAGE_THRESHOLD = 0.75

LOCAL_HISTORY_FILE, LOCAL_LATEST_FILE = snapshot_path('local_history.json'), snapshot_path('local_latest.json')
CA_HISTORY_FILE, CA_LATEST_FILE = snapshot_path('ca_history.json'), snapshot_path('ca_latest.json')
US_HISTORY_FILE, US_LATEST_FILE = snapshot_path('us_history.json'), snapshot_path('us_latest.json')

# Snapshot timestamps are Pacific wall-clock time ("YYYY-MM-DD HH:MM"), whatever the
# machine's own time zone is.
SCRAPER_TZ = ZoneInfo("America/Los_Angeles")

# Compare current prices against a snapshot ~72h back so trend arrows reflect meaningful moves.
TREND_LOOKBACK_HOURS = 72

# Price-jump sanity check and multi-sample quorum settings.
PRICE_JUMP_ABS_THRESHOLD = 0.30   # dollars
PRICE_JUMP_PCT_THRESHOLD = 0.08   # 8%
MAX_RECHECK_ATTEMPTS = 5
RECHECK_DELAY_RANGE = (2.0, 4.0)
CONFIRMATION_QUORUM = 3
PRICE_MATCH_TOLERANCE = 0.01

GRADES = ("regular", "premium", "diesel")
STORE_DETAIL_FIELDS = ("phone", "gas_hours", "tz")

DATASETS = {
    1: ("Local", LOCAL_STORES_FILE, LOCAL_HISTORY_FILE, LOCAL_LATEST_FILE),
    2: ("CA", CA_STORES_FILE, CA_HISTORY_FILE, CA_LATEST_FILE),
    3: ("US", US_STORES_FILE, US_HISTORY_FILE, US_LATEST_FILE),
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


def scraper_timestamp(now: datetime | None = None) -> str:
    """Current time as a Pacific 'YYYY-MM-DD HH:MM' string (independent of the TZ env var)."""
    now = now or datetime.now(SCRAPER_TZ)
    return now.astimezone(SCRAPER_TZ).strftime("%Y-%m-%d %H:%M")


def carry_forward_missing(fetched: dict, last_known: dict, locations: dict) -> tuple[dict, int]:
    """Fills in stores that returned no price this run with their last known price, so a
    one-off fetch failure doesn't drop the station from *_latest.json (and from the map).
    Only stores still in `locations` are carried forward. Returns (merged, carried_count)."""
    merged = {state: dict(cities) for state, cities in fetched.items()}
    carried = 0
    for state, cities in locations.items():
        for city in cities:
            if city in merged.get(state, {}):
                continue
            prev = last_known.get(state, {}).get(city)
            if prev is not None:
                merged.setdefault(state, {})[city] = prev
                carried += 1
    return {s: dict(sorted(c.items())) for s, c in sorted(merged.items()) if c}, carried


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


def load_history(history_path: str) -> dict | None:
    """Reads a history file. Returns {} if it is missing or empty, None if it can't be read
    (callers must then stop rather than seed a fresh history over the real one)."""
    if not os.path.exists(history_path) or os.path.getsize(history_path) == 0:
        return {}
    try:
        with open(history_path, 'r', encoding='utf-8') as json_file:
            return json.load(json_file)
    except (ValueError, OSError) as e:  # ValueError covers bad JSON and bad UTF-8
        problem = "contains invalid JSON" if isinstance(e, ValueError) else "couldn't be read"
        print(f"⚠️ ERROR: {history_path} {problem} ({e}).")
        return None


def save_data(
    data: dict,
    history_path: str,
    latest_path: str,
    write_latest_only_on_change: bool = False,
) -> bool:
    """Appends only changed store prices to history_path (seeding a full snapshot if the
    history is empty) and writes the compact latest snapshot to latest_path.

    With write_latest_only_on_change, latest_path is left alone when no price changed (and
    it already exists), so its "timestamp" means "last change" rather than "last check".

    Returns False if nothing could be saved because the existing history is unreadable,
    True otherwise (including a deliberately skipped run, see below)."""
    timestamp_str = next(iter(data.keys()), None)
    if not timestamp_str:
        return True

    raw_states_data = data[timestamp_str]
    sorted_states_data = {
        str(state): dict(sorted(cities.items()))
        for state, cities in sorted(raw_states_data.items())
        if isinstance(cities, dict)
    }

    save_prices = load_history(history_path)
    if save_prices is None:
        print("Skipping save to prevent deleting historical data.")
        return False

    # Timestamps are Pacific wall-clock time, so when clocks fall back the 01:xx hour repeats
    # and a new timestamp can sort at or before entries already saved. Appending it would
    # compute deltas against the wrong state, so skip this run (at most ~1 hour, once a year).
    if save_prices and timestamp_str <= max(save_prices):
        print(f"⚠️ Timestamp {timestamp_str} is not after the last history entry "
              f"({max(save_prices)}), likely the daylight-saving fall-back hour. "
              f"Skipping this run's save.")
        return True

    previous_prices, previous_timestamp = find_trend_baseline(save_prices, timestamp_str)

    changed = True
    if save_prices:
        current_active = reconstruct_store_prices_at(save_prices, timestamp_str)
        delta_prices = compute_price_deltas(sorted_states_data, current_active)
        if delta_prices:
            save_prices[timestamp_str] = delta_prices
            write_pretty_top_level(save_prices, history_path)
            total_chgs = sum(len(c) for c in delta_prices.values())
            print(f"Appended {total_chgs} store price changes -> {history_path}")
        else:
            changed = False
            print(f"No price changes detected. {history_path} left untouched.")
    else:
        save_prices[timestamp_str] = sorted_states_data
        write_pretty_top_level(save_prices, history_path)
        print(f"Saved initial snapshot -> {history_path}")

    if write_latest_only_on_change and not changed and os.path.exists(latest_path):
        print(f"No changes; {latest_path} left untouched.")
        return True

    latest_payload = {
        "timestamp": timestamp_str,
        "prices": sorted_states_data,
        "previous": previous_prices,
        "previous_timestamp": previous_timestamp,
    }
    atomic_write_json(latest_path, latest_payload, separators=(',', ':'))

    print(f"Saved latest snapshot -> {latest_path}")
    return True


def atomic_write_json(file_path: str, data: dict, indent: int | None = None, separators: tuple[str, str] | None = None) -> None:
    """Safely writes JSON data to a temporary file and atomically replaces the destination."""
    os.makedirs(os.path.dirname(file_path) or ".", exist_ok=True)
    tmp_path = f"{file_path}.tmp"
    with open(tmp_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=indent, separators=separators)
    os.replace(tmp_path, file_path)


def write_pretty_top_level(data: dict, file_path: str) -> None:
    """Writes JSON with one line per top-level key and compact nested content.
    Writes to a temp file and swaps it in, so a crash mid-write can't truncate the real file."""
    os.makedirs(os.path.dirname(file_path) or ".", exist_ok=True)
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


@lru_cache(maxsize=1)
def _tz_finder():
    """One shared TimezoneFinder (slow to build), or None if timezonefinder isn't installed."""
    try:
        from timezonefinder import TimezoneFinder
    except ImportError:
        return None
    return TimezoneFinder()


def _lookup_timezone(lat: float, lng: float) -> str | None:
    """Returns the IANA timezone name for a coordinate if timezonefinder is installed."""
    finder = _tz_finder()
    return finder.timezone_at(lat=lat, lng=lng) if finder else None


def _ld_json_objects(raw) -> list[dict]:
    """Flattens a parsed JSON-LD block (an object, a list, or an object with @graph) into dicts."""
    if isinstance(raw, list):
        return [obj for item in raw for obj in _ld_json_objects(item)]
    if not isinstance(raw, dict):
        return []
    if isinstance(raw.get('@graph'), list):
        return [raw] + _ld_json_objects(raw['@graph'])
    return [raw]


def _iter_local_business_ld(soup: BeautifulSoup):
    for script in soup.find_all('script', type='application/ld+json'):
        if not script.string:
            continue
        try:
            raw = json.loads(script.string)
        except json.JSONDecodeError:
            continue
        for obj in _ld_json_objects(raw):
            if obj.get('@type') == 'LocalBusiness':
                yield obj


def extract_store_metadata(html_content: str) -> dict | None:
    """Extracts coordinates, address, phone, gas hours, and timezone from a store page."""
    soup = BeautifulSoup(html_content, 'html.parser')
    for data in _iter_local_business_ld(soup):
        try:

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
        except (KeyError, ValueError, TypeError, AttributeError):
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
    last_known_prices: dict | None = None,
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
    run_timestamp = scraper_timestamp()
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
            return c_state, c_city, final_prices, flagged

        with ThreadPoolExecutor(max_workers=min(10, len(candidates))) as executor:
            cand_futures = [executor.submit(verify_candidate, c) for c in candidates]
            for future in as_completed(cand_futures):
                c_state, c_city, final_prices, flagged = future.result()
                fetched_prices.setdefault(c_state, {})[c_city] = [final_prices[g] for g in GRADES]
                if flagged:
                    unconfirmed_jumps.append((c_state, c_city))

    if unconfirmed_jumps:
        reverted = verify_all_changes if revert_unconfirmed is None else revert_unconfirmed
        outcome = ("Reverted each to its last known price" if reverted
                   else "Kept the freshest fetched value for each")
        print(
            f"⚠️  {len(unconfirmed_jumps)} store(s) had a price change that couldn't be "
            f"confirmed by a recheck this run. {outcome} - worth a manual look if the "
            f"same store keeps showing up here:"
        )
        for state, city in unconfirmed_jumps:
            print(f"  - {city}, {state}")

    if failed_stores:
        print(f"⚠️  {len(failed_stores)}/{total_stores} store(s) returned no price data this run:")
        for state, city in sorted(failed_stores):
            print(f"  - {city}, {state}")

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
    atomic_write_json(output_filepath, sorted_stores, indent=4)

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
        if existing_total > 0 and new_total < existing_total * (1 - REBUILD_MAX_DROP):
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
    atomic_write_json(output_filepath, sorted_stores, indent=4)
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
        # Only dict-format lists (us_stores.json) can change here; keep them sorted.
        atomic_write_json(filepath, sort_stores_dict(stores), indent=4)
    return changed


def process_and_save(
    locations: dict,
    history_file: str,
    latest_file: str,
    label: str,
    verify_all_changes: bool = True,
    last_known: dict | None = None,
    write_latest_only_on_change: bool = False,
    fetch_prices=None,
) -> bool:
    """Fetches prices for one dataset, validates completeness, and saves if healthy.

    last_known defaults to the prices in latest_file; fetch_prices defaults to
    get_gas_prices_ajax (callers and tests can substitute their own)."""
    if last_known is None:
        last_known = load_latest_prices(latest_file)
    prices = (fetch_prices or get_gas_prices_ajax)(
        locations,
        last_known,
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
    merged, carried = carry_forward_missing(fetched, last_known, locations)
    if carried:
        print(f"Carried forward the last known price for {carried} store(s) that returned none this run.")
    prices = {timestamp: merged}
    if not save_data(prices, history_file, latest_file, write_latest_only_on_change):
        return False
    print_lowest_prices(prices)
    return True


MENU_OPTIONS = {1, 2, 3, 4, 5, 6, 8}


def main() -> None:
    if len(sys.argv) > 1:
        try:
            run_type = int(sys.argv[1])
        except ValueError:
            print(f"Invalid option '{sys.argv[1]}'. Expected one of {sorted(MENU_OPTIONS)}.")
            sys.exit(1)
        print(f"Automated run detected. Executing Option {run_type}")
    else:
        print("1: Update Local Prices")
        print("2: Update CA Prices")
        print("3: Update US Prices")
        print("4: Update All Prices")
        print("5: FULL REBUILD (Fetch ALL store addresses, coordinates, and prices for the US)")
        print("6: Discover new stores")
        print("8: Refresh store details (gas hours, phone, timezone) for existing stores")
        try:
            run_type = int(input("Enter choice: "))
        except ValueError:
            print("Invalid input. Exiting.")
            sys.exit(1)

    if run_type not in MENU_OPTIONS:
        print(f"Unknown option {run_type}. Expected one of {sorted(MENU_OPTIONS)}.")
        sys.exit(1)

    if run_type in DATASETS:
        label, store_file, hist_file, latest_file = DATASETS[run_type]
        stores = load_store_locations(store_file)
        if not stores:
            print(f"Couldn't load stores from '{store_file}': file is missing, empty, or not valid JSON.")
            sys.exit(1)
        if not process_and_save(stores, hist_file, latest_file, label):
            sys.exit(1)

    elif run_type == 4:
        ok = True
        for label, store_file, hist_file, latest_file in DATASETS.values():
            if stores := load_store_locations(store_file):
                ok &= process_and_save(stores, hist_file, latest_file, label)
        if not ok:
            sys.exit(1)

    elif run_type == 5:
        states_to_scrape = fetch_state_codes()
        print(f"Found {len(states_to_scrape)} states to process.")
        build_and_save_master_db(states_to_scrape, US_STORES_FILE)

    elif run_type == 6:
        states_to_scrape = fetch_state_codes()
        us_stores = load_store_locations(US_STORES_FILE) or {}
        us_stores = discover_new_stores(states_to_scrape, us_stores, US_STORES_FILE)
        refresh_store_details(us_stores, US_STORES_FILE)

    elif run_type == 8:
        for _, path, _, _ in DATASETS.values():
            if stores := load_store_locations(path):
                refresh_store_details(stores, path)
            else:
                print(f"Skipping '{path}': file is missing, empty, or not valid JSON.")


if __name__ == '__main__':
    main()
