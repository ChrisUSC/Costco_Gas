import CostcoGasKit
import Foundation
import Network
import Observation

enum LoadState: Equatable {
    case loading, ready, failed
}

enum HistoryLoadState: Equatable {
    case idle, loading, ready, failed
}

/// A route search and its result (the website's state.lastRouteState).
struct RouteResult: Equatable {
    var originText: String
    var destText: String
    var bufferMiles: Double
    var origin: Place
    var destination: Place
    var route: DrivingRoute
    var along: [StationDistance]
}

/// Something for the map to do once: move to a place, or fit points into view.
struct MapRequest: Equatable {
    enum Command: Equatable {
        case center(LatLng, spanDegrees: Double)
        case fit([LatLng])
    }
    let id = UUID()
    let command: Command
}

/// Everything the screens share: the prices, what's selected, and the actions behind every
/// button. The equivalent of public/js/state.js plus the module functions that change it.
@MainActor
@Observable
final class AppModel {
    let prefs = Preferences()
    let location = LocationService()
    private let client = SnapshotClient()
    private let pathMonitor = NWPathMonitor()
    @ObservationIgnored private var directory: StoreDirectory?
    @ObservationIgnored private var refreshing = false
    @ObservationIgnored private var lastRefresh = Date.distantPast
    @ObservationIgnored private var pendingLink: DeepLink?
    @ObservationIgnored private var originLookupTried = false
    @ObservationIgnored private var originPrefilled = false
    @ObservationIgnored private var editSnapshot: (result: RouteResult?, origin: Place?, dest: Place?, originText: String, destText: String, buffer: Double)?
    @ObservationIgnored private var networkIsConstrained = false
    @ObservationIgnored private var networkWasOnline = true

    // Prices
    private(set) var stations: [Station] = []
    @ObservationIgnored private var stationsByID: [String: Station] = [:]
    private(set) var latestTimestamp: String?
    private(set) var trendBaselineLabel = "the last update"
    private(set) var loadState: LoadState = .loading
    /// Showing saved prices: no connection, or the network couldn't be reached.
    private(set) var offline = false
    /// Ticks every minute so "Updated … ago" and open / closed labels stay current.
    var now = Date()

    // What's on screen
    var currentTab: AppTab
    var grade: Grade
    var stateContext = "CA"
    /// Where the Nearby list is centred: the device, a searched place or the map centre.
    var nearbyCenter: LatLng?
    var searchedPlace: Place?
    var deviceLocation: LatLng?
    var selectedStation: Station?
    var historyStation: Station?
    var showSettings = false
    var toast: String?
    var mapRequest: MapRequest?
    var mapCenter: LatLng?
    var mapSpanDegrees: Double = 60
    var legend: PriceTierScale?

    // Route tab
    var routeOriginText = ""
    var routeDestText = ""
    var routeBuffer: Double = 2
    var routeOrigin: Place?
    var routeDest: Place?
    private(set) var routeResult: RouteResult?
    private(set) var routeBusy = false
    var routeError: String?
    private(set) var editingRouteID: Int64?

    // Price history
    private(set) var history: PriceHistory?
    private(set) var historyLoad: HistoryLoadState = .idle

    init() {
        currentTab = .nearby
        grade = .regular
        currentTab = prefs.defaultTab
        grade = prefs.initialGrade
    }

    // MARK: - Loading prices

    func station(withID id: String) -> Station? { stationsByID[id] }

    /// Tabs shown in the tab strip. Route needs a connection, so it's hidden offline.
    var visibleTabs: [AppTab] {
        let tabs = prefs.visibleTabs.filter { !(offline && $0 == .route) }
        return tabs.isEmpty ? [.nearby] : tabs
    }

    /// Stations the map shows: the route's stations while a route is on screen, else all;
    /// Diesel shows only stations that sell it.
    var mapStations: [Station] {
        let base: [Station]
        if currentTab == .route, let along = routeResult?.along, !along.isEmpty {
            base = along.map(\.station)
        } else {
            base = stations
        }
        return StationQueries.forGrade(base, grade)
    }

