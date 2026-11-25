# Costco Gas Prices

A live-updating map of Costco gas prices across the US. A scheduled scraper collects prices, stores them in Cloudflare R2, and a static site on Cloudflare Pages displays them. There's no backend server to run.

**Live site:** [https://costco-gas.pages.dev](https://costco-gas.pages.dev)

![Cloudflare Pages](https://img.shields.io/badge/hosted%20on-Cloudflare%20Pages-orange)
![Python](https://img.shields.io/badge/scraper-Python%203.11-blue)

## Features

- 📍 Interactive Leaflet map of every Costco warehouse with a gas station; stations cluster into bubbles when zoomed far out, become individual pins as you zoom in, then price pills
- 🎨 Optional price colours: green, amber and red pins for the cheapest, middle and most expensive third of the prices in view
- 🧭 One-tap **Directions** to any station (Google Maps, Apple Maps or Waze)
- ⛽ Regular / Premium / Diesel toggle (Diesel shows only stations that sell it); station cards lead with the selected grade's price
- 🕒 Live "Open / Closing soon / Closed" status in each station's local time zone, plus 7-day gas hours
- 🛣️ **Route**: cheapest stations within a set distance of a driving route (OSRM, with a straight-line fallback)
- ★ **Favorites**: save stations and routes in your browser
- 🔍 Search by city, address or zip code (store matches plus Nominatim geocoding)
- 📈 Price-history chart per station with 7D / 30D / 90D / 1Y / All ranges
- 🥇 **Lowest**: a ranked state leaderboard, with 72-hour price trends shown as an arrow and the size of the move (`▼ 4¢`, `▲ 6¢`, `–`)
- 📍 **Nearby**: stations within a 5–100 mi radius (10 mi by default) of you, a searched place or the map centre, sorted by price or distance
- 🔗 Shareable links: `?store=STATE_City` opens a station, and `?tab=`, `?grade=` and `?state=` restore the view
- ⚠️ The "Updated … ago" label turns amber and says the prices may be out of date when no new prices have arrived for 4 hours (they normally update hourly)
- 📲 Installable to a phone or desktop home screen (web app manifest), and opens offline with the last prices it saw (service worker)
- 📴 **Offline mode**: a built-in US outline replaces the map background, the header says the prices are saved, Route and place search are hidden, and prices refresh by themselves when the connection returns
- ⚙️ Settings panel: clustering (on by default) and price colours (off by default), directions app (Google Maps, Apple Maps or Waze), light/dark/system theme, which tabs to show (All stations is hidden by default), start-up tab, and automatic location on/off. Settings are saved in the browser.
- 🌙 Light and dark themes with matching map tiles, following the system setting by default
- 📱 **iOS app** (`ios/`): a native SwiftUI version with the same features, reading the same data. See [`ios/README.md`](ios/README.md).
- ♿ Keyboard navigation with visible focus, 44px touch targets, reduced-motion support and text contrast that meets WCAG AA

## How it works

```
Cloudflare scheduled job (hourly) → GitHub Actions (fetch_prices.yml)
        │
        ▼
pipeline/r2_sync.py download   ← previous snapshots from R2 into data/snapshots/
pipeline/scraper.py 3          ← fetch prices from Costco, confirm price changes,
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
- **Cloudflare scraper (alternative):** `scraper/` is a Worker that does the same hourly scrape on Cloudflare's free plan, with no GitHub Actions involved. It starts in shadow mode, writing its own copies under `worker-test/`, so it can run next to the GitHub workflow until it's trusted. See [Cloudflare scraper](#cloudflare-scraper).

## Project structure

```
├── public/                     # Everything the browser loads (Cloudflare Pages output directory)
│   ├── index.html              # App shell
│   ├── styles.css              # Design tokens (colour, type, radius, shadow) + all styling, light/dark
│   ├── app.js                  # Entry point: starts the modules below in order (no logic of its own)
│   ├── js/
│   │   │   # Helpers (all but layout.js are pure and unit-tested in tests/frontend)
│   │   ├── prices.js           # Fuel grades, price parsing and formatting, trend arrows
│   │   ├── hours.js            # Gas hours and open / closed status in each station's time zone
│   │   ├── time.js             # Scraper timestamps and the "Updated … ago" wording
│   │   ├── geo.js              # Distances and route-corridor geometry
│   │   ├── stores.js           # Station records, search matching, addresses, directions links
│   │   ├── storage.js          # localStorage access that never throws
│   │   ├── layout.js           # Phone / tablet / desktop layout tiers
│   │   │   # State and URL
│   │   ├── state.js            # App state and saved preferences
│   │   ├── nav.js              # URL query state and Back-button handling for overlays
│   │   │   # Data
│   │   ├── data.js             # Loading prices and stores, quiet refreshes, the "Updated" label
│   │   ├── offline.js          # Offline mode, retries, service worker registration
│   │   ├── location.js         # Browser geolocation, IP-based state guess, "Near me"
│   │   │   # Map
│   │   ├── map.js              # Leaflet map, tiles, moving the map, location markers, offline outline
│   │   ├── markers.js          # Station pins: clustering, price colours, legend, popups
│   │   ├── map-interactions.js # Double-tap zoom, page-zoom lock, "Search this area", hover links
│   │   │   # Sidebar and panels
│   │   ├── tabs.js             # Tab switching and rendering the active tab
│   │   ├── lists.js            # Nearby, State lowest, All stations and Favorites lists
│   │   ├── routes.js           # Route tab: OSRM routing, corridor filtering, saved routes
│   │   ├── search.js           # Header search: autocomplete and Nominatim geocoding
│   │   ├── sheet.js            # Phone bottom sheet, tablet sidebar, station details card
│   │   ├── charts.js           # Price-history loading and Chart.js modal
│   │   ├── overlays.js         # History modal entries and matching the page to Back / Forward
│   │   ├── settings.js         # Settings panel
│   │   ├── preferences.js      # Theme and fuel-grade toggle
│   │   ├── station-actions.js  # Favorite and share buttons, opening ?store= links
│   │   │   # Markup and events
│   │   ├── components.js       # HTML for store cards, price tiles, saved-route cards
│   │   ├── icons.js            # Inline SVG icon set (used instead of emoji)
│   │   ├── dom.js              # HTML escaping, focus trap, toasts, debounce, reduced motion
│   │   └── events.js           # One delegated click and keydown listener for the whole page
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
├── scraper/                    # Hourly price scrape as a Cloudflare Worker (alternative to the Python job)
│   ├── index.js                # Cron, queue and HTTP handlers; settings
│   ├── run.js                  # The steps: start, chunk, verify, finalize; saving a snapshot
│   ├── history.js              # Appends to / reads the end of us_history.json without parsing all of it
│   ├── prices.js               # Safety rules ported from scraper.py (quorum, coverage, carry-forward)
│   ├── costco.js               # One request to Costco's gas-price endpoint
│   └── wrangler.jsonc          # Worker config: crons, queue, R2 binding, shadow-mode prefix
│
├── pipeline/                   # Python data pipeline
│   ├── scraper.py              # Store discovery, metadata, price scraping and snapshot saving
│   ├── r2_sync.py              # Download/upload snapshots, list and restore R2 backups
│   └── paths.py                # Central file locations used by the scripts
│
├── data/
│   ├── ca_stores.json          # California store list (used by option 2)
│   ├── local_stores.json       # Small nearby subset for quick local runs (option 1)
│   └── snapshots/              # Local copies of R2 snapshots (git-ignored)
│
├── ios/                        # Native iOS app (SwiftUI); see ios/README.md
│   ├── CostcoGas.xcodeproj     # Open in Xcode 16+ and press Run
│   ├── CostcoGasKit/           # Swift package: the public/js logic ported to Swift, with tests
│   └── CostcoGas/              # The app: map, lists, route, search, chart, settings
│
├── tests/                      # pytest suite for the pipeline
│   ├── frontend/               # node --test unit tests for public/js and the CDN hashes
│   ├── scraper/                # node --test tests for scraper/ (fake R2, queue and Costco)
│   └── e2e/                    # Playwright browser tests (stubbed data and services)
├── .github/workflows/
│   ├── fetch_prices.yml        # Scheduled price scrape (R2 download → scrape → upload)
│   ├── discover.yml            # Weekly new-store discovery; opens a PR
│   ├── seed_r2.yml             # Manual R2 connection test
│   ├── testing.yml             # Runs the pipeline and frontend tests on pushes and PRs to main
│   └── ios.yml                 # Tests CostcoGasKit and builds the iOS app (macOS runner) when ios/ changes
├── .github/dependabot.yml      # Weekly upgrade PRs for pip, npm and Actions
├── requirements.txt            # Pipeline dependencies (pinned)
├── requirements-dev.txt        # + pytest
├── package.json                # Frontend test and lint tooling, and the pinned CDN library versions
├── eslint.config.mjs           # Lint rules (undefined names, unused imports)
├── playwright.config.mjs       # Browser test config
└── pytest.ini
```

The pipeline scripts resolve their paths from `pipeline/paths.py`, so they can be run from any directory.

## Frontend design

The frontend is plain HTML, CSS and ES modules with no build step.

- **Design tokens:** every colour, radius, shadow and type size is a CSS variable defined at the top of `public/styles.css`, with a light set on `:root` and a dark set on `body.dark-mode`. Change a token rather than a component when adjusting the look.
- **Modules:** each file in `public/js/` owns one part of the page (listed above). Modules import what they need directly, cycles included, so a module's top level must only declare things: all start-up calls live in `app.js`. `npm run lint` catches a missing or misspelled import, and button behaviour is wired through the `ACTIONS` table in `events.js` (`data-action="name"` in the markup).
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

With no file names, `download` and `upload` handle all US, CA and local snapshots.

### Built-in safety checks

- **Price-change confirmation:** any price change is re-fetched with cache-busting until a quorum of samples agrees; unconfirmed changes revert to the last known price.
- **Snapshot validation:** a run is only saved if at least 85% of states and 75% of stores returned prices.
- **No automatic store deletion:** stores that return no prices are listed in the run log but stay in the store list. Removing a store is a manual edit.
- **Full-rebuild guard:** option `5` won't overwrite `public/us_stores.json` if the new list is more than 25% smaller.

## Cloudflare scraper

`scraper/` runs the hourly scrape inside Cloudflare's free plan instead of GitHub Actions. A free-plan Worker may use 10 ms of CPU and make 50 outbound requests per run, so the work is split up:

```
cron :00  start     read us_latest.json, split the stores into chunks of 20, queue one message each
queue     chunk     fetch each store once (retrying failures); changed stores go to a verify message
queue     verify    re-fetch changed stores until 3 readings agree, else keep the old price
last step finalize  merge results → coverage check → carry forward → append history → write latest
cron :10  backstop  finalize now if a step failed or got stuck (otherwise nothing to do)
```

Results between steps live in R2 under `runs/us/` and are deleted after each run. The history file is several MB, too big to parse in 10 ms, so `history.js` checks the last entry is intact, then streams the existing bytes plus the new entry back to R2 (a conditional put, so overlapping runs can't drop each other's entries). The 72-hour trend baseline is moved forward from the one saved in `us_latest.json`, using the few history entries in between. The safety checks listed above all apply.

The chunk or verify step that finishes last sees that every result is in (one R2 list of the run's files) and saves the run straight away, normally about two minutes after :00. It claims the run first with a conditional write to `runs/us/current.json`, so it can't be saved twice. If a step fails or never finishes, the :10 cron saves the run with what arrived, and the missing stores are handled by the coverage check and carry-forward (a changed store that wasn't re-checked keeps its old price).

It uses a Cloudflare Queue (free plan: 10,000 operations a day, about 2,500 used), two cron triggers (free plan: 5 per account) and the existing R2 bucket (about 80 writes and lists a run, roughly 56,000 a month of the free 1,000,000). The store list is bundled in at deploy time, so redeploy after `us_stores.json` changes (or connect the Worker to Workers Builds so every push deploys it).

**Set up (once):**

```bash
npx wrangler queues create costco-gas-scrape
```

```bash
npx wrangler deploy -c scraper/wrangler.jsonc
```

Then open `https://costco-gas-scrape.<your-subdomain>.workers.dev/probe`. It fetches six stores and reports whether Costco answers requests from Cloudflare. If it says they're blocked, stop here: this approach won't work, and the GitHub workflow carries on as before.

**Shadow mode:** with `WRITE_PREFIX` set to `worker-test/` (the default), the Worker copies the live files once, then keeps its own `worker-test/us_latest.json` and `worker-test/us_history.json`, and never writes the live ones. Compare them with the live files over a few days. The site serves them at `/worker-test/us_latest.json`. Each run logs a summary (stores fetched, HTTP statuses, confirmed changes, rejections) under the Worker's **Logs** in the Cloudflare dashboard. `/status` shows the mode and any run in progress.

**Switching over:**

1. Turn off the Cloudflare scheduled job that starts `fetch_prices.yml`. Two scrapers must never write the live files at once.
2. Set `"WRITE_PREFIX": ""` and `"ENABLE_PROBE": "0"` in `scraper/wrangler.jsonc`, then redeploy. The first live run reads the existing `us_latest.json` and `us_history.json`.
3. Keep `fetch_prices.yml`. Starting it by hand from the Actions tab is the fallback while the Worker is off.

To go back, set the prefix to `worker-test/` again (or remove the cron triggers), redeploy, and turn the GitHub scheduled job back on.

To run a step without waiting for the cron, set a secret with `npx wrangler secret put RUN_TOKEN -c scraper/wrangler.jsonc`, then `POST /run?step=start` (or `step=finalize`) with `Authorization: Bearer <token>`.

Weekly store discovery stays on GitHub Actions (`discover.yml`): it opens a pull request, which needs the repo.

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

Both suites run in GitHub Actions on every push and pull request to `main` (`testing.yml`).

**Pipeline** (pytest):

```bash
pip install -r requirements-dev.txt
```

```bash
pytest
```

**Frontend** (Node 22). The site itself has no build step or npm dependencies; `package.json` only holds the test tooling.

```bash
npm ci
```

```bash
npm run lint         # ESLint: undefined names and unused imports across the modules
```

```bash
npm run test:unit    # node --test: helpers in public/js, URL/settings state, CDN integrity hashes, scraper/
```

```bash
npx playwright install chromium
```

```bash
npm run test:e2e     # Playwright: the real page on desktop and phone sizes
```

The browser tests serve `public/` locally and stub everything else (price snapshots built from `us_stores.json`, CDN libraries served from `node_modules`, map tiles, geocoding), so they need no network or R2 access.

## Dependencies

- **Python:** `requirements.txt` pins exact versions. Dependabot (`.github/dependabot.yml`) opens a grouped upgrade PR weekly, and the tests run on it.
- **CDN libraries:** Leaflet, Leaflet.markercluster, Chart.js and its date adapter load from jsDelivr/unpkg at pinned versions with [Subresource Integrity](https://developer.mozilla.org/docs/Web/Security/Subresource_Integrity) hashes, so the browser refuses a file that doesn't match. The same versions are devDependencies in `package.json`, and `tests/frontend/cdn-integrity.test.mjs` checks each hash against the npm package. To upgrade one: bump it in `package.json`, run `npm install`, change the version in the `index.html` URL, and paste the hash the failing test prints.
- **Cloudflare Pages:** with a `package.json` at the root, Pages may install these test dependencies before deploying. The site doesn't use them; set the `SKIP_DEPENDENCY_INSTALL` environment variable on the Pages project to skip the install.
