import Foundation

// --- "Is it worth the drive?": what a fill-up costs at a station, counting the gas burned
//     driving there and back, compared with the nearest station (port of public/js/fillup.js;
//     change both together) ---

public struct FillUpEstimate: Equatable, Sendable {
    public struct Nearest: Equatable, Sendable {
        public let state: String
        public let city: String
        public let distance: Double
        /// The station being looked at is itself the nearest one.
        public let isThis: Bool
    }

    public let price: Double
    public let fillCost: Double
    /// Round trip, in miles, allowing for winding roads. Nil without a starting point.
    public let driveMiles: Double?
    public let driveCost: Double?
    public let total: Double?
    public let nearest: Nearest?
    /// What this station saves against the nearest one, drive included. Negative costs more.
    public let savings: Double?
}

public struct FillUpVerdict: Equatable, Sendable {
    public enum Tone: Sendable { case good, bad, neutral }
    /// "Saves $2.10 vs Tracy, the nearest station"
    public let text: String
    /// "Saves $2.10", for a list row.
    public let short: String
    public let tone: Tone
}

public enum FillUp {
    /// Roads wind: a drive is about this much longer than the straight line to the station.
    public static let roadFactor = 1.2
    public static let defaultTankGallons = 15.0
    public static let defaultMPG = 25.0
    public static let tankRange: ClosedRange<Double> = 1...60
    public static let mpgRange: ClosedRange<Double> = 1...150
    /// Savings smaller than this read as "about the same".
    static let sameCostDollars = 0.05

    /// The cost of filling up at `station`, and of getting there and back from `from`. Nil when
    /// the station has no price for the grade. Without `from`, only the fill-up cost is known.
    public static func estimate(for station: Station, grade: Grade, among stations: [Station], from: LatLng?,
                                tankGallons: Double, mpg: Double) -> FillUpEstimate? {
        guard let price = station.price(grade) else { return nil }
        let fillCost = tankGallons * price
        guard let from, let here = station.coordinate else {
            return FillUpEstimate(price: price, fillCost: fillCost, driveMiles: nil, driveCost: nil,
                                  total: nil, nearest: nil, savings: nil)
        }

        func trip(to coordinate: LatLng, price p: Double) -> (miles: Double, drive: Double, total: Double) {
            let miles = 2 * distanceMiles(from, coordinate) * roadFactor
            let drive = miles / mpg * p
            return (miles, drive, tankGallons * p + drive)
        }
        let thisTrip = trip(to: here, price: price)

        var nearest: (station: Station, coordinate: LatLng, distance: Double)?
        for s in stations {
            guard let c = s.coordinate, s.hasPrice(grade) else { continue }
            let d = distanceMiles(from, c)
            if nearest == nil || d < nearest!.distance { nearest = (s, c, d) }
        }

        var nearestInfo: FillUpEstimate.Nearest?
        var savings: Double?
        if let n = nearest, let nearestPrice = n.station.price(grade) {
            let isThis = n.station.id == station.id
            nearestInfo = .init(state: n.station.state, city: n.station.city, distance: n.distance, isThis: isThis)
            savings = isThis ? 0 : trip(to: n.coordinate, price: nearestPrice).total - thisTrip.total
        }
        return FillUpEstimate(price: price, fillCost: fillCost, driveMiles: thisTrip.miles, driveCost: thisTrip.drive,
                              total: thisTrip.total, nearest: nearestInfo, savings: savings)
    }

    /// One line comparing a station with the nearest one. Nil when there's nothing to compare.
    public static func verdict(_ estimate: FillUpEstimate?) -> FillUpVerdict? {
        guard let estimate, let nearest = estimate.nearest, let savings = estimate.savings else { return nil }
        if nearest.isThis { return FillUpVerdict(text: "The nearest station", short: "Nearest", tone: .neutral) }
        let amount = String(format: "$%.2f", abs(savings))
        if abs(savings) < sameCostDollars {
            return FillUpVerdict(text: "About the same as \(nearest.city), the nearest station",
                                 short: "Same as nearest", tone: .neutral)
        }
        return savings > 0
            ? FillUpVerdict(text: "Saves \(amount) vs \(nearest.city), the nearest station", short: "Saves \(amount)", tone: .good)
            : FillUpVerdict(text: "Costs \(amount) more than \(nearest.city), the nearest station", short: "\(amount) more", tone: .bad)
    }

    /// A saved setting if it's in range, otherwise the fallback.
    public static func clamped(_ value: Double?, to range: ClosedRange<Double>, fallback: Double) -> Double {
        guard let value, value.isFinite, range.contains(value) else { return fallback }
        return value
    }
}