    var updatedLabel: ScraperTime.UpdatedLabel { ScraperTime.updatedLabel(latestTimestamp, now: now) }

    func start() async {
        startNetworkMonitor()
        await load()
    }

    /// First load: prices and the store list together (the bundled store list if both the
    /// network and the saved copy fail), plus the location if access is already allowed.
    func load() async {
        loadState = .loading
        let cacheBuster = String(Int(Date().timeIntervalSince1970 * 1000))
        let bundledStores = Bundle.main.url(forResource: "us_stores", withExtension: "json")
        let client = self.client
        async let latestFetch = client.fetch("us_latest.json", cacheBuster: cacheBuster)
        async let storesFetch = client.fetch("us_stores.json", cacheBuster: cacheBuster, fallback: bundledStores)
        let autoLocate = prefs.autoLocate
        async let ipState = AppModel.guessState(enabled: autoLocate)
        var autoLocation: LatLng?
        if autoLocate { autoLocation = await location.currentIfAuthorized() }

        do {
            let latest = try await latestFetch
            let stores = try await storesFetch
            let snapshot = try PriceSnapshot(data: latest.data)
            let directory = try StoreDirectory(data: stores.data)
            if !latest.fromSavedCopy { client.save(latest.data, as: "us_latest.json") }
            if !stores.fromSavedCopy { client.save(stores.data, as: "us_stores.json") }
            self.directory = directory
            apply(snapshot)
            offline = latest.fromSavedCopy
            lastRefresh = Date()
            if !visibleTabs.contains(currentTab) { currentTab = visibleTabs[0] }
            loadState = .ready

            if let state = await ipState { stateContext = state }
            if let autoLocation {
                deviceLocation = autoLocation
                nearbyCenter = autoLocation
                stateContext = StationQueries.closestState(to: autoLocation, in: stations) ?? stateContext
            }
            let opened = applyPendingLink()
            if !opened {
                if let autoLocation {
                    mapRequest = MapRequest(command: .center(autoLocation, spanDegrees: 0.6))
                } else {
                    mapRequest = MapRequest(command: .fit(stations.compactMap(\.coordinate)))
                }
            }
            if !offline { prefetchHistoryIfDue() }
        } catch {
            loadState = .failed
        }
    }

    private nonisolated static func guessState(enabled: Bool) async -> String? {
        guard enabled else { return nil }
        return await IPRegion.guessState()
    }

    private func apply(_ snapshot: PriceSnapshot) {
        trendBaselineLabel = ScraperTime.relativeLabel(snapshot.previousTimestamp)
        latestTimestamp = snapshot.timestamp
        if let directory {
            stations = buildStations(snapshot: snapshot, directory: directory)
            stationsByID = Dictionary(stations.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        }
        now = Date()
    }

    /// Fresh prices without disturbing the screen: the map stays put, the open station stays
    /// open, and the lists re-sort with the new prices.
    func refresh() async {
        switch loadState {
        case .loading: return
        case .failed: await load(); return
        case .ready: break
        }
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        do {
            let data = try await client.fetchFromNetwork("us_latest.json", cacheBuster: String(Int(Date().timeIntervalSince1970 * 1000)))
            let snapshot = try PriceSnapshot(data: data)
            client.save(data, as: "us_latest.json")
            apply(snapshot)
            lastRefresh = Date()
            history = nil
            historyLoad = .idle
            // Route results and the open station hold copies of stations: give them the new prices.
            if var result = routeResult {
                result.along = result.along.compactMap { item in
                    station(withID: item.id).map { StationDistance(station: $0, distance: item.distance) }
                }
                routeResult = result
            }
            if let open = selectedStation { selectedStation = station(withID: open.id) }
            offline = false
            prefetchHistoryIfDue()
        } catch {
            offline = true
        }
        if !visibleTabs.contains(currentTab) { currentTab = visibleTabs[0] }
    }

    /// Coming back to the app: refresh if the prices are more than a few minutes old.
    func refreshIfStale() async {
        if Date().timeIntervalSince(lastRefresh) > 5 * 60 { await refresh() }
    }

    private func startNetworkMonitor() {
        pathMonitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            let constrained = path.isConstrained || path.isExpensive
            Task { @MainActor in self?.networkChanged(online: online, constrained: constrained) }
        }
        pathMonitor.start(queue: DispatchQueue(label: "costcogas.network"))
    }

