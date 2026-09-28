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
MAX_RECHECK_ATTEMPTS = 3
RECHECK_DELAY_RANGE = (4.0, 8.0)  # random delay in seconds between rechecks, be polite to Costco's endpoint

# A single recheck matching the new (or old) value used to be enough to
# "confirm" it. That's weak evidence on its own - especially since Costco's
# AJAX endpoint appears to sit behind caching, so a recheck can just return
# the exact same (possibly stale/wrong) cached response as the original
# fetch, "confirming" a bad price with zero independent information. Now we
# require CONFIRMATION_QUORUM independently-fetched samples (cache-busted,
# see _cache_busted_url below) to agree with each other before trusting a
# value at all.
CONFIRMATION_QUORUM = 2
PRICE_MATCH_TOLERANCE = 0.01

# --- Long-term log of unconfirmed jumps ---
# get_gas_prices_ajax prints unconfirmed jumps for the current run, but that
# output isn't kept anywhere - there's no way to tell "this store flags every
# other run" from "this happened once, ever." This appends one JSON record
# per unconfirmed jump to a flat file, so patterns become visible over time.
# JSON Lines (one JSON object per line) is used instead of one big JSON array
# so appending an entry never requires reading/re-writing the whole file.
UNCONFIRMED_JUMPS_LOG_FILE = 'unconfirmed_jumps_log.jsonl'
GRADES = ("regular", "premium", "diesel")

# Optional per-store details scraped from each store page and kept in *_stores.json.
STORE_DETAIL_FIELDS = ("phone", "gas_hours", "tz")

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


def _cache_busted_url(base_url: str) -> str:
    """Appends a random+timestamp query param so a re-fetch can't be silently
    served the same cached response as a prior fetch to the same URL. Costco's
    AJAX endpoint appears to sit behind edge/CDN caching, which was making
    "recheck" calls just replay the original (possibly wrong) cached price
    instead of independently verifying it."""
    sep = '&' if '?' in base_url else '?'
    nonce = f"{int(time.time() * 1000)}{random.randint(1000, 9999)}"
    return f"{base_url}{sep}_={nonce}"


def get_warehouse_id(url: str) -> str:
    """Extracts warehouse ID from either /warehouse-locations/name-123.html or /w/-/st/name/123"""
    match = re.search(r'(\d+)(?:\.html|/?)$', url)
    if match:
        return match.group(1)
    # Fallback parsing
    return url.rstrip('/').split('/')[-1].replace('.html', '').replace('warehouseid=', '')


def _grade_price(prices: list, idx: int) -> float | None:
    """Safely reads prices[idx], treating a too-short list (old 2-element
    [reg, prem] entries saved before diesel was tracked) as None instead of
    raising IndexError."""
    return prices[idx] if idx < len(prices) else None


def print_lowest_prices(prices: dict) -> None:
    for timestamp, states_data in prices.items():
        lowest: dict[str, tuple[float, list[str]]] = {
            "Regular": (float('inf'), []),
            "Premium": (float('inf'), []),
            "Diesel": (float('inf'), []),
        }

        for state, cities in states_data.items():
            for city, gas_prices in cities.items():
                for idx, gas_type in enumerate(["Regular", "Premium", "Diesel"]):
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


# --- Store hours parsing -----------------------------------------------------
# Hours change rarely, so they live in the static *_stores.json files (not in
# the price snapshots). Format: {"mon": ["06:00", "22:00"], ..., "sun": None}
# where None means closed that day. A missing "gas_hours" key means "unknown".
DAY_KEYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
_DAY_ALIASES = {
    "mon": "mon", "monday": "mon", "tue": "tue", "tues": "tue", "tuesday": "tue",
    "wed": "wed", "wednesday": "wed", "thu": "thu", "thur": "thu", "thurs": "thu",
    "thursday": "thu", "fri": "fri", "friday": "fri", "sat": "sat", "saturday": "sat",
    "sun": "sun", "sunday": "sun",
}
_DAY_RE = r"(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*"
_TIME_RE = r"\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?"
# e.g. "Mon-Fri: 6:00 AM - 10:00 PM", "Sat:6:00 AM - 8:30 PM", "Sun: Closed"
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
    """Parses visible hours text like 'Mon-Fri: 6:00 AM - 10:00 PM Sat: ...'
    into {"mon": ["06:00","22:00"], ...}. Returns None unless all 7 days are
    covered, so a half-parsed result never gets saved as if it were complete."""
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
    """schema.org openingHoursSpecification -> our format (all 7 days or None).
    Days absent from the spec are treated as closed, which is how schema.org
    represents them; we still require at least one open day."""
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


