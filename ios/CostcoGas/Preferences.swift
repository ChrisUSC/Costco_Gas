import CostcoGasKit
import Foundation
import Observation

/// Settings and saved items, kept in UserDefaults (the website keeps the same things in
/// localStorage, with the same defaults: see public/js/state.js).
@MainActor
@Observable
final class Preferences {
    @ObservationIgnored private let defaults: UserDefaults

    // Settings panel
    var clusterMarkers: Bool { didSet { defaults.set(clusterMarkers, forKey: "clusterMarkers") } }
    var colorPins: Bool { didSet { defaults.set(colorPins, forKey: "colorPins") } }
    var directionsApp: DirectionsApp { didSet { defaults.set(directionsApp.rawValue, forKey: "directionsApp") } }
    var theme: ThemePreference { didSet { defaults.set(theme.rawValue, forKey: "theme") } }
    private(set) var hiddenTabs: [AppTab] { didSet { defaults.set(hiddenTabs.map(\.rawValue), forKey: "hiddenTabs") } }
    var defaultTab: AppTab { didSet { defaults.set(defaultTab.rawValue, forKey: "defaultTab") } }
    var defaultGrade: DefaultGrade { didSet { defaults.set(defaultGrade.rawValue, forKey: "defaultGrade") } }
    var autoLocate: Bool { didSet { defaults.set(autoLocate, forKey: "autoLocate") } }

    // Remembered choices
    var lastGrade: Grade { didSet { defaults.set(lastGrade.rawValue, forKey: "gasPref") } }
    var nearbyRadius: Double { didSet { defaults.set(nearbyRadius, forKey: "nearbyRadius") } }
    var nearbySort: NearbySort { didSet { defaults.set(nearbySort.rawValue, forKey: "nearbySort") } }
    var historyRange: HistoryRange { didSet { defaults.set(historyRange.rawValue, forKey: "historyRangeDays") } }

    // Your car, for the fill-up cost and "worth the drive" comparison (FillUp in the Kit)
    var tankGallons: Double { didSet { defaults.set(tankGallons, forKey: "tankGallons") } }
    var mpg: Double { didSet { defaults.set(mpg, forKey: "mpg") } }

    // Favorites
    var favoriteStations: Set<String> { didSet { defaults.set(Array(favoriteStations).sorted(), forKey: "favoriteStores") } }
    var favoriteRoutes: [SavedRoute] {
        didSet { defaults.set(try? JSONEncoder().encode(favoriteRoutes), forKey: "favoriteRoutes") }
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        func string(_ key: String) -> String? { defaults.string(forKey: key) }
        func bool(_ key: String, _ fallback: Bool) -> Bool { defaults.object(forKey: key) == nil ? fallback : defaults.bool(forKey: key) }

        // Clustering starts on (only when zoomed far out), price colours off.
        clusterMarkers = bool("clusterMarkers", true)
        colorPins = bool("colorPins", false)
        directionsApp = string("directionsApp").flatMap(DirectionsApp.init(rawValue:)) ?? .apple
        theme = string("theme").flatMap(ThemePreference.init(rawValue:)) ?? .system
        autoLocate = bool("autoLocate", true)
        let savedDefaultTab = string("defaultTab").flatMap(AppTab.init(rawValue:))
        // All stations starts hidden (the search field still finds stations), unless it was
        // chosen as the start-up tab.
        let hidden = (defaults.stringArray(forKey: "hiddenTabs") ?? (savedDefaultTab == .search ? [] : ["search"]))
            .compactMap(AppTab.init(rawValue:))
        hiddenTabs = hidden.count < AppTab.allCases.count ? AppTab.allCases.filter(hidden.contains) : []
        defaultGrade = string("defaultGrade").flatMap(DefaultGrade.init(rawValue:)) ?? .last
        lastGrade = string("gasPref").flatMap(Grade.init(rawValue:)) ?? .regular
        let radius = defaults.double(forKey: "nearbyRadius")
        nearbyRadius = StationQueries.nearbyRadii.contains(radius) ? radius : 10
        nearbySort = string("nearbySort").flatMap(NearbySort.init(rawValue:)) ?? .price
        historyRange = defaults.object(forKey: "historyRangeDays") == nil
            ? .month
            : (HistoryRange(rawValue: defaults.integer(forKey: "historyRangeDays")) ?? .month)
        tankGallons = FillUp.clamped(defaults.object(forKey: "tankGallons") as? Double,
                                     to: FillUp.tankRange, fallback: FillUp.defaultTankGallons)
        mpg = FillUp.clamped(defaults.object(forKey: "mpg") as? Double, to: FillUp.mpgRange, fallback: FillUp.defaultMPG)
        favoriteStations = Set(defaults.stringArray(forKey: "favoriteStores") ?? [])
        favoriteRoutes = defaults.data(forKey: "favoriteRoutes")
            .flatMap { try? JSONDecoder().decode([SavedRoute].self, from: $0) } ?? []
        defaultTab = savedDefaultTab ?? .nearby
        if hiddenTabs.contains(defaultTab) { defaultTab = visibleTabs.first ?? .nearby }
    }

    /// The tabs in the tab strip, in order.
    var visibleTabs: [AppTab] { AppTab.allCases.filter { !hiddenTabs.contains($0) } }

    /// The grade shown on opening.
    var initialGrade: Grade { Grade(rawValue: defaultGrade.rawValue) ?? lastGrade }

    /// Shows or hides a tab; at least one always stays shown.
    func setTab(_ tab: AppTab, visible: Bool) {
        var hidden = Set(hiddenTabs)
        if visible { hidden.remove(tab) } else { hidden.insert(tab) }
        guard hidden.count < AppTab.allCases.count else { return }
        hiddenTabs = AppTab.allCases.filter(hidden.contains)
        if hiddenTabs.contains(defaultTab) { defaultTab = visibleTabs.first ?? .nearby }
    }

    func isFavorite(_ station: Station) -> Bool { favoriteStations.contains(station.id) }

    /// Returns whether the station is now a favorite.
    @discardableResult
    func toggleFavorite(_ station: Station) -> Bool {
        if favoriteStations.remove(station.id) != nil { return false }
        favoriteStations.insert(station.id)
        return true
    }
}