    private func networkChanged(online: Bool, constrained: Bool) {
        networkIsConstrained = constrained
        let cameBack = online && !networkWasOnline
        networkWasOnline = online
        if !online && loadState == .ready { offline = true }
        if cameBack { Task { await refresh() } }
    }

    // MARK: - Price history

    /// Keeps the saved price history fresh for offline charts: at most once a day, and not on
    /// Low Data Mode or cellular-hotspot connections.
    private func prefetchHistoryIfDue() {
        guard !networkIsConstrained else { return }
        if let saved = client.savedCopyDate("us_history.json"), Date().timeIntervalSince(saved) < 24 * 3600 { return }
        let client = self.client
        let version = latestTimestamp ?? String(Int(Date().timeIntervalSince1970))
        Task.detached(priority: .background) {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            if let data = try? await client.fetchFromNetwork("us_history.json", cacheBuster: version, timeout: 60),
               (try? JSONSerialization.jsonObject(with: data)) != nil {
                client.save(data, as: "us_history.json")
            }
        }
    }

    func loadHistory() async {
        guard history == nil, historyLoad != .loading else { return }
        historyLoad = .loading
        do {
            let result = try await client.fetch("us_history.json", cacheBuster: latestTimestamp ?? String(Int(Date().timeIntervalSince1970)))
            let data = result.data
            let parsed = try await Task.detached(priority: .userInitiated) { try PriceHistory(data: data) }.value
            if !result.fromSavedCopy { client.save(data, as: "us_history.json") }
            history = parsed
            historyLoad = .ready
        } catch {
            historyLoad = .failed
        }
    }

    func historySeries(for station: Station) -> [DailyPrice] {
        guard let history else { return [] }
        let end = ScraperTime.parse(latestTimestamp) ?? Date()
        return PriceHistory.dailySeries(history.points(for: station.id), rangeDays: prefs.historyRange.rawValue, now: max(end, Date()))
    }

    // MARK: - Choices

    func setGrade(_ newGrade: Grade) {
        grade = newGrade
        prefs.lastGrade = newGrade
    }

    func show(_ station: Station) {
        selectedStation = station
        if let c = station.coordinate { mapRequest = MapRequest(command: .center(c, spanDegrees: 0.05)) }
    }

    func showToast(_ message: String) {
        toast = message
    }

    func toggleFavorite(_ station: Station) {
        let added = prefs.toggleFavorite(station)
        showToast(added ? "★ Added to favorites" : "Removed from favorites")
    }

    /// "Near me": ask for the location, then centre the Nearby list and the map on it.
    func findMe() async {
        do {
            let here = try await location.requestLocation()
            deviceLocation = here
            nearbyCenter = here
            searchedPlace = nil
            selectedStation = nil
            stateContext = StationQueries.closestState(to: here, in: stations) ?? stateContext
            mapRequest = MapRequest(command: .center(here, spanDegrees: 0.6))
            if visibleTabs.contains(.nearby) { currentTab = .nearby }
        } catch {
            showToast(error.localizedDescription)
        }
    }

    /// A place picked from search: the Nearby list centres on it.
    func showPlace(_ place: Place) {
        nearbyCenter = place.coordinate
        searchedPlace = place
        selectedStation = nil
        stateContext = StationQueries.closestState(to: place.coordinate, in: stations) ?? stateContext
        mapRequest = MapRequest(command: .center(place.coordinate, spanDegrees: 0.4))
        if visibleTabs.contains(.nearby) { currentTab = .nearby }
    }

    /// "Search this area": the Nearby list centres on the map.
    func searchMapArea() {
        guard let mapCenter else { return }
        nearbyCenter = mapCenter
        searchedPlace = nil
        if visibleTabs.contains(.nearby) { currentTab = .nearby }
    }

