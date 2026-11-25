import CoreLocation
import CostcoGasKit
import SwiftUI

// Prices and location for the widgets. The widget can't see the app's saved data (that would
// need an App Group), so it fetches the same us_latest.json itself, keeps its own saved copy,
// and reads the store list bundled with it.

enum WidgetData {
    static let client = SnapshotClient()

    struct Prices {
        let stations: [Station]
        let timestamp: String?
    }

    /// The current prices, or the last ones saved if the network can't be reached.
    static func prices() async -> Prices? {
        guard let storesURL = Bundle.main.url(forResource: "us_stores", withExtension: "json"),
              let storesData = try? Data(contentsOf: storesURL),
              let directory = try? StoreDirectory(data: storesData) else { return nil }
        // Changes every 10 minutes, so repeated widget reloads can share a cached reply.
        let cacheBuster = String(Int(Date().timeIntervalSince1970 / 600))
        guard let latest = try? await client.fetch("us_latest.json", cacheBuster: cacheBuster),
              let snapshot = try? PriceSnapshot(data: latest.data) else { return nil }
        if !latest.fromSavedCopy { client.save(latest.data, as: "us_latest.json") }
        return Prices(stations: buildStations(snapshot: snapshot, directory: directory), timestamp: snapshot.timestamp)
    }

    static func updatedText(_ timestamp: String?, now: Date = Date()) -> String {
        ScraperTime.updatedLabel(timestamp, now: now).age
    }
}

/// The widget's own location: the system's last fix if it's recent, else a fresh one, else the
/// last one the widget saw. Needs the app to have location access ("While Using the App or
/// Widgets"). Main-actor bound: Core Location delivers results on the thread that made the manager.
@MainActor
final class WidgetLocation: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    nonisolated(unsafe) private var continuation: CheckedContinuation<CLLocation?, Never>?
    nonisolated private let lock = NSLock()
    nonisolated private static let savedKey = "lastLocation"

    func current() async -> LatLng? {
        guard manager.isAuthorizedForWidgetUpdates else { return Self.saved() }
        if let fix = manager.location, -fix.timestamp.timeIntervalSinceNow < 15 * 60 {
            return Self.save(fix)
        }
        let fix: CLLocation? = await withCheckedContinuation { continuation in
            lock.lock()
            self.continuation = continuation
            lock.unlock()
            manager.delegate = self
            manager.desiredAccuracy = kCLLocationAccuracyKilometer
            manager.requestLocation()
            DispatchQueue.global().asyncAfter(deadline: .now() + 6) { [weak self] in self?.finish(nil) }
        }
        if let fix { return Self.save(fix) }
        return manager.location.map(Self.save) ?? Self.saved()
    }

    nonisolated private func finish(_ location: CLLocation?) {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume(returning: location)
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        finish(locations.last)
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        finish(nil)
    }

    nonisolated private static func save(_ location: CLLocation) -> LatLng {
        let point = LatLng(location.coordinate.latitude, location.coordinate.longitude)
        UserDefaults.standard.set([point.lat, point.lng], forKey: savedKey)
        return point
    }

    nonisolated private static func saved() -> LatLng? {
        guard let pair = UserDefaults.standard.array(forKey: savedKey) as? [Double], pair.count == 2 else { return nil }
        return LatLng(pair[0], pair[1])
    }
}

// MARK: - Shared look

extension Grade {
    /// The app's grade colours (Theme.swift), shaded for light and dark mode.
    var widgetColor: Color {
        switch self {
        case .regular: return Color(light: 0x047857, dark: 0x34D399)
        case .premium: return Color(light: 0x1D4ED8, dark: 0x7DB4FF)
        case .diesel: return Color(light: 0xB45309, dark: 0xFBBF24)
        }
    }
}

extension Color {
    init(light: UInt32, dark: UInt32) {
        func ui(_ hex: UInt32) -> UIColor {
            UIColor(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                    blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
        }
        self.init(uiColor: UIColor { $0.userInterfaceStyle == .dark ? ui(dark) : ui(light) })
    }

    /// Costco blue, lightened in dark mode so it stays readable on a dark widget.
    static let widgetTitle = Color(light: 0x005DAA, dark: 0x7DB4FF)
}

/// Opens the app on a station.
func stationURL(_ station: Station) -> URL {
    var comps = URLComponents()
    comps.scheme = DeepLink.scheme
    comps.host = "open"
    comps.queryItems = [URLQueryItem(name: "store", value: station.id)]
    return comps.url!
}