def extract_gas_hours(html_content: str, ld_data: dict | None = None) -> dict | None:
    """Best-effort gas station hours for one store page. Tries structured
    JSON-LD first (department -> openingHoursSpecification), then falls back
    to parsing the visible 'Gas Station' block in the Warehouse Services
    section. Returns None if neither yields a full 7-day schedule."""
    if ld_data:
        departments = ld_data.get("department", [])
        departments = [departments] if isinstance(departments, dict) else departments
        for dept in departments if isinstance(departments, list) else []:
            if dept.get("@type") == "GasStation" or dept.get("name") == "Gas Station":
                hours = _hours_from_opening_spec(dept.get("openingHoursSpecification"))
                if hours:
                    return hours

    text = BeautifulSoup(html_content, "html.parser").get_text(" ", strip=True)
    # Warehouse hours also appear earlier on the page, so anchor on the
    # "Gas Station" heading and stop at the pump-price disclaimer / next service.
    for m in re.finditer(r"Gas Station", text):
        segment = text[m.end(): m.end() + 400]
        cut = re.search(r"Prices shown here|Food Court|Pharmacy|Tire Service|Car Wash|Optical", segment)
        hours = parse_hours_text(segment[: cut.start()] if cut else segment)
        if hours:
            return hours
    return None


def _lookup_timezone(lat: float, lng: float) -> str | None:
    """IANA timezone name for a coordinate (needed to compute 'open now' for a
    store in its own local time). Optional: needs `pip install timezonefinder`."""
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
    """Extracts coordinates, address, phone, gas hours and timezone from a store page
    (mostly the hidden JSON-LD script; gas hours can fall back to the visible HTML)."""
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

                meta = {"lat": lat, "lng": lng, "address": address, "has_gas": has_gas}
                phone = data.get('telephone')
                if phone:
                    meta["phone"] = str(phone).strip()
                gas_hours = extract_gas_hours(html_content, data) if has_gas else None

                if gas_hours and all(hours is None for hours in gas_hours.values()):
                    has_gas = False
                    meta["has_gas"] = False
                    gas_hours = None

                if gas_hours:
                    meta["gas_hours"] = gas_hours
                tz = _lookup_timezone(lat, lng)
                if tz:
                    meta["tz"] = tz
                return meta
        except (json.JSONDecodeError, KeyError, ValueError, TypeError):
            continue

    return None


def enrich_store_list(state_urls: dict) -> dict:
    enriched_data = {}
    session = create_session()

    def fetch_single_store(target_state, target_city, target_url):
        try:
            resp = session.get(target_url, headers={'User-Agent': random.choice(USER_AGENTS)}, timeout=10)
            resp.raise_for_status()
            metadata = extract_store_metadata(resp.text)
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
                for optional in STORE_DETAIL_FIELDS:
                    if optional in meta:
                        enriched_data[res_state][res_city][optional] = meta[optional]
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
    diff = round(abs(new_price - last_price), 2)
    if diff == 0:
        return False
    pct = (diff / last_price) if last_price else float('inf')
    return diff >= PRICE_JUMP_ABS_THRESHOLD or pct >= PRICE_JUMP_PCT_THRESHOLD


def _prices_match(a: float | None, b: float | None, tol: float = PRICE_MATCH_TOLERANCE) -> bool:
    if a is None or b is None:
        return a is None and b is None
    return abs(a - b) < tol


def _quorum_value(samples: list[float | None]) -> float | None:
    """Given a list of independently-fetched samples for one grade (oldest
    first), returns the value that has reached CONFIRMATION_QUORUM mutually-
    agreeing samples, or None if no such value exists yet. Ties (e.g. two
    different clusters both reaching quorum at once) favor the most recently
    seen cluster, since that's the freshest evidence."""
    if not samples:
        return None
    clusters: list[list[float]] = []  # list of groups of matching values
    for val in samples:
        if val is None:
            continue
        placed = False
        for cluster in clusters:
            if _prices_match(cluster[0], val):
                cluster.append(val)
                placed = True
                break
        if not placed:
            clusters.append([val])

    winning = [c for c in clusters if len(c) >= CONFIRMATION_QUORUM]
    if not winning:
        return None
    # Prefer whichever qualifying cluster contains the most recent sample.
    for val in reversed(samples):
        for cluster in winning:
            if val is not None and _prices_match(cluster[0], val):
                return cluster[0]
    return winning[-1][0]