    /// Show the button when the map has moved well away from where the Nearby list is centred.
    var showSearchThisArea: Bool {
        guard currentTab == .nearby, loadState == .ready, let mapCenter, mapSpanDegrees < 4 else { return false }
        guard let center = nearbyCenter else { return true }
        return distanceMiles(center, mapCenter) > max(2, prefs.nearbyRadius / 2)
    }

    /// The map in view, for search results that prefer nearby places.
    var mapViewbox: GeoBounds? {
        guard let c = mapCenter else { return nil }
        let half = mapSpanDegrees / 2
        return GeoBounds(minLat: c.lat - half, maxLat: c.lat + half, minLng: c.lng - half, maxLng: c.lng + half)
    }

    // MARK: - Links and quick actions

    func handle(_ link: DeepLink) {
        if let g = link.grade { grade = g }
        if let name = link.tab, let tab = AppTab(rawValue: name), visibleTabs.contains(tab) { currentTab = tab }
        if let state = link.state { stateContext = state }
        if link.storeKey != nil {
            pendingLink = link
            if loadState == .ready { _ = applyPendingLink() }
        }
    }

    func openTab(_ tab: AppTab) {
        if visibleTabs.contains(tab) { currentTab = tab }
    }

    /// Opens a shared ?store= station once the data has loaded.
    private func applyPendingLink() -> Bool {
        guard let key = pendingLink?.storeKey else { return false }
        pendingLink = nil
        guard let station = station(withID: key) else {
            showToast("That station couldn't be found")
            return false
        }
        show(station)
        return true
    }

    // MARK: - Route tab

    /// An empty "From" starts as "Your location" when location access is already allowed.
    /// Tried once per launch; clearing the field sticks.
    func prefillRouteOrigin() async {
        guard !originPrefilled, prefs.autoLocate, routeOriginIsEmpty else { return }
        var here = deviceLocation
        if !originLookupTried {
            originLookupTried = true
            here = await location.currentIfAuthorized(maxAge: 60) ?? deviceLocation
        }
        guard let here, routeOriginIsEmpty, currentTab == .route else { return }
        deviceLocation = here
        originPrefilled = true
        routeOrigin = Place(here, label: Place.yourLocationLabel)
        routeOriginText = Place.yourLocationLabel
    }

    private var routeOriginIsEmpty: Bool {
        routeOriginText.trimmingCharacters(in: .whitespaces).isEmpty && routeOrigin == nil && routeResult == nil
    }

    func useMyLocationForRoute() async {
        do {
            let here = try await location.requestLocation()
            deviceLocation = here
            routeOrigin = Place(here, label: Place.yourLocationLabel)
            routeOriginText = Place.yourLocationLabel
        } catch {
            showToast(error.localizedDescription)
        }
    }

    func findRoute() async {
        let originText = routeOriginText.trimmingCharacters(in: .whitespaces)
        let destText = routeDestText.trimmingCharacters(in: .whitespaces)
        guard !originText.isEmpty, !destText.isEmpty else {
            routeError = "Enter both a starting point and a destination."
            return
        }
        guard routeBuffer > 0 else {
            routeError = "Enter a valid search distance greater than 0."
            return
        }
        routeBusy = true
        routeError = nil
        defer { routeBusy = false }

        let origin: Place?
        if let known = routeOrigin, known.label.lowercased() == originText.lowercased() {
            origin = known
        } else {
            origin = await Geocoder.geocode(originText, viewbox: mapViewbox)
        }
        let destination: Place?
        if let known = routeDest, known.label.lowercased() == destText.lowercased() {
            destination = known
        } else {
            destination = await Geocoder.geocode(destText, viewbox: mapViewbox)
        }
        guard let origin else {
            routeError = "Couldn't find \"\(originText)\". Try a more specific address or city."
            return
        }
        guard let destination else {
            routeError = "Couldn't find \"\(destText)\". Try a more specific address or city."
            return
        }

        let route = await RouteService.drivingRoute(from: origin.coordinate, to: destination.coordinate)
        let along = StationQueries.along(route: route.coords, stations: stations, bufferMiles: routeBuffer)
        routeOrigin = origin
        routeDest = destination
        routeResult = RouteResult(originText: originText, destText: destText, bufferMiles: routeBuffer,
                                  origin: origin, destination: destination, route: route, along: along)
        if currentTab == .route { showRouteOnMap() }
    }

