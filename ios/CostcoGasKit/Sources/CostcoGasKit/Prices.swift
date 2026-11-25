import Foundation

// --- Fuel grades, price parsing and formatting, trend arrows (port of public/js/prices.js) ---

public enum Grade: String, CaseIterable, Codable, Identifiable, Sendable {
    case regular, premium, diesel

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .regular: return "Regular"
        case .premium: return "Premium"
        case .diesel: return "Diesel"
        }
    }

    /// Only a minority of warehouses sell diesel, so the Diesel view leaves out stations
    /// without a diesel price. Regular and Premium show every station.
    public var filtersStations: Bool { self == .diesel }
}

/// Prices are `[regular, premium, diesel]` in the snapshots, with `null` for a grade not sold.
public struct GradePrices: Hashable, Sendable {
    public var regular: Double?
    public var premium: Double?
    public var diesel: Double?

    public init(regular: Double? = nil, premium: Double? = nil, diesel: Double? = nil) {
        self.regular = regular
        self.premium = premium
        self.diesel = diesel
    }

    public subscript(grade: Grade) -> Double? {
        get {
            switch grade {
            case .regular: return regular
            case .premium: return premium
            case .diesel: return diesel
            }
        }
        set {
            switch grade {
            case .regular: regular = newValue
            case .premium: premium = newValue
            case .diesel: diesel = newValue
            }
        }
    }

    /// Reads one station's prices from a decoded JSON value: the usual array, or an older
    /// `{ "Regular": ..., "Premium": ..., "Diesel": ... }` object. Nil when there is no entry.
    public static func parse(_ value: Any?) -> GradePrices? {
        guard let value, !(value is NSNull) else { return nil }
        if let array = value as? [Any] {
            func at(_ i: Int) -> Any? { i < array.count ? array[i] : nil }
            return GradePrices(regular: parsePrice(at(0)), premium: parsePrice(at(1)), diesel: parsePrice(at(2)))
        }
        if let dict = value as? [String: Any] {
            return GradePrices(
                regular: parsePrice(dict["Regular"] ?? dict["regular"]),
                premium: parsePrice(dict["Premium"] ?? dict["premium"]),
                diesel: parsePrice(dict["Diesel"] ?? dict["diesel"])
            )
        }
        return nil
    }
}

/// A price from a number or a string like "$4.59". Nil for null, "N/A" or anything unreadable.
public func parsePrice(_ value: Any?) -> Double? {
    guard let value, !(value is NSNull) else { return nil }
    if let string = value as? String {
        let trimmed = string.replacingOccurrences(of: "$", with: "").trimmingCharacters(in: .whitespaces)
        guard let d = Double(trimmed), d.isFinite else { return nil }
        return d
    }
    if let number = value as? NSNumber {
        let d = number.doubleValue
        return d.isFinite ? d : nil
    }
    if let d = value as? Double { return d.isFinite ? d : nil }
    if let i = value as? Int { return Double(i) }
    return nil
}

/// "$4.59", or "N/A" when there is no price.
public func formatPrice(_ value: Double?) -> String {
    guard let value, value.isFinite else { return "N/A" }
    return String(format: "$%.2f", value)
}

/// The move since the trend baseline (about 72 hours earlier): an arrow and the size in cents.
public enum Trend: Equatable, Sendable {
    case flat
    case up(cents: Int)
    case down(cents: Int)

    public init?(current: Double?, previous: Double?) {
        guard let current, let previous, current.isFinite, previous.isFinite else { return nil }
        let diff = current - previous
        if abs(diff) < 0.005 {
            self = .flat
            return
        }
        let cents = Int((abs(diff) * 100).rounded())
        self = diff > 0 ? .up(cents: cents) : .down(cents: cents)
    }

    /// "▼ 4¢", "▲ 6¢" or "–".
    public var text: String {
        switch self {
        case .flat: return "–"
        case .up(let cents): return "▲ \(cents)¢"
        case .down(let cents): return "▼ \(cents)¢"
        }
    }

    /// Never colour alone: VoiceOver hears the direction too.
    public func accessibilityText(since baseline: String) -> String {
        switch self {
        case .flat: return "no change since \(baseline)"
        case .up(let cents): return "up \(cents) cents since \(baseline)"
        case .down(let cents): return "down \(cents) cents since \(baseline)"
        }
    }
}
