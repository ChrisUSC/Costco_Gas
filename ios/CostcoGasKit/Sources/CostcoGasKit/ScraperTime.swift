import Foundation

// --- Scraper timestamps (Pacific wall-clock time) and the "Updated … ago" wording
//     (port of public/js/time.js) ---

public enum ScraperTime {
    public static let timeZone = TimeZone(identifier: "America/Los_Angeles")!

    /// Prices are scraped hourly, so a snapshot this old means several runs in a row failed.
    public static let staleHours = 4

    /// "2026-11-25 09:00" (Pacific), or an ISO 8601 time with an offset or Z.
    public static func parse(_ raw: String?) -> Date? {
        guard let raw else { return nil }
        let str = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if str.isEmpty { return nil }

        if str.range(of: #"([+-]\d{2}:?\d{2}|Z)$"#, options: [.regularExpression, .caseInsensitive]) != nil {
            return parseISO(str)
        }

        guard let match = str.range(of: #"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?"#, options: .regularExpression) else {
            return nil
        }
        let numbers = str[match].split(whereSeparator: { !("0"..."9").contains($0) }).compactMap { Int($0) }
        guard numbers.count >= 5 else { return nil }
        var comps = DateComponents()
        comps.year = numbers[0]
        comps.month = numbers[1]
        comps.day = numbers[2]
        comps.hour = numbers[3]
        comps.minute = numbers[4]
        comps.second = numbers.count > 5 ? numbers[5] : 0
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar.date(from: comps)
    }

    private static func parseISO(_ str: String) -> Date? {
        var s = str
        if let space = s.firstIndex(of: " ") { s.replaceSubrange(space...space, with: "T") }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let d = plain.date(from: s) { return d }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: s)
    }

    /// The trend baseline, e.g. "72h ago", "3d ago" or "the last hour".
    public static func relativeLabel(_ timestamp: String?, now: Date = Date()) -> String {
        guard let date = parse(timestamp) else { return "the last update" }
        let hours = Int((now.timeIntervalSince(date) / 3600).rounded())
        if hours < 1 { return "the last hour" }
        if hours < 36 { return "\(hours)h ago" }
        return "\(Int((Double(hours) / 24).rounded()))d ago"
    }

    public struct UpdatedLabel: Equatable, Sendable {
        /// "5 min ago", "just now": the age on its own (the offline wording reuses it).
        public let age: String
        /// "Updated 5 min ago", plus " · may be out of date" when stale.
        public let text: String
        /// The full date and time, with an explanation when stale.
        public let detail: String
        public let stale: Bool
    }

    public static func updatedLabel(_ timestamp: String?, now: Date = Date()) -> UpdatedLabel {
        guard let date = parse(timestamp) else {
            return UpdatedLabel(age: "an unknown time", text: "Update time unknown", detail: "", stale: false)
        }
        let seconds = now.timeIntervalSince(date)
        let minutes = Int((seconds / 60).rounded())
        let hours = Int((seconds / 3600).rounded())
        let days = Int((Double(hours) / 24).rounded())

        let age: String
        if minutes < 1 { age = "just now" }
        else if minutes < 60 { age = "\(minutes) min ago" }
        else if hours < 36 { age = "\(hours) hr ago" }
        else { age = "\(days) day\(days == 1 ? "" : "s") ago" }

        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        var detail = formatter.string(from: date)
        let stale = minutes >= staleHours * 60
        var text = "Updated \(age)"
        if stale {
            text += " · may be out of date"
            detail = "Prices last updated \(detail). They normally update every hour, so they may be out of date."
        }
        return UpdatedLabel(age: age, text: text, detail: detail, stale: stale)
    }
}
