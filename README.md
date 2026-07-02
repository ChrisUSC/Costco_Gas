# Costco Gas Prices

A self-hosted, live-updating map of Costco gas prices across the US, built on scraped data with no backend server — just static files on Cloudflare and a scheduled scraper.

**Live site:** [https://costco-gas.pages.dev](https://costco-gas.pages.dev)

![Cloudflare Pages](https://img.shields.io/badge/hosted%20on-Cloudflare-orange)
![Python](https://img.shields.io/badge/scraper-Python%203.11-blue)

## Features

- 📍 Interactive Leaflet map of every Costco warehouse with a gas station, with price badges that appear as you zoom in
- 🔍 Autocomplete search by city/zip (store matches + geocoded places via Nominatim)
- 📈 Price history chart per store (Chart.js), lazy-loaded on demand
- 🥇 "State Lowest" leaderboard with medal ranking
- 📍 "Near Me" geolocation with distance sorting
- ⛽ Regular/Premium toggle
- 🌙 Dark mode
- Zero backend — the frontend is static HTML/CSS/JS served as Cloudflare Workers Static Assets, reading plain JSON files updated by a scheduled scraper

## How it works

```
scraper.py (GitHub Actions, scheduled)
    │
    ├─ discovers stores from costco.com's warehouse sitemap
    ├─ fetches live prices from Costco's gas-price AJAX endpoint
    ├─ validates the run, then writes:
    │
    ▼
*_stores.json   *_latest.json   *_history.json
    │                 │               │
    └─────────────────┴───────────────┘
                       │
                       ▼
              index.html / app.js
         (static site, Cloudflare Workers)
```

The scraper runs on a schedule via GitHub Actions, commits the updated JSON files, and pushes to `main`. Cloudflare serves them as static assets — there's no API server and no database.

## Project structure

```
├── index.html              # App shell
├── styles.css              # Styling, light/dark theme via CSS variables
├── app.js                  # Frontend logic: map, sidebar, search, charts
├── scraper.py               # Store discovery + price scraper
├── requirements.txt         # Python dependencies
├── wrangler.jsonc            # Cloudflare Workers Static Assets config
│
├── us_stores.json           # Master store list: address, lat/lng, warehouse ID (all US)
├── ca_stores.json            # Subset: California stores only
├── local_stores.json         # Subset: a handful of nearby stores, for fast local runs
│
├── us_latest.json            # Newest price snapshot only — small, fetched on every page load
├── us_history.json           # Full timestamped price log — large, lazy-loaded for charts
├── ca_latest.json / ca_history.json         # Same pair, CA subset
├── local_latest.json / local_history.json    # Same pair, local subset
│
├── state_list.json           # Costco's state → warehouse-sitemap URL mapping
└── test_validate_snapshot.py # Tests for the scraper's data-quality checks
```

### Why `_latest.json` and `_history.json` are separate

Every scrape used to append a full snapshot of all ~570 stores to one ever-growing file, and the frontend fetched that entire file on every page load just to render the map. That file was already 500KB+ and growing by ~14KB per scrape.

Now each dataset is split in two:
- **`_latest.json`** — just the newest snapshot (`{"timestamp": ..., "prices": {...}}`), a few KB, fetched on every page load for the map/sidebar.
- **`_history.json`** — the full timestamped log, fetched lazily and only once, the first time someone opens a price history chart.

## Data format

**`*_latest.json`**
```json
{
  "timestamp": "2026-06-30 10:53",
  "prices": {
    "CA": { "Turlock": [4.45, 4.85] },
    "TX": { "Austin": [2.99, 3.39] }
  }
}
```

**`*_history.json`** — one entry per scrape, keyed by timestamp, same inner shape as `prices` above:
```json
{
  "2026-06-30 09:00": { "CA": { "Turlock": [4.50, 4.90] } },
  "2026-06-30 10:53": { "CA": { "Turlock": [4.45, 4.85] } }
}
```

Price arrays are `[regular, premium]`. `null`/`"N/A"` means that grade wasn't available at that store.

**`*_stores.json`**
```json
{
  "CA": {
    "Turlock": {
      "warehouse_id": "782",
      "lat": 37.5091,
      "lng": -120.8466,
      "address": "2500 GEER RD, TURLOCK, CA 95380",
      "url": "https://www.costco.com/w/-/ca/turlock/782"
    }
  }
}
```

## Running the scraper

```bash
pip install -r requirements.txt --break-system-packages

python scraper.py          # interactive menu
python scraper.py 3        # non-interactive, for cron/CI (see options below)
```

| Option | What it does |
|---|---|
| `1` | Update prices for `local_stores.json` (small nearby subset) |
| `2` | Update prices for `ca_stores.json` (California only) |
| `3` | Update prices for `us_stores.json` (all US stores) |
| `4` | Run 1 + 2 + 3 |
| `5` | **Full rebuild** — re-discovers every warehouse address/coordinates from costco.com from scratch, then fetches prices |
| `6` | Discover any *new* stores in existing states without a full rebuild |

Options `1`–`5` fetch, validate, and save a price snapshot; option `6` only updates the store list.

### Built-in safety checks

Scraping a live retailer site means occasional blocks, rate limits, or partial network failures. The scraper defends against those turning into bad data on the live site:

- **Store-deletion circuit breaker** — a store only gets removed from `*_stores.json` after failing every retry *and* the run's overall failure rate looks like an isolated closure, not a mass block. A high failure rate (either a large batch with >25% failures, or a near-total failure on a small batch) leaves the store list untouched instead.
- **Full-rebuild guard** — option `5` refuses to overwrite `us_stores.json` if the freshly rebuilt list is more than 25% smaller than what's already there.
- **Snapshot validation** — before *any* price data is saved, `validate_snapshot()` checks that the run returned prices for at least 85% of expected states and 75% of expected stores. If not, nothing is saved and the script exits non-zero, so an automated run doesn't publish a sparse, incomplete update.

## Automated updates (GitHub Actions)

A scheduled workflow runs `scraper.py`, and only commits/pushes if it succeeds:

```yaml
- name: Run scraper
  uses: nick-fields/retry@v3
  with:
    timeout_minutes: 10
    max_attempts: 3
    retry_wait_seconds: 120
    command: python scraper.py 3

- name: Commit and push updated prices
  run: |
    git config user.name "github-actions[bot]"
    git config user.email "github-actions[bot]@users.noreply.github.com"
    git add us_history.json us_latest.json ca_history.json ca_latest.json local_history.json local_latest.json
    git diff --staged --quiet || git commit -m "chore: auto-update gas prices [$(TZ=America/Los_Angeles date '+%Y-%m-%d %H:%M PT')]"
    git pull --rebase origin main
    git push
```

Because `scraper.py` exits non-zero when a run fails validation, GitHub Actions skips the commit/push step automatically — no bad data ever reaches `main`. The `retry` wrapper gives transient rate limits a chance to clear before giving up for that run; the next scheduled run tries again regardless.

## Local frontend development

The frontend is plain HTML/CSS/JS — no build step. Serve the folder with anything static, e.g.:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

## Deployment

Deployed on Cloudflare as Workers Static Assets (`wrangler.jsonc` points `assets.directory` at the repo root):

```bash
npx wrangler deploy
```

## Testing

```bash
pip install pytest --break-system-packages
pytest -v
```

Covers price/URL parsing, store JSON-LD extraction, the store discovery HTML parser, save/load of the latest+history files, the retry/circuit-breaker behavior of the price fetcher, and snapshot validation.

## Tech stack

- **Scraper:** Python, `requests` (with retry/backoff), `BeautifulSoup4`
- **Frontend:** Vanilla JS, [Leaflet](https://leafletjs.com/) (map), [Chart.js](https://www.chartjs.org/) (price history)
- **Hosting:** Cloudflare Workers Static Assets
- **Automation:** GitHub Actions (scheduled scrape + commit)

## Known limitations

- Scraping a third-party site's live prices means this can break if Costco changes their site structure or blocks the scraper's IP — the safety checks above are designed to fail loudly/safely rather than publish bad data, but they don't prevent an outage.
- Nominatim (OpenStreetMap) geocoding is called directly from the browser for autocomplete and is subject to their usage policy and rate limits.
- Puerto Rico is intentionally excluded from state discovery.
