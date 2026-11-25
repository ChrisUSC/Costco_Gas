# Costco Gas Prices

A map of Costco gas prices across the US. A Python scraper runs hourly in GitHub Actions and
stores price snapshots in Cloudflare R2; a static site in `public/` displays them. There is no
backend server and no frontend build step. `README.md` has the full feature list, data formats
and deployment settings.

## Layout

- `public/` — the site: `index.html`, `styles.css`, `app.js` (entry point, start-up calls only),
  `js/*.js` (one ES module per part of the page), `sw.js` (offline support), `us_stores.json`
  (the store list, in git).
- `pipeline/` — `scraper.py` (store discovery, price scraping, snapshot saving), `r2_sync.py`
  (download/upload/backup against R2), `paths.py` (all file locations).
- `functions/_middleware.js`, `worker.js`, `r2_snapshots.js` — serve `*_latest.json` and
  `*_history.json` from R2. Both the Pages project and the Worker deploy on every push.
- `scraper/` — the same hourly scrape as a Cloudflare Worker on the free plan (cron + Queue,
  deployed with `npx wrangler deploy -c scraper/wrangler.jsonc`). `WRITE_PREFIX` in its
  `wrangler.jsonc` decides whether it writes the live files or shadow copies under a prefix.
- `tests/` — pytest for the pipeline; `tests/frontend/` (node --test) and `tests/e2e/`
  (Playwright) for the site; `tests/scraper/` (node --test) for the Worker scraper.
- `ios/` — native SwiftUI app with the site's features. `ios/CostcoGasKit/` is a Swift package
  porting the logic in `public/js` (prices, hours, time, geo, stores, lists, history) with the
  same test cases; `ios/CostcoGas/` is the app. The Xcode project is generated from
  `ios/project.yml` with XcodeGen and isn't in git. `ios/README.md` has the details.
- `data/` — `ca_stores.json` and `local_stores.json` for manual scraper runs (options 1 and 2);
  `data/snapshots/` is git-ignored.

Price data never goes in git. It lives in R2.

## Commands

```bash
pip install -r requirements-dev.txt && pytest     # pipeline tests
npm ci                                            # frontend test tooling
npm run lint                                      # ESLint
npm run test:unit                                 # node --test
npm run test:e2e                                  # Playwright (desktop + phone)
python pipeline/scraper.py 3                      # what the hourly job runs (hits costco.com)
cd ios/CostcoGasKit && swift test                 # iOS logic tests (macOS)
cd ios && xcodegen generate                       # make CostcoGas.xcodeproj
```

Run pytest for pipeline changes and lint, unit and e2e for frontend changes before committing.
CI (`testing.yml`) runs all of them on pushes and PRs to `main`.

If Playwright's pinned browser isn't installed and `npx playwright install chromium` isn't an
option, point a temporary config at an existing Chromium with
`use.launchOptions.executablePath`; don't commit it.

## Frontend conventions

- Plain HTML, CSS and ES modules. No bundler, no framework, no npm runtime dependencies.
  Leaflet and Chart.js load from a CDN with integrity hashes; their versions are pinned in
  `package.json` and checked by `tests/frontend/cdn-integrity.test.mjs`.
- Modules import each other directly, cycles included, so a module's top level may only
  declare things. Start-up calls go in `public/app.js`.
- Buttons use `data-action="name"` and a handler in the `ACTIONS` table in `js/events.js`.
  Don't add per-element click listeners.
- Colours, radii, shadows and type sizes are CSS variables at the top of `styles.css` (light on
  `:root`, dark on `body.dark-mode`). Change a token, not a component.
- Icons come from `icon('name', size)` in `js/icons.js`, not emoji. Icon-only buttons need an
  `aria-label`.
- Escape anything interpolated into HTML with `escapeHtml` from `js/dom.js`.
- Use `storageGet` / `storageSet` from `js/storage.js`, never `localStorage` directly.
- Layout tiers: phone ≤ 599px, tablet 600–1099px, desktop ≥ 1100px. The widths in
  `js/layout.js` must match the media queries in `styles.css`.
- When adding a file the page loads, add it to `APP_FILES` in `public/sw.js`
  (`tests/test_service_worker.py` enforces this) and bump `CACHE_VERSION` when cached files
  should be dropped.
- Export only what another module or a test imports.

## Pipeline conventions

- Python 3.11 in CI. Dependencies are pinned exactly in `requirements.txt`; Dependabot
  proposes upgrades.
- Get file locations from `pipeline/paths.py`; don't build paths by hand.
- Price arrays are `[regular, premium, diesel]`, with `null` for a grade not sold. History is
  change-only after the first full snapshot. Timestamps are Pacific wall-clock time.
- Safety checks to preserve: every price change is re-fetched until a quorum agrees, and an
  unconfirmed change reverts to the last known price; a snapshot is saved only with ≥ 85% of
  states and ≥ 75% of stores; stores are never deleted automatically; an unreadable history
  file stops the save instead of being overwritten.
- Write JSON through `atomic_write_json` or `write_pretty_top_level` so a crash can't truncate
  a file.
- Tests must not hit the network; mock `create_session` or `get_gas_prices_ajax`.

## Workflow

- Give branches short descriptive names (for example `claude/scraper-remove-jump-mode`), not
  generated ones.
- Squash-merge pull requests.
- Keep `README.md` in step with the code: the project-structure tree, the scraper options
  table and the safety-check list.
- `fetch_prices.yml` is started hourly by a scheduled job on Cloudflare and must only touch
  `us_latest.json` and `us_history.json`.
- Only one scraper may write the live `us_latest.json` / `us_history.json`: either the GitHub
  workflow (started by the Cloudflare scheduled job) or `scraper/` with an empty `WRITE_PREFIX`.
- `ios/CostcoGasKit` mirrors the display rules in `public/js` (price formats, trends, open
  status, the 4-hour stale threshold, list sorting, history series). Change both together;
  `ios.yml` runs its tests and builds the app on a macOS runner when `ios/` changes.
- `scraper/` mirrors the safety checks in `pipeline/scraper.py`; change both together. Each
  Worker invocation must stay within the free plan's 10 ms CPU and 50 outbound requests, so
  never parse the whole history file there.