def confirm_or_revert_price(state: str, city: str, grade_prices: dict[str, float | None],
                             last_grade_prices: dict[str, float | None],
                             refetch_fn) -> tuple[dict[str, float | None], bool]:
    """Called when a freshly-fetched price looks like a suspiciously big jump
    vs. the last saved price, for one or more grades (regular/premium/diesel).
    Re-fetches (cache-busted, with a randomized delay so we're not hammering
    Costco back-to-back, and not just replaying a cached response) up to
    MAX_RECHECK_ATTEMPTS times.

    A value - whether it's the new price, the old price, or something else
    entirely - is only trusted once CONFIRMATION_QUORUM independently-fetched
    samples agree on it. A single matching recheck is no longer enough on its
    own, since one recheck can't distinguish "the price really moved" from
    "the endpoint served the same cached/glitchy response twice."

    grade_prices / last_grade_prices are {"regular": ..., "premium": ..., "diesel": ...}.
    Returns (final_prices, unconfirmed) where unconfirmed is True if at least
    one grade never reached quorum after all rechecks - in that case the
    freshest fetched value is kept (not the stale old one), just flagged for
    visibility."""
    suspicious = {
        grade: is_suspicious_jump(grade_prices.get(grade), last_grade_prices.get(grade))
        for grade in GRADES
    }

    details = [f"{grade} {last_grade_prices.get(grade)}->{grade_prices.get(grade)}"
               for grade in GRADES if suspicious[grade]]
    print(f"  ⚠ Suspicious jump for {city}, {state}: {', '.join(details)}. Re-checking...")

    # Deliberately NOT seeded with the original (suspicious) fetch. If the
    # original counted as a free sample, a single agreeing recheck would
    # satisfy CONFIRMATION_QUORUM=2 by itself - exactly the weak "one
    # recheck confirms it" behavior this was meant to replace. Quorum must
    # be reached among independently-fetched *rechecks*.
    samples: dict[str, list[float | None]] = {grade: [] for grade in GRADES}
    final_prices = dict(grade_prices)

    for attempt in range(MAX_RECHECK_ATTEMPTS):
        time.sleep(random.uniform(*RECHECK_DELAY_RANGE))
        recheck = refetch_fn()
        if recheck is None:
            continue
        recheck_prices = recheck  # {"regular": ..., "premium": ..., "diesel": ...}

        for grade in GRADES:
            if not suspicious[grade]:
                continue
            samples[grade].append(recheck_prices.get(grade))
            quorum_val = _quorum_value(samples[grade])
            if quorum_val is not None:
                final_prices[grade] = quorum_val
                suspicious[grade] = False
            else:
                final_prices[grade] = recheck_prices.get(grade)  # freshest sample, in case we run out of attempts

        if not any(suspicious.values()):
            break

    unconfirmed = any(suspicious.values())
    if unconfirmed:
        print(f"  ⚠ {city}, {state}: couldn't confirm after {MAX_RECHECK_ATTEMPTS} recheck(s) - "
              f"keeping most recent fetch ({final_prices}), flagging as unconfirmed "
              f"[samples: {samples}]")
    else:
        print(f"  ✓ Resolved {city}, {state}: {final_prices}")

    return final_prices, unconfirmed


def log_unconfirmed_jumps(records: list[dict], filepath: str = UNCONFIRMED_JUMPS_LOG_FILE) -> None:
    """Appends one JSON line per unconfirmed price jump. Each record carries
    enough context (last known price, the raw suspicious fetch, and what was
    finally kept) to investigate later without re-running anything. Failing
    to write this log is never allowed to break a scrape run - it's purely
    diagnostic - so errors are caught and just printed."""
    if not records:
        return
    try:
        with open(filepath, 'a', encoding='utf-8') as f:
            for record in records:
                f.write(json.dumps(record, separators=(',', ':')) + '\n')
    except OSError as e:
        print(f"⚠️  Couldn't write to unconfirmed-jumps log '{filepath}': {e}")


