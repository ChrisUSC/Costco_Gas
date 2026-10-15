# Costco Gas Prices

A self-hosted, live-updating map of Costco gas prices across the US, built on scraped data with no backend server — just static files on Cloudflare and a scheduled scraper.

**Live site:** [https://costco-gas.pages.dev](https://costco-gas.pages.dev)

![Cloudflare Pages](https://img.shields.io/badge/hosted%20on-Cloudflare-orange)
![Python](https://img.shields.io/badge/scraper-Python%203.11-blue)

## Features

- 📍 Interactive Leaflet map of every Costco warehouse with a gas station, with price badges that appear as you zoom in
- ⛽ Regular, Premium, and Diesel toggle (automatically filters to Diesel-carrying stations when Diesel is selected)
- 🕒 Live "Open / Closing soon / Closed" status computed in each store's local timezone, plus expandable 7-day gas station hours
- 🛣️ **Route Finder** — find the cheapest Costco gas stations within a configurable distance of your driving route (via OSRM, with straight-line corridor fallback)
- ★ **Favorites** — save favorite stations and driving routes locally for quick access
- 🔍 Autocomplete search by city, address, or zip code (local store matches + map-biased Nominatim geocoding)
- 📈 Interactive price history chart per store (Chart.js) with 7D / 30D / 90D / 1Y / All-time range filters, lazy-loaded on demand
- 🥇 "State Lowest" leaderboard with medal ranking and 72-hour price trend arrows (`▲` / `▼` / `–`)
- 📍 "Near Me" geolocation with radius (5–100 mi) and Price / Distance sorting
- 🔗 Shareable direct links (`?store=STATE_City`) that fly straight to a station and open its popup
- 🌙 Dark mode with matching CARTO map tiles

## How it works

```
scraper.py (GitHub Actions, scheduled)
    │
    ├─ discovers stores & gas hours from costco.com's warehouse sitemap
    ├─ fetches live prices from Costco's gas-price AJAX endpoint
    ├─ confirms suspicious price jumps via cache-busted quorum rechecks
    ├─ validates snapshot coverage, then writes:
    │
    ▼
*_stores.json   *_latest.json   *_history.json
    │                 │               │
    └─────────────────┴───────────────┘
                       │
                       ▼
        index.html + js/*.js + app.js
         (static site, Cloudflare Workers)
```

The scraper runs on a schedule via GitHub Actions, commits the updated JSON files, and pushes to `main`. Cloudflare serves them as static assets — there's no API server and no database.

## Project structure

```
├── index.html              # App shell
├── styles.css              # Styling, light/dark theme via CSS variables
├── app.js                  # Main application entry point, map lifecycle & event delegation
├── js/
│   ├── utils.js            # Pure utilities, constants, distance/route math, gas hours & timestamps
│   ├── state.js            # Centralized application state & localStorage persistence
│   ├── components.js       # Reusable DOM components (store cards, mobile sheet, saved routes)
│   ├── search.js           # Autocomplete & map-biased Nominatim geocoding
│   ├── charts.js           # Lazy-loaded history fetcher & Chart.js price history modal
│   └── routes.js           # OSRM driving route lookup, corridor filtering & saved routes
│
├── scraper.py              # Store discovery, metadata enrichment & AJAX price scraper
├── requirements.txt        # Python dependencies
├── wrangler.jsonc          # Cloudflare Workers Static Assets config
│
├── us_stores.json          # Master store list: address, lat/lng, warehouse ID, hours, phone, tz
├── ca_stores.json          # Subset: California stores only
├── local_stores.json       # Subset: nearby stores for fast local runs
│
├── us_latest.json          # Newest price snapshot + ~72h trend baseline — fetched on page load
├── us_history.json         # Full timestamped price log — lazy-loaded when opening a chart
├── ca_latest.json / ca_history.json       # Same pair, CA subset
├── local_latest.json / local_history.json # Same pair, local subset
│
├── state_list.json         # Costco's state → warehouse-sitemap URL mapping
└── tests/
    ├── test_scraper.py     # Unit tests for price parsing, metadata, quorum rechecks & file I/O
    ├── test_store_hours.py # Unit tests for JSON-LD / HTML gas hours extraction & detail refresh
    └── test_trend_data.py  # Unit tests for trend baseline lookback & latest snapshot generation
```

## Data format

**`*_latest.json`**
```json
{
  "timestamp": "2026-06-30 10:53",
  "prices": {
    "CA": { "Turlock": [4.45, 4.85, null] },
    "TX": { "Austin": [2.99, 3.39, 3.49] }
  },
  "previous": {
    "CA": { "Turlock": [4.50, 4.90, null] }
  },
  "previous_timestamp": "2026-06-27 10:53"
}
```

**`*_history.json`** — one entry per scrape, keyed by timestamp, same inner shape as `prices` above:
```json
{
  "2026-06-30 09:00": { "CA": { "Turlock": [4.50, 4.90, null] } },
  "2026-06-30 10:53": { "CA": { "Turlock": [4.45, 4.85, null] } }
}
```

Price arrays are `[regular, premium, diesel]`. `null` means that grade wasn't available at that store (legacy 2-element `[regular, premium]` entries are also supported transparently).

**`*_stores.json`**
```json
{
  "CA": {
    "Turlock": {
      "warehouse_id": "782",
      "lat": 37.5091,
      "lng": -120.8466,
      "address": "2500 GEER RD, TURLOCK, CA 95380",
      "url": "https://www.costco.com/w/-/ca/turlock/782",
      "phone": "(209) 656-5328",
      "tz": "America/Los_Angeles",
      "gas_hours": {
        "mon": ["06:00", "22:00"],
        "tue": ["06:00", "22:00"],
        "wed": ["06:00", "22:00"],
        "thu": ["06:00", "22:00"],
        "fri": ["06:00", "22:00"],
        "sat": ["06:00", "20:30"],
        "sun": ["06:00", "20:00"]
      }
    }
  }
}
```

## Running the scraper

```bash
pip install -r requirements.txt

python scraper.py          # interactive menu
python scraper.py 3        # non-interactive, for cron/CI (see options below)
```

| Option | What it does |
|---|---|
| `1` | Update prices for `local_stores.json` (small nearby subset) |
| `2` | Update prices for `ca_stores.json` (California only) |
| `3` | Update prices for `us_stores.json` (all US stores) |
| `4` | Run 1 + 2 + 3 |
| `5` | **Full rebuild** — re-discovers every warehouse address/coordinates from costco.com from scratch |
| `6` | Discover any *new* stores in existing states and refresh store details (`phone`, `gas_hours`, `tz`) |
| `7` | Print a summary of stores with the most frequent unconfirmed price jumps from `unconfirmed_jumps_log.jsonl` |
| `8` | Refresh store details (`gas_hours`, `phone`, `tz`) additively across `local_stores.json`, `ca_stores.json`, and `us_stores.json` |

### Built-in safety checks

- **Price-jump quorum check** — if a store's price moves by ≥$0.30 or ≥8% vs. its last saved price, the scraper re-fetches with cache-busting query nonces and requires a quorum of agreeing samples before confirming the jump.
- **Store-deletion circuit breaker** — a store is only removed from `*_stores.json` after failing every retry *and* when the overall run failure rate is below the circuit-breaker thresholds (<25% on batches of 10+ stores, <80% on batches of 3+ stores).
- **Full-rebuild guard** — option `5` refuses to overwrite `us_stores.json` if the freshly rebuilt list is more than 25% smaller than the existing file.
- **Snapshot validation** — before saving any price snapshot, `validate_snapshot()` verifies that at least 85% of expected states and 75% of expected stores returned prices.

## Local frontend development

Serve the repo root with any static HTTP server:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Deployment

Deployed on Cloudflare as Workers Static Assets (`wrangler.jsonc` points `assets.directory` at the repo root, and `.assetsignore` excludes scraper internals and tests):

```bash
npx wrangler deploy
```

## Testing

```bash
PYTHONPATH=. pytest -v
```
