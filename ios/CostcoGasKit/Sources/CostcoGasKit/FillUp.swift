import Foundation

// --- Fill-up cost, and the best value along a route: your usual fill-up plus the detour to
//     reach each station and get back on the route (port of public/js/fillup.js; change both
//     together) ---

/// One station along a route, with what a stop there costs.
public struct RouteStopCost: Identifiable, Hashable, Sendable {
    public let station: Station
    /// Miles off the route, as the Route search measured it.
    public let offRoute: Double
    public let price: Double
    /// Off the route to the station and back, allowing for winding roads.
    public let detourMiles: Double
    public let detourCost: Double
    public let fillCost: Double
    public let total: Double
    /// How much more than the best value (0 for the best).
    public let extraVsBest: Double
    /// The best value, or within a few cents of it.
    public let isBest: Bool

    public var id: String { station.id }
}

public enum RouteSort: String, CaseIterable, Codable, Identifiable, Sendable {
    case value, price
    public var id: String { rawValue }
    public var label: String { self == .value ? "Best value (detour included)" : "Lowest price" }
}

public enum FillUp {
    /// Roads wind: a drive is about this much longer than the straight line.
    public static let roadFactor = 1.2
    public static let defaultGallons = 12.0
    public static let defaultMPG = 25.0
    public static let gallonRange: ClosedRange<Double> = 1...60
    public static let mpgRange: ClosedRange<Double> = 1...150
    /// Totals closer than this to the best one also count as the best value.
    static let sameCostDollars = 0.05

    /// What your usual fill-up costs at a price.
    public static func fillCost(price: Double, gallons: Double) -> Double {
        price * gallons
    }

    /// The extra road miles a stop at each station adds to a trip, from an OSRM /table reply for
    /// the points [origin, station 1 … station n, destination] with sources 0…n and destinations
    /// 1…n+1 (distances in metres): origin → station + station → destination − the direct route.
    /// Nil for a station the router couldn't reach.
    public static func roadDetourMiles(distances: [[Double?]]?, stationCount: Int, routeMiles: Double) -> [Double?] {
        (0..<stationCount).map { i in
            guard let rows = distances, rows.count > i + 1,
                  rows[0].count > i, rows[i + 1].count > stationCount,
                  let toStation = rows[0][i], let toDestination = rows[i + 1][stationCount] else { return nil }
            return max(0, (toStation + toDestination) / 1609.34 - routeMiles)
        }
    }

    /// Each station along a route with a price for the grade, best value first: the fill-up plus
    /// the detour. The detour is the station's road detour in `roadDetours` (keyed by station id)
    /// when known, else an estimate: off the route to the station and back, allowing for winding roads.
    public static func routeStops(_ along: [StationDistance], grade: Grade, gallons: Double, mpg: Double,
                                  roadDetours: [String: Double] = [:]) -> [RouteStopCost] {
        let stops = along.compactMap { item -> (StationDistance, Double, Double, Double, Double)? in
            guard let price = item.station.price(grade) else { return nil }
            let detourMiles = roadDetours[item.id] ?? 2 * item.distance * roadFactor
            let detourCost = detourMiles / mpg * price
            let fill = fillCost(price: price, gallons: gallons)
            return (item, price, detourMiles, detourCost, fill)
        }
        .sorted { a, b in
            let ta = a.4 + a.3, tb = b.4 + b.3
            return ta != tb ? ta < tb : a.1 < b.1
        }
        let best = stops.first.map { $0.4 + $0.3 } ?? 0
        return stops.map { item, price, miles, detour, fill in
            let total = fill + detour
            return RouteStopCost(station: item.station, offRoute: item.distance, price: price, detourMiles: miles,
                                 detourCost: detour, fillCost: fill, total: total, extraVsBest: total - best,
                                 isBest: total - best < sameCostDollars)
        }
    }

    /// A saved setting if it's in range, otherwise the fallback.
    public static func clamped(_ value: Double?, to range: ClosedRange<Double>, fallback: Double) -> Double {
        guard let value, value.isFinite, range.contains(value) else { return fallback }
        return value
    }
}
