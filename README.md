# Costco Gas Prices

A live-updating map of Costco gas prices across the US. A scheduled scraper collects prices, stores them in Cloudflare R2, and a static site on Cloudflare Pages displays them. There's no backend server to run.

**Live site:** [https://costco-gas.pages.dev](https://costco-gas.pages.dev)

![Cloudflare Pages](https://img.shields.io/badge/hosted%20on-Cloudflare%20Pages-orange)
![Python](https://img.shields.io/badge/scraper-Python%203.11-blue)

## Features

- 📍 Interactive Leaflet map of every Costco warehouse with a gas station; stations cluster when zoomed out and turn into price pills as you zoom in
- 🎨 Pins and price pills coloured by relative price: green, amber and red for the cheapest, middle and most expensive third of the prices in view
- 🧭 One-tap **Directions** to any station (Google Maps, Apple Maps or Waze)
- ⛽ Regular / Premium / Diesel toggle (Diesel shows only stations that sell it); station cards lead with the selected grade's price
- 🕒 Live "Open / Closing soon / Closed" status in each station's local time zone, plus 7-day gas hours
- 🛣️ **Route**: cheapest stations within a set distance of a driving route (OSRM, with a straight-line fallback)
- ★ **Favorites**: save stations and routes in your browser
- 🔍 Search by city, address or zip code (store matches plus Nominatim geocoding)
- 📈 Price-history chart per station with 7D / 30D / 90D / 1Y / All ranges
- 🥇 **Lowest**: a ranked state leaderboard, with 72-hour price trends shown as an arrow and the size of the move (`▼ 4¢`, `▲ 6¢`, `–`)
- 📍 **Nearby**: stations within a 5–100 mi radius of you, a searched place or the map centre, sorted by price or distance
- 🔗 Shareable links: `?store=STATE_City` opens a station, and `?tab=`, `?grade=` and `?state=` restore the view
- 📲 Installable to a phone or desktop home screen (web app manifest), and opens offline with the last prices it saw (service worker)
- 📴 **Offline mode**: a built-in US outline replaces the map background, the header says the prices are saved, Route and place search are hidden, and prices refresh by themselves when the connection returns
- ⚙️ Settings panel: clustering and price colours on/off, directions app (Google Maps, Apple Maps or Waze), light/dark/system theme, start-up tab, and automatic location on/off. Settings are saved in the browser.
- 🌙 Light and dark themes with matching map tiles, following the system setting by default
- ♿ Keyboard navigation with visible focus, 44px touch targets, reduced-motion support and text contrast that meets WCAG AA

## How it works

```
Cloudflare scheduled job (hourly) → GitHub Actions (fetch_prices.yml)
        │
        ▼
pipeline/r2_sync.py download   ← previous snapshots from R2 into data/snapshots/
pipeline/scraper.py 3          ← fetch prices from Costco, confirm suspicious jumps,
        │                         validate coverage, append changes to history
        ▼
pipeline/r2_sync.py upload     → us_latest.json / us_history.json (+ daily backup) to R2
        │
        ▼
Cloudflare R2 bucket ──► functions/_middleware.js ──► browser
                          (serves *_latest.json / *_history.json from R2)
public/ (HTML, JS, CSS, us_stores.json) ──► Cloudflare Pages static hosting ──► browser
```

- **Prices** never touch git. They live in R2 and are streamed to the site by the Pages middleware.
- **Store list** (`public/us_stores.json`) is in git. A weekly workflow discovers new warehouses and opens a pull request for review.
- **Schedule:** prices update hourly. A scheduled job on Cloudflare starts `fetch_prices.yml` through GitHub's `workflow_dispatch` API once an hour; the workflow has no schedule of its own. Overlapping runs queue instead of racing. Discovery runs Mondays at 08:00 UTC. Any workflow can also be started by hand from the Actions tab.

## Project structure

```
├── public/                     # Everything the browser loads (Cloudflare Pages output directory)
│   ├── index.html              # App shell
│   ├── styles.css              # Design tokens (colour, type, radius, shadow) + all styling, light/dark
│   ├── app.js                  # Entry point: map, sidebar views, event handling
│   ├── js/
│   │   ├── utils.js            # Constants, price/grade helpers, distance math, gas hours, timestamps
│   │   ├── state.js            # App state and localStorage preferences
│   │   ├── components.js       # Store cards, mobile sheet, saved-route cards
│   │   ├── icons.js            # Inline SVG icon set (used instead of emoji)
│   │   ├── search.js           # Autocomplete and Nominatim geocoding
│   │   ├── charts.js           # Price-history loading and Chart.js modal
│   │   ├── routes.js           # OSRM routing, corridor filtering, saved routes
│   │   └── nav.js              # URL query state and Back-button handling for the sheet and modal
│   ├── manifest.webmanifest    # Web app manifest (install to home screen)
│   ├── sw.js                   # Service worker: offline copy of the app and the last prices
│   ├── us-outline.json         # Simplified US state outlines for the offline map (US Census, via us-atlas)
│   ├── icons/                  # App icons referenced by the manifest
│   └── us_stores.json          # Master store list: address, coordinates, hours, phone, time zone
│
├── functions/
│   └── _middleware.js          # Pages Function: serves price snapshots from the R2 bucket
├── worker.js                   # Same R2 routing as a standalone Cloudflare Worker
├── r2_snapshots.js             # R2 snapshot serving shared by the middleware and the Worker
├── wrangler.jsonc              # Worker config (static assets from public/, R2 binding)
│
├── pipeline/                   # Python data pipeline
│   ├── scraper.py              # Store discovery, metadata, price scraping and snapshot saving
│   ├── r2_sync.py              # Download/upload snapshots, list and restore R2 backups
│   ├── paths.py                # Central file locations used by the scripts
│   ├── ca_frequency_runner.py  # High-frequency California price tracker (experiment)
│   └── analyze_price_frequency.py # Reports how often prices change in a history file
│
├── data/
│   ├── ca_stores.json          # California store list (used by option 2 and the CA experiment)
│   ├── local_stores.json       # Small nearby subset for quick local runs (option 1)
│   └── snapshots/              # Local copies of R2 snapshots (git-ignored)
│
├── tests/                      # pytest suite for the pipeline
├── .github/workflows/
│   ├── fetch_prices.yml        # Scheduled price scrape (R2 download → scrape → upload)
│   ├── discover.yml            # Weekly new-store discovery; opens a PR
│   ├── ca_frequency_experiment.yml # Manual CA high-frequency run
│   ├── seed_r2.yml             # Manual R2 connection test
│   └── testing.yml             # Runs pytest on pushes and PRs to main
├── requirements.txt            # Pipeline dependencies
├── requirements-dev.txt        # + pytest
└── pytest.ini
```

The pipeline scripts resolve their paths from `pipeline/paths.py`, so they can be run from any directory.

## Frontend design

The frontend is plain HTML, CSS and ES modules with no build step.

- **Design tokens:** every colour, radius, shadow and type size is a CSS variable defined at the top of `public/styles.css`, with a light set on `:root` and a dark set on `body.dark-mode`. Change a token rather than a component when adjusting the look.
- **Icons:** `public/js/icons.js` holds one inline SVG set. Use `icon('name', size)` in templates instead of emoji, and give icon-only buttons an `aria-label`.
- **Buttons and fields:** shared classes `btn` (`btn-primary`, `btn-tonal`, `btn-secondary`, `btn-ghost`, `btn-icon`), `input` and `select`.
- **Font:** the system UI font stack, so no web font is downloaded.
- **Layout tiers:** phone ≤ 599px (map with a draggable bottom sheet), tablet 600–1099px (narrow sidebar, floating details card), desktop ≥ 1100px (sidebar plus map popups).
- **Canvas colours:** Chart.js reads the same tokens at render time, so the chart follows the theme.

## Running the pipeline

```bash
pip install -r requirements.txt
```

```bash
python pipeline/scraper.py          # interactive menu
```

```bash
python pipeline/scraper.py 3        # non-interactive (what CI runs)
```

| Option | What it does |
|---|---|
| `1` | Update prices for `data/local_stores.json` |
| `2` | Update prices for `data/ca_stores.json` |
| `3` | Update prices for `public/us_stores.json` (all US stores) |
| `4` | Run 1 + 2 + 3 |
| `5` | **Full rebuild**: re-discover every warehouse from costco.com and rewrite `public/us_stores.json` |
| `6` | Discover *new* stores and refresh details (`phone`, `gas_hours`, `tz`) in `public/us_stores.json` |
| `8` | Refresh store details across all three store lists |

Price snapshots are written to `data/snapshots/`. To start from the real data, download it from R2 first (needs the R2 environment variables below):

```bash
python pipeline/r2_sync.py download
```

### R2 sync and backups

`r2_sync.py` needs `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET_NAME` (stored as GitHub Actions secrets for CI).

| Command | What it does |
|---|---|
| `python pipeline/r2_sync.py download [files…]` | Download snapshots into `data/snapshots/` |
| `python pipeline/r2_sync.py upload [files…]` | Upload snapshots; history files also get a dated copy under `backups/` |
| `python pipeline/r2_sync.py list-backups` | List backup objects |
| `python pipeline/r2_sync.py restore <backup_key> [target]` | Download a backup into `data/snapshots/` |
| `python pipeline/r2_sync.py test` | Check the bucket connection |

With no file names, `download` and `upload` handle all US, CA, local and CA-frequency snapshots.

### Built-in safety checks

- **Price-jump confirmation:** a change of ≥$0.30 or ≥8% (or any change, in the default verify-all mode) is re-fetched with cache-busting until a quorum of samples agrees; unconfirmed changes revert to the last known price.
- **Snapshot validation:** a run is only saved if at least 85% of states and 75% of stores returned prices.
- **No automatic store deletion:** stores that return no prices are listed in the run log but stay in the store list. Removing a store is a manual edit.
- **Full-rebuild guard:** option `5` won't overwrite `public/us_stores.json` if the new list is more than 25% smaller.

## Data format

**`*_latest.json`** (in R2)
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

`previous` holds prices from about 72 hours earlier and drives the trend arrows. Timestamps are Pacific time.

**`*_history.json`** (in R2): change-only. The first entry is a full snapshot; each later entry lists only the stores whose prices changed.
```json
{
  "2026-06-30 09:00": { "CA": { "Turlock": [4.50, 4.90, null], "Tracy": [4.39, 4.79, null] } },
  "2026-06-30 16:00": { "CA": { "Turlock": [4.45, 4.85, null] } }
}
```

Price arrays are `[regular, premium, diesel]`. `null` means that grade isn't sold there (older 2-element `[regular, premium]` entries are still read correctly).

**`public/us_stores.json`**
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
        "sat": ["06:00", "20:30"],
        "sun": ["06:00", "20:00"]
      }
    }
  }
}
```

`gas_hours` always has all seven days (shortened here); a closed day is `null`. `data/ca_stores.json` and `data/local_stores.json` use an older format mapping each city straight to its price-API URL.

## Local frontend development

The site needs price snapshots, which live in R2. Download them, copy the US files into `public/` (they're git-ignored there), and serve the folder:

```bash
python pipeline/r2_sync.py download us_latest.json us_history.json
```

```bash
cp data/snapshots/us_latest.json data/snapshots/us_history.json public/
```

```bash
python3 -m http.server 8000 -d public
```

Then open `http://localhost:8000`.

The service worker (`public/sw.js`) loads the app's files from the network whenever it can, so edits show up on a normal reload. If something still looks stale, clear it in DevTools: Application → Service workers → Unregister, or tick "Bypass for network". When you add a file the app loads, add it to `APP_FILES` in `sw.js`; `tests/test_service_worker.py` checks this.

## Deployment

**Cloudflare Pages** (the live site) deploys from this repo. Project settings:

- **Build command:** none
- **Build output directory:** `public`
- **Root directory:** repo root (so `functions/` is picked up)
- **Functions → R2 bucket bindings:** `DATA_BUCKET` → `costco-gas-data`

**Cloudflare Worker** (optional, same behaviour): `worker.js` with `wrangler.jsonc` serves `public/` as static assets and routes snapshot requests to R2.

```bash
npx wrangler deploy
```

## Credits

- Offline map outlines: U.S. Census Bureau cartographic boundary files (public domain), via [us-atlas](https://github.com/topojson/us-atlas) (ISC), simplified with mapshaper.
- Map tiles: © OpenStreetMap contributors, © CARTO.

## Testing

```bash
pip install -r requirements-dev.txt
```

```bash
pytest
```
