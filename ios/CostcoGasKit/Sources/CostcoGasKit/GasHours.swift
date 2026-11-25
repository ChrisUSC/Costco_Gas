import Foundation

// --- Gas station hours and open / closed status in the station's own time zone
//     (port of public/js/hours.js) ---

/// One day's opening and closing time, "HH:MM" in 24-hour time.
public struct DayHours: Hashable, Sendable {
    public let open: String
    public let close: String

    public init(open: String, close: String) {
        self.open = open
        self.close = close
    }
}

/// Keyed "mon" … "sun"; a missing day is closed.
public typealias WeeklyHours = [String: DayHours]

public struct GasStatus: Equatable, Sendable {
    public enum Kind: Sendable { case open, closingSoon, closed }
    public let isOpen: Bool
    public let closingSoon: Bool
    public let text: String

    public var kind: Kind { isOpen ? (closingSoon ? .closingSoon : .open) : .closed }
}

public enum GasHours {
    static let daysSunFirst = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
    static let daysMonFirst = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
    static let dayLabels = ["mon": "Mon", "tue": "Tue", "wed": "Wed", "thu": "Thu", "fri": "Fri", "sat": "Sat", "sun": "Sun"]
    static let closingSoonMinutes = 60

    static func minutes(_ t: String) -> Int {
        let parts = t.split(separator: ":").map { Int($0) ?? 0 }
        return (parts.first ?? 0) * 60 + (parts.count > 1 ? parts[1] : 0)
    }

    /// "06:00" → "6 AM", "20:30" → "8:30 PM".
    public static func formatTime(_ t: String) -> String {
        let parts = t.split(separator: ":").map { Int($0) ?? 0 }
        let h = parts.first ?? 0
        let m = parts.count > 1 ? parts[1] : 0
        let suffix = h >= 12 ? "PM" : "AM"
        let h12 = h % 12 == 0 ? 12 : h % 12
        return m != 0 ? "\(h12):\(String(format: "%02d", m)) \(suffix)" : "\(h12) \(suffix)"
    }

    public static func status(hours: WeeklyHours?, timeZone: String?, now: Date = Date()) -> GasStatus? {
        guard let hours, let tzID = timeZone, let tz = TimeZone(identifier: tzID) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = tz
        let c = calendar.dateComponents([.weekday, .hour, .minute], from: now)
        guard let weekday = c.weekday, let hour = c.hour, let minute = c.minute else { return nil }

        let dayIdx = weekday - 1 // Calendar weekday 1 = Sunday
        let mins = hour * 60 + minute
        let today = hours[daysSunFirst[dayIdx]]
        let yesterday = hours[daysSunFirst[(dayIdx + 6) % 7]]

        func openResult(_ closeMins: Int, _ closeLabel: String) -> GasStatus {
            let soon = closeMins - mins <= closingSoonMinutes && closeMins - mins > 0
            return GasStatus(isOpen: true, closingSoon: soon,
                             text: soon ? "Closing soon · \(closeLabel)" : "Open · closes \(closeLabel)")
        }

        // Still open from a late shift that started yesterday.
        if let yesterday {
            let yo = minutes(yesterday.open), yc = minutes(yesterday.close)
            if yc < yo && mins < yc { return openResult(yc, formatTime(yesterday.close)) }
        }

        if let today {
            let o = minutes(today.open), c = minutes(today.close)
            if o == c { return GasStatus(isOpen: true, closingSoon: false, text: "Open 24 hours") }
            if c > o && mins >= o && mins < c { return openResult(c, formatTime(today.close)) }
            if c < o && mins >= o {
                return GasStatus(isOpen: true, closingSoon: false, text: "Open · closes \(formatTime(today.close)) tomorrow")
            }
            if mins < o { return GasStatus(isOpen: false, closingSoon: false, text: "Closed · opens \(formatTime(today.open))") }
        }

        for i in 1...7 {
            let day = daysSunFirst[(dayIdx + i) % 7]
            if let next = hours[day] {
                let when = i == 1 ? "tomorrow" : (dayLabels[day] ?? day)
                return GasStatus(isOpen: false, closingSoon: false, text: "Closed · opens \(when) \(formatTime(next.open))")
            }
        }
        return GasStatus(isOpen: false, closingSoon: false, text: "Closed")
    }

    public struct Row: Hashable, Sendable {
        public let label: String
        public let text: String
    }

    /// Consecutive days with the same hours share a row: "Mon–Fri  6 AM – 10 PM".
    public static func grouped(_ hours: WeeklyHours) -> [Row] {
        func fmt(_ h: DayHours?) -> String {
            guard let h else { return "Closed" }
            return "\(formatTime(h.open)) – \(formatTime(h.close))"
        }
        var rows: [(start: String, end: String, text: String)] = []
        for day in daysMonFirst {
            let text = fmt(hours[day])
            if let last = rows.last, last.text == text {
                rows[rows.count - 1].end = day
            } else {
                rows.append((start: day, end: day, text: text))
            }
        }
        return rows.map { r in
            let start = dayLabels[r.start] ?? r.start
            let end = dayLabels[r.end] ?? r.end
            return Row(label: r.start == r.end ? start : "\(start)–\(end)", text: r.text)
        }
    }
}
