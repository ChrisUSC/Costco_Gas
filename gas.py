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

# List of User-Agents to rotate
USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'
]

MAX_FETCH_ATTEMPTS = 3
EXCLUDED_STATES = {"PR"}


def format_price(v) -> str:
    """Format a raw price value into an '$X.XX' string, or 'N/A' if invalid."""
    if v is None or str(v).strip().lower() in ("", "n/a"):
        return "N/A"
    try:
        return f"${float(str(v).replace('$', '').strip()):.2f}"
    except ValueError:
        return "N/A"


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
                for gas_type in ("Regular", "Premium"):
                    price_str = gas_prices.get(gas_type, "N/A")
                    if price_str == "N/A":
                        continue
                    price = float(price_str.replace('$', ''))
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


def save_data(data: dict, file_path: str) -> None:
    timestamp_str = next(iter(data.keys()), None)
    if not timestamp_str:
        return

    raw_states_data = data[timestamp_str]
    sorted_states_data = {
        state: dict(sorted(cities.items()))
        for state, cities in sorted(raw_states_data.items())
    }

    save_prices = {}
    if os.path.exists(file_path):
        try:
            with open(file_path, 'r') as json_file:
                save_prices = json.load(json_file)
        except json.JSONDecodeError:
            pass

    save_prices[timestamp_str] = sorted_states_data

    # Write one compact JSON line per timestamp, sorted chronologically
    with open(file_path, "w", encoding='utf-8') as fp:
        fp.write("{\n")
        items = list(save_prices.items())
        for i, (ts, snapshot) in enumerate(items):
            line = json.dumps(ts) + ":" + json.dumps(snapshot, separators=(',', ':'))
            comma = "," if i < len(items) - 1 else ""
            fp.write(line + comma + "\n")
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
        try:
            data = json.loads(script.string)
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
        except Exception:
            continue
    return None


def enrich_store_list(state_urls: dict) -> dict:
    """Visits each store URL concurrently, extracts coordinates, and removes stores without gas."""
    enriched_data = {}
    session = create_session()

    def fetch_single_store(state, city, url):
        try:
            resp = session.get(url, headers={'User-Agent': random.choice(USER_AGENTS)}, timeout=10)
            resp.raise_for_status()
            metadata = extract_store_metadata(resp.text)
            return (state, city, url, metadata)
        except Exception:
            return (state, city, url, None)

    print("Fetching exact store metadata (Coordinates & Addresses)...")

    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = []
        for state, cities in state_urls.items():
            enriched_data[state] = {}
            for city, url in cities.items():
                futures.append(executor.submit(fetch_single_store, state, city, url))

        for future in as_completed(futures):
            state, city, url, meta = future.result()

            if meta and meta["has_gas"]:
                wh_id = get_warehouse_id(url)
                enriched_data[state][city] = {
                    "url": url,
                    "warehouse_id": wh_id,
                    "lat": meta["lat"],
                    "lng": meta["lng"],
                    "address": meta["address"]
                }
                print(f"Added {city}, {state} (ID: {wh_id})")
            elif meta and not meta["has_gas"]:
                print(f"Skipping {city}, {state} - No Gas Station.")

    return {k: v for k, v in enriched_data.items() if v}


def get_gas_prices_ajax(locations: dict, source_filepath: str | None = None) -> dict:
    """Concurrently fetches gas prices from Costco's AJAX API."""
    fetched_prices = {}
    session = create_session()

    def fetch_price(state, city, info):
        # Handle backwards compatibility if location file is in the old string URL format
        wh_id = info.get("warehouse_id") if isinstance(info, dict) else get_warehouse_id(info)

        ajax_url = f"https://www.costco.com/AjaxGetGasPricesService?warehouseid={wh_id}"

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

                reg = format_price(normalized.get('regular', "N/A"))
                prem = format_price(normalized.get('premium', "N/A"))

                if reg != "N/A" or prem != "N/A":
                    return (state, city, {'Regular': reg, 'Premium': prem})
            except Exception:
                pass

        return (state, city, None)

    print("Fetching live gas prices...")
    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = []
        for state, cities in locations.items():
            fetched_prices[state] = {}
            for city, info in cities.items():
                futures.append(executor.submit(fetch_price, state, city, info))

        for future in as_completed(futures):
            state, city, prices = future.result()
            if prices:
                fetched_prices[state][city] = prices
            else:
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
        url = link['href']
        if '/warehouse-locations/' in url or '/w/-/' in url:
            name = link.get_text(strip=True)
            if not url.startswith('http'):
                url = f"https://www.costco.com{url}"
            store_dict[name] = url

    return store_dict


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

    with open(output_filepath, 'w', encoding='utf-8') as f:
        json.dump(master_stores, f, indent=4)
    print(f"\nMaster database '{output_filepath}' updated successfully.")


if __name__ == '__main__':
    nearby_stores = load_store_locations('local_stores.json')
    ca_stores = load_store_locations('ca_stores.json')
    us_stores = load_store_locations('us_stores.json')

    # Check if a computer passed an argument (e.g., python backend.py 4)
    if len(sys.argv) > 1:
        run_type = int(sys.argv[1])
        print(f"Automated run detected. Executing Option {run_type}")
    else:
        # Fallback for when you run it manually
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

    # --- The rest of your logic remains exactly the same ---
    if run_type == 1 and nearby_stores:
        prices = get_gas_prices_ajax(nearby_stores, 'local_stores.json')
        save_data(prices, 'local_prices.json')
        print_lowest_prices(prices)

    elif run_type == 2 and ca_stores:
        prices = get_gas_prices_ajax(ca_stores, 'ca_stores.json')
        save_data(prices, 'ca_prices.json')
        print_lowest_prices(prices)

    elif run_type == 3 and us_stores:
        prices = get_gas_prices_ajax(us_stores, 'us_stores.json')
        save_data(prices, 'us_prices.json')
        print_lowest_prices(prices)

    elif run_type == 4:
        if nearby_stores:
            save_data(get_gas_prices_ajax(nearby_stores, 'local_stores.json'), 'local_prices.json')
        if ca_stores:
            save_data(get_gas_prices_ajax(ca_stores, 'ca_stores.json'), 'ca_prices.json')
        if us_stores:
            save_data(get_gas_prices_ajax(us_stores, 'us_stores.json'), 'us_prices.json')

    elif run_type == 5:
        target_url = "https://www.costco.com/sitemaps/warehouses-by-state"
        raw_html = fetch_directory_html(target_url)
        soup = BeautifulSoup(raw_html, 'html.parser')

        states_to_scrape = set()
        for link in soup.find_all('a', href=True):
            if "/sitemaps/warehouses-by-state/" in link['href']:
                state_code = link['href'].rstrip('/').split('/')[-1]
                if len(state_code) == 2 and state_code not in EXCLUDED_STATES:
                    states_to_scrape.add(state_code)

        print(f"Found {len(states_to_scrape)} states to process.")
        build_and_save_master_db(list(states_to_scrape), "us_stores.json")
        us_stores = load_store_locations('us_stores.json')
        prices = get_gas_prices_ajax(us_stores, 'us_stores.json')
        save_data(prices, 'us_prices.json')
        print_lowest_prices(prices)