def summarize_unconfirmed_jumps(filepath: str = UNCONFIRMED_JUMPS_LOG_FILE, top_n: int = 15) -> None:
    """Reads the unconfirmed-jumps log and prints the stores that show up
    most often, so recurring offenders (a flaky store, a bad warehouse ID,
    a store that's genuinely volatile) are easy to spot."""
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
    """Loads just the {state: {city: [reg, prem, diesel]}} prices out of an
    existing *_latest.json, used as the baseline for the jump-confirmation
    check. Returns {} if the file doesn't exist yet or is unreadable - in
    that case the check simply has nothing to compare against and skips (no
    baseline, no false positives on the very first run)."""
    if not os.path.exists(latest_path):
        return {}
    try:
        with open(latest_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data.get('prices', {}) if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def get_gas_prices_ajax(locations: dict, source_filepath: str | None = None,
                         last_known_prices: dict | None = None,
                         jump_log_filepath: str | None = None,
                         dataset_label: str | None = None) -> dict:
    """Concurrently fetches gas prices (regular, premium, diesel) from
    Costco's AJAX API.

    jump_log_filepath: if given, every unconfirmed price jump this run gets
    appended to this file (see log_unconfirmed_jumps) for later analysis.
    Left as None by default so ad-hoc/test calls don't write files unless
    a caller explicitly opts in.
    dataset_label: optional tag (e.g. "Local"/"CA"/"US") included in each
    logged record, since the same store can appear in more than one dataset.
    """

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
                    resp = session.get(
                        _cache_busted_url(ajax_url),
                        headers={
                            'User-Agent': random.choice(USER_AGENTS),
                            'Cache-Control': 'no-cache, no-store',
                            'Pragma': 'no-cache',
                        },
                        timeout=15
                    )
                    resp.raise_for_status()

                    raw_data = resp.json()
                    if not raw_data:
                        raise ValueError("Empty response")

                    inner_data = next(iter(raw_data.values()))
                    normalized = {k.lower(): v for k, v in inner_data.items()}

                    reg = format_price(normalized.get('regular'))
                    prem = format_price(normalized.get('premium'))
                    diesel = format_price(normalized.get('diesel'))

                    if reg is not None or prem is not None or diesel is not None:
                        return {"regular": reg, "premium": prem, "diesel": diesel}

                except (requests.exceptions.RequestException, json.JSONDecodeError, ValueError, KeyError):
                    pass
            return None

        result = attempt_fetch()
        if result is None:
            return target_state, target_city, None, False, None

        last = last_known_prices.get(target_state, {}).get(target_city)
        last_grade_prices = {
            "regular": _grade_price(last, 0) if last else None,
            "premium": _grade_price(last, 1) if last else None,
            "diesel": _grade_price(last, 2) if last else None,
        }

        raw_result = dict(result)  # the fetch that first looked suspicious, before any recheck
        flagged = False
        if any(is_suspicious_jump(result.get(grade), last_grade_prices.get(grade)) for grade in GRADES):
            result, flagged = confirm_or_revert_price(
                target_state, target_city, result, last_grade_prices, attempt_fetch
            )

        jump_detail = None
        if flagged:
            jump_detail = {
                "last_reg": last_grade_prices["regular"], "last_prem": last_grade_prices["premium"],
                "last_diesel": last_grade_prices["diesel"],
                "raw_reg": raw_result["regular"], "raw_prem": raw_result["premium"],
                "raw_diesel": raw_result["diesel"],
                "final_reg": result["regular"], "final_prem": result["premium"],
                "final_diesel": result["diesel"],
            }

        prices_list = [result["regular"], result["premium"], result["diesel"]]
        return target_state, target_city, prices_list, flagged, jump_detail

    print("Fetching live gas prices...")
    total_stores = 0
    failed_stores: list[tuple[str, str]] = []
    unconfirmed_jumps: list[tuple[str, str]] = []
    jump_log_records: list[dict] = []
    run_timestamp = time.strftime("%Y-%m-%d %H:%M", time.localtime())

    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = []
        for state, cities in locations.items():
            fetched_prices[state] = {}
            for city, info in cities.items():
                total_stores += 1
                futures.append(executor.submit(fetch_price, state, city, info))

        for future in as_completed(futures):
            state, city, prices, flagged, jump_detail = future.result()
            if prices:
                fetched_prices[state][city] = prices
                if flagged:
                    unconfirmed_jumps.append((state, city))
                    if jump_detail:
                        jump_log_records.append({
                            "timestamp": run_timestamp,
                            "state": state,
                            "city": city,
                            "dataset": dataset_label,
                            **jump_detail,
                        })
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

    # Clean up empty states
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

    sorted_stores = {
        state: dict(sorted(cities.items()))
        for state, cities in sorted(existing_stores.items())
    }

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
    sorted_stores = {
        state: dict(sorted(cities.items()))
        for state, cities in sorted(master_stores.items())
    }

    with open(output_filepath, 'w', encoding='utf-8') as f:
        json.dump(master_stores, f, indent=4)
    print(f"\nMaster database '{output_filepath}' updated successfully.")


def refresh_store_details(stores: dict, filepath: str) -> int:
    """Re-fetches each store's page and fills in/updates the optional detail
    fields (phone, gas_hours, tz) on stores that already exist in `filepath`.

    Additive only: never removes a store, and a store whose page fails to
    fetch/parse keeps whatever it had before. Returns how many stores changed."""
    session = create_session()

    def fetch(state, city, info):
        url = info.get("url") if isinstance(info, dict) else info
        try:
            resp = session.get(url, headers={'User-Agent': random.choice(USER_AGENTS)}, timeout=10)
            resp.raise_for_status()
            return state, city, extract_store_metadata(resp.text)
        except (requests.exceptions.RequestException, ValueError, KeyError):
            return state, city, None

    jobs = [(s, c, i) for s, cities in stores.items() for c, i in cities.items() if isinstance(i, dict)]
    legacy = sum(1 for cities in stores.values() for i in cities.values() if not isinstance(i, dict))
    if legacy:
        print(f"Note: {legacy} entr{'y' if legacy == 1 else 'ies'} in '{filepath}' use the old plain-URL format "
              f"and can't be refreshed (no warehouse details stored).")
    changed = failed = 0
    with ThreadPoolExecutor(max_workers=10) as executor:
        for future in as_completed([executor.submit(fetch, *j) for j in jobs]):
            state, city, meta = future.result()
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
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(stores, f, indent=4)
    return changed


def process_and_save(locations: dict, source_filepath: str, history_file: str, latest_file: str, label: str) -> bool:
    """Fetches prices for one dataset (local/CA/US), validates the resulting
    snapshot's completeness, and only saves it if it passes. Returns True if
    saved, False if rejected - callers should treat False as a failed run
    (e.g. exit non-zero) so CI doesn't push an incomplete update."""
    prices = get_gas_prices_ajax(
        locations, source_filepath, load_latest_prices(latest_file),
        jump_log_filepath=UNCONFIRMED_JUMPS_LOG_FILE, dataset_label=label,
    )
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
        print("6: Discover new stores")
        print("7: Show unconfirmed price-jump summary (which stores flag most often)")
        print("8: Refresh store details (gas hours, phone, timezone) for existing stores")
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
        build_and_save_master_db(sorted(list(states_to_scrape)), "us_stores.json")
        #us_stores = load_store_locations('us_stores.json') or {}
        #if not process_and_save(us_stores, 'us_stores.json', US_HISTORY_FILE, US_LATEST_FILE, "US"):
        #    sys.exit(1)

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
        us_stores = discover_new_stores(list(states_to_scrape), us_stores, 'us_stores.json')
        # Discovery only enriches stores that are new to us_stores.json, so also
        # refresh gas hours / phone / timezone on the existing ones (additive only).
        refresh_store_details(us_stores, 'us_stores.json')

    elif run_type == 7:
        summarize_unconfirmed_jumps()

    elif run_type == 8:
        for stores, path in ((nearby_stores, 'local_stores.json'),
                             (ca_stores, 'ca_stores.json'),
                             (us_stores, 'us_stores.json')):
            if stores:
                refresh_store_details(stores, path)
            else:
                print(f"Skipping '{path}': file is missing, empty, or not valid JSON.")


if __name__ == '__main__':
    main()