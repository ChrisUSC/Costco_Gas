import Foundation

// --- Price history: parsing us_history.json and the one-point-per-day chart series
//     (port of public/js/charts.js) ---

public struct HistoryPoint: Hashable, Sendable {
    public let date: Date
    public let prices: GradePrices

    public init(date: Date, prices: GradePrices) {
        self.date = date
        self.prices = prices
    }
}

/// One chart point: the price held at the end of the day, and which grades changed that day.
public struct DailyPrice: Identifiable, Hashable, Sendable {
    public let date: Date
    public let prices: GradePrices
    public let changed: Set<Grade>
    public var id: Date { date }
}

public enum HistoryRange: Int, CaseIterable, Identifiable, Sendable {
    case week = 7, month = 30, quarter = 90, year = 365, all = 0

    public var id: Int { rawValue }

    public var label: String {
        switch self {
        case .week: return "7D"
        case .month: return "30D"
        case .quarter: return "90D"
        case .year: return "1Y"
        case .all: return "All"
        }
    }
}

public struct PriceHistory: Sendable {
    /// Each station's change-only entries, oldest first, keyed "CA_Turlock".
    public let byStation: [String: [HistoryPoint]]

    /// Show a dot on every day, not just the days a price changed, up to this many points.
    public static let showAllDotsMaxPoints = 45

    public init(byStation: [String: [HistoryPoint]]) {
        self.byStation = byStation
    }

    /// us_history.json: `{ "2026-11-25 09:00": { "CA": { "Turlock": [4.19, 4.59, null] } } }`.
    /// A full snapshot first, then only the stations whose prices changed.
    public init(data: Data) throws {
        guard let top = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw DataError.malformed("price history")
        }
        var out: [String: [HistoryPoint]] = [:]
        for ts in top.keys.sorted() {
            guard let date = ScraperTime.parse(ts), let states = top[ts] as? [String: Any] else { continue }
            for (stateCode, cities) in states {
                guard let cities = cities as? [String: Any] else { continue }
                for (city, raw) in cities {
                    guard let prices = GradePrices.parse(raw) else { continue }
                    out[Station.key(state: stateCode, city: city), default: []].append(HistoryPoint(date: date, prices: prices))
                }
            }
        }
        byStation = out
    }

    public func points(for stationID: String) -> [HistoryPoint] {
        byStation[stationID] ?? []
    }

    /// One point per calendar day from the start of the range through `now`, carrying the last
    /// known price forward. `rangeDays` 0 means from the first entry.
    public static func dailySeries(_ points: [HistoryPoint], rangeDays: Int, now: Date,
                                   calendar: Calendar = .current) -> [DailyPrice] {
        guard !points.isEmpty else { return [] }
        let sorted = points.sorted { $0.date < $1.date }

        // Keep only the last entry per calendar day.
        var deduped: [HistoryPoint] = []
        var seen = Set<Date>()
        for p in sorted.reversed() where seen.insert(calendar.startOfDay(for: p.date)).inserted {
            deduped.append(p)
        }
        deduped.reverse()

        let start = rangeDays > 0 ? now.addingTimeInterval(-Double(rangeDays) * 86_400) : deduped[0].date
        return expandToDaily(deduped, start: start, end: now, calendar: calendar)
    }

    static func expandToDaily(_ points: [HistoryPoint], start: Date, end: Date, calendar: Calendar) -> [DailyPrice] {
        var out: [DailyPrice] = []
        var idx = 0
        var last: HistoryPoint?
        var day = calendar.startOfDay(for: start)
        let endDay = calendar.startOfDay(for: end)

        // Prices from before the range set the starting price without counting as changes.
        while idx < points.count && points[idx].date < day {
            last = points[idx]
            idx += 1
        }

        while day <= endDay {
            guard let nextDay = calendar.date(byAdding: .day, value: 1, to: day) else { break }
            var changed = Set<Grade>()
            while idx < points.count && points[idx].date < nextDay {
                let current = points[idx]
                idx += 1
                for grade in Grade.allCases {
                    if let prev = last {
                        if current.prices[grade] != prev.prices[grade] { changed.insert(grade) }
                    } else if current.prices[grade] != nil {
                        changed.insert(grade)
                    }
                }
                last = current
            }
            if let held = last {
                out.append(DailyPrice(date: day, prices: held.prices, changed: changed))
            }
            day = nextDay
        }
        return out
    }
}