    func showRouteOnMap() {
        guard let route = routeResult?.route else { return }
        mapRequest = MapRequest(command: .fit(route.coords))
    }

    func saveRoute() {
        guard let result = routeResult else { return }
        let candidate = SavedRoute(id: Int64(Date().timeIntervalSince1970 * 1000), origin: result.origin,
                                   destination: result.destination, bufferMiles: result.bufferMiles)
        if let editing = editingRouteID, let index = prefs.favoriteRoutes.firstIndex(where: { $0.id == editing }) {
            if prefs.favoriteRoutes.contains(where: { $0.id != editing && $0.sameRoute(as: candidate) }) {
                showToast("Another saved route already matches these values")
                return
            }
            prefs.favoriteRoutes[index].origin = candidate.origin
            prefs.favoriteRoutes[index].destination = candidate.destination
            prefs.favoriteRoutes[index].bufferMiles = candidate.bufferMiles
            editingRouteID = nil
            editSnapshot = nil
            showToast("✓ Route updated")
            return
        }
        editingRouteID = nil
        if prefs.favoriteRoutes.contains(where: { $0.sameRoute(as: candidate) }) {
            showToast("This route is already saved")
            return
        }
        prefs.favoriteRoutes.append(candidate)
        showToast("★ Route saved")
    }

    func deleteRoute(_ id: Int64) {
        prefs.favoriteRoutes.removeAll { $0.id == id }
        if editingRouteID == id { cancelEditRoute() }
    }

    func loadSavedRoute(_ id: Int64) async {
        guard let saved = prefs.favoriteRoutes.first(where: { $0.id == id }) else { return }
        let route = await withCurrentLocation(saved)
        editingRouteID = nil
        editSnapshot = nil
        fillRouteFields(route)
        currentTab = .route
        await findRoute()
    }

    func editSavedRoute(_ id: Int64) async {
        guard let saved = prefs.favoriteRoutes.first(where: { $0.id == id }) else { return }
        let route = await withCurrentLocation(saved)
        if editingRouteID == nil {
            editSnapshot = (routeResult, routeOrigin, routeDest, routeOriginText, routeDestText, routeBuffer)
        }
        editingRouteID = id
        fillRouteFields(route)
        currentTab = .route
        await findRoute()
    }

    func cancelEditRoute() {
        editingRouteID = nil
        if let snap = editSnapshot {
            routeResult = snap.result
            routeOrigin = snap.origin
            routeDest = snap.dest
            routeOriginText = snap.originText
            routeDestText = snap.destText
            routeBuffer = snap.buffer
            editSnapshot = nil
        }
        if routeResult != nil { showRouteOnMap() }
    }

    func clearRoute() {
        routeResult = nil
        routeError = nil
    }

    private func fillRouteFields(_ route: SavedRoute) {
        routeOrigin = route.origin
        routeDest = route.destination
        routeOriginText = route.origin.label
        routeDestText = route.destination.label
        routeBuffer = route.bufferMiles
    }

    /// A saved route from "Your location" means wherever the device is now. Uses the position
    /// only if location access is already allowed; otherwise keeps the saved coordinates.
    private func withCurrentLocation(_ route: SavedRoute) async -> SavedRoute {
        guard route.origin.isYourLocation || route.destination.isYourLocation else { return route }
        guard let here = await location.currentIfAuthorized(maxAge: 0) ?? deviceLocation else {
            showToast("Couldn't get your current location, so \"\(Place.yourLocationLabel)\" is where you saved this route")
            return route
        }
        deviceLocation = here
        var updated = route
        if route.origin.isYourLocation { updated.origin = Place(here, label: Place.yourLocationLabel) }
        if route.destination.isYourLocation { updated.destination = Place(here, label: Place.yourLocationLabel) }
        return updated
    }
}
