# Costco Gas for iOS

A native SwiftUI app with the same features as the website. It reads the same files from
`https://costco-gas.pages.dev` (`us_latest.json`, `us_history.json`, `us_stores.json`), so
there's nothing extra to deploy: whatever the hourly scraper saves shows up in the app.

Requires iOS 17 and Xcode 16 or later.

## Running it

Open `ios/CostcoGas.xcodeproj` in Xcode, pick an iPhone simulator and press Run.

### On your iPhone, in one command

Plug in the phone (unlocked, Developer Mode on), then:

```bash
ios/run-on-phone.sh
```

It pulls the latest code, builds, installs and opens the app. `--no-pull` skips the pull. The
first run asks for your bundle identifier, finds your team from your Apple Development
certificate, and saves both in `ios/Local.xcconfig`. That file is git-ignored, so pulls never
conflict with your signing settings. Set signing there (see `ios/Signing.xcconfig`), not in
Xcode's Signing & Capabilities tab, which edits the project file.

With a free Apple ID the app stops opening after 7 days; run the script again to reinstall.

The project uses Xcode 16's folder-synced groups: any file added under `ios/CostcoGas/` is part
of the app automatically. Info.plist keys are build settings on the target, apart from URL
types and quick actions, which are in `ios/Info.plist`.

## Tests

```bash
cd ios/CostcoGasKit && swift test
```

`CostcoGasKit` holds all the logic that has no UI, ported from `public/js`, with the same test
cases as `tests/frontend/helpers.test.mjs`. CI (`.github/workflows/ios.yml`) runs these tests
and builds the app for the simulator on every push that touches `ios/`.

## Features, and where they live

| Feature | Website | iOS |
|---|---|---|
| Map with clustering, dots, then price pills; price colours with a legend | `map.js`, `markers.js` | `Map/StationMapView.swift`, `Map/AnnotationViews.swift` |
| Regular / Premium / Diesel (Diesel shows only stations selling it) | `preferences.js` | `PanelView.swift`, `StationQueries.forGrade` |
| Nearby (5–100 mi, price or distance) | `lists.js` | `StationListsView.swift` |
| State lowest leaderboard with 72-hour trends | `lists.js`, `prices.js` | `StationListsView.swift`, `Trend` |
| Route: OSRM with a straight-line fallback, detour limit, saved and edited routes, "Your location" | `routes.js` | `RouteView.swift`, `RouteService` |
| Favorites: stations and routes | `state.js` | `Preferences.swift` |
| Search: stations plus Nominatim places | `search.js` | `SearchResultsView.swift`, `Geocoder` |
| Station details: prices, open status in the station's time zone, 7-day hours, phone, share | `sheet.js`, `hours.js` | `StationDetailView.swift`, `GasHours` |
| Directions in Google Maps, Apple Maps or Waze | `stores.js` | `directionsURL` |
| Price-history chart, 7D / 30D / 90D / 1Y / All | `charts.js` | `PriceHistoryView.swift` (Swift Charts), `PriceHistory` |
| "Updated … ago", amber after 4 hours | `time.js`, `data.js` | `UpdatedLabel`, `ScraperTime` |
| Offline: last prices and history saved on the device, Route and place search hidden, refresh when the connection returns | `sw.js`, `offline.js` | `SnapshotClient`, `AppModel` |
| Settings: clustering, price colours, directions app, theme, visible tabs, start-up tab and grade, automatic location | `settings.js` | `SettingsView.swift` |
| Shared links `?store=`, `?tab=`, `?grade=`, `?state=` | `nav.js`, `station-actions.js` | `DeepLink` (also `costcogas://open?store=CA_Turlock`) |
| Home-screen shortcuts | `manifest.webmanifest` | Quick actions in `Info.plist` |
| Phone bottom sheet, tablet sidebar | `sheet.js`, `layout.js` | `ContentView.swift` |

Differences from the website:

- Offline, the map still uses Apple Maps tiles: areas you've already viewed stay cached, but
  the built-in US outline the website shows isn't used.
- Shared links point at the website. They open in the app only after Universal Links are set
  up, which needs your Apple Team ID in `public/.well-known/apple-app-site-association` and
  the Associated Domains capability (`applinks:costco-gas.pages.dev`). Until then,
  `costcogas://` links open the app.

## Layout

```
ios/
├── CostcoGas.xcodeproj         # Open this in Xcode
├── Info.plist                  # URL scheme and quick actions (other keys are build settings)
├── Signing.xcconfig            # Bundle ID and team defaults; yours go in Local.xcconfig (git-ignored)
├── run-on-phone.sh             # Pull, build, install and open on a connected iPhone
├── CostcoGasKit/               # Swift package, Foundation only (runs with `swift test`)
│   ├── Sources/CostcoGasKit/
│   │   ├── Prices.swift        # Grades, price parsing and formatting, trends   (prices.js)
│   │   ├── GasHours.swift      # Open / closing soon / closed, grouped hours      (hours.js)
│   │   ├── ScraperTime.swift   # Pacific timestamps, "Updated … ago"              (time.js)
│   │   ├── Geo.swift           # Distances and route-corridor geometry            (geo.js)
│   │   ├── Stations.swift      # Store list, snapshots, addresses, directions     (stores.js)
│   │   ├── Queries.swift       # List sorting and price colours        (lists.js, markers.js)
│   │   ├── PriceHistory.swift  # History parsing and daily chart series           (charts.js)
│   │   ├── Services.swift      # Snapshot fetch + saved copy, OSRM, Nominatim, IP state
│   │   └── DeepLink.swift      # ?store= / ?tab= / ?grade= / ?state= links        (nav.js)
│   └── Tests/                  # The cases from tests/frontend/helpers.test.mjs
└── CostcoGas/                  # The app (SwiftUI, MapKit, Swift Charts)
    ├── CostcoGasApp.swift      # Entry point, quick actions
    ├── AppModel.swift          # Shared state and every action (state.js + data.js)
    ├── Preferences.swift       # Settings and favorites in UserDefaults
    ├── LocationService.swift   # Core Location as async calls
    ├── Theme.swift             # Colours, tabs, theme choices
    ├── Map/                    # MKMapView wrapper and pin / cluster views
    └── Views/                  # Panel, lists, route, search, details, chart, settings
```

The Kit mirrors `public/js`: when you change a rule there (a price format, the stale-price
threshold, how lists sort), change it here too and keep the tests in step.
