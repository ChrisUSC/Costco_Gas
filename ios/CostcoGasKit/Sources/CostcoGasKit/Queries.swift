import Foundation

// --- The station lists: Nearby, State lowest, All stations, Favorites, Route
//     (the sorting rules from public/js/lists.js and routes.js) and price colours (markers.js) ---

public struct StationDistance: Identifiable, Hashable, Sendable {
    public let station: Station
    public let distance: Double
    public var id: String { station.id }

    public init(station: Station, distance: Double) {
        self.station = station
        self.distance = distance
    }
}

public enum NearbySort: String, CaseIterable, Codable, Identifiable, Sendable {
    case price, distance
    public var id: String { rawValue }
    public var label: String { self == .price ? "Price" : "Distance" }
}

public struct StateCount: Hashable, Identifiable, Sendable {
    public let code: String
    public let count: Int
    public var id: String { code }
}

public enum StationQueries {
    public static let nearbyRadii: [Double] = [5, 10, 25, 50, 100]

    /// Stations within the radius, unsorted (all grades: the empty-list wording depends on it).
    public static func within(_ stations: [Station], of center: LatLng, radiusMiles: Double) -> [StationDistance] {
        stations.compactMap { s in
            guard let c = s.coordinate else { return nil }
            let d = distanceMiles(center, c)
            return d <= radiusMiles ? StationDistance(station: s, distance: d) : nil
        }
    }

    /// Stations with a price for the grade, cheapest first (ties: nearest), or nearest first.
    public static func sortNearby(_ list: [StationDistance], grade: Grade, by sort: NearbySort) -> [StationDistance] {
        list.filter { $0.station.hasPrice(grade) }.sorted { a, b in
            let pa = a.station.price(grade) ?? .infinity, pb = b.station.price(grade) ?? .infinity
            if sort == .distance {
                return a.distance != b.distance ? a.distance < b.distance : pa < pb
            }
            return pa != pb ? pa < pb : a.distance < b.distance
        }
    }

    /// The state leaderboard: cheapest first.
    public static func lowest(_ stations: [Station], state: String, grade: Grade) -> [Station] {
        stations.filter { $0.state == state && $0.hasPrice(grade) }
            .sorted { ($0.price(grade) ?? .infinity) < ($1.price(grade) ?? .infinity) }
    }

    public static func states(_ stations: [Station]) -> [StateCount] {
        Dictionary(grouping: stations, by: \.state)
            .map { StateCount(code: $0.key, count: $0.value.count) }
            .sorted { $0.code < $1.code }
    }

    /// Only Diesel leaves out stations without a price for it.
    public static func forGrade(_ stations: [Station], _ grade: Grade) -> [Station] {
        grade.filtersStations ? stations.filter { $0.hasPrice(grade) } : stations
    }

    /// Stations matching the query (all of them for an empty query), nearest to `center` first.
    public static func search(_ stations: [Station], query: String, near center: LatLng?) -> [Station] {
        let q = query.lowercased().trimmingCharacters(in: .whitespaces)
        let matches = q.isEmpty ? stations : stations.filter { $0.matches(q) }
        guard let center else { return matches }
        return matches
            .map { s in (s, s.coordinate.map { distanceMiles(center, $0) } ?? .infinity) }
            .sorted { $0.1 < $1.1 }
            .map(\.0)
    }

    public static func favorites(_ stations: [Station], keys: Set<String>) -> [Station] {
        stations.filter { keys.contains($0.id) }
            .sorted { $0.city.localizedCompare($1.city) == .orderedAscending }
    }

    /// Stations within `bufferMiles` of the route, with their distance from it.
    public static func along(route: [LatLng], stations: [Station], bufferMiles: Double) -> [StationDistance] {
        guard !route.isEmpty else { return [] }
        let bounds = routeBoundsPadded(route, bufferMiles: bufferMiles)
        return stations.compactMap { s in
            guard let c = s.coordinate, bounds.contains(c) else { return nil }
            let d = minDistanceToRouteMiles(c, route)
            return d <= bufferMiles ? StationDistance(station: s, distance: d) : nil
        }
    }

    public static func sortAlong(_ list: [StationDistance], grade: Grade) -> [StationDistance] {
        list.filter { $0.station.hasPrice(grade) }
            .sorted { ($0.station.price(grade) ?? .infinity) < ($1.station.price(grade) ?? .infinity) }
    }

    /// The state of the station closest to a point: the default State lowest leaderboard.
    public static func closestState(to p: LatLng, in stations: [Station]) -> String? {
        var best: (String, Double)?
        for s in stations {
            guard let c = s.coordinate else { continue }
            let d = (c.lat - p.lat) * (c.lat - p.lat) + (c.lng - p.lng) * (c.lng - p.lng)
            if best == nil || d < best!.1 { best = (s.state, d) }
        }
        return best?.0
    }
}

// MARK: - Price colours

public enum PriceTier: Sendable {
    case low, mid, high, flat, none
}

/// Colours each pin by where its price sits among the stations in view: lowest third green,
/// middle amber, top third red. With fewer than 3 prices, or a spread under 3¢, every pin
/// is the plain colour.
public struct PriceTierScale: Equatable, Sendable {
    public static let minSpread = 0.03

    public let min: Double
    public let max: Double
    public let comparable: Bool

    public init(pricesInView: [Double], enabled: Bool) {
        let lo = pricesInView.min() ?? 0
        let hi = pricesInView.max() ?? 0
        min = lo
        max = hi
        comparable = enabled && pricesInView.count >= 3 && hi - lo >= PriceTierScale.minSpread
    }

    public func tier(for price: Double?) -> PriceTier {
        guard let price else { return .none }
        guard comparable else { return .flat }
        let t = (price - min) / (max - min)
        return t <= 1.0 / 3 ? .low : (t >= 2.0 / 3 ? .high : .mid)
    }
}
