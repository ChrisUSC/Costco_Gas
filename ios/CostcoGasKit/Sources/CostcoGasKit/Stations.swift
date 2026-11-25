import Foundation

// --- Station records: the store list, price snapshots, addresses and directions links
//     (port of public/js/stores.js) ---

public enum DataError: Error, LocalizedError, Equatable {
    case malformed(String)
    case http(Int)

    public var errorDescription: String? {
        switch self {
        case .malformed(let what): return "The \(what) couldn't be read."
        case .http(let status): return "The server returned \(status)."
        }
    }
}

/// One warehouse from us_stores.json.
public struct StoreInfo: Hashable, Sendable {
    public var url: String?
    public var coordinate: LatLng?
    public var address: String?
    public var phone: String?
    public var gasHours: WeeklyHours?
    public var timeZone: String?
}

/// us_stores.json: `{ "CA": { "Turlock": { lat, lng, address, phone, gas_hours, tz, url } } }`.
public struct StoreDirectory: Sendable {
    public var states: [String: [String: StoreInfo]]

    public init(states: [String: [String: StoreInfo]]) {
        self.states = states
    }

    public init(data: Data) throws {
        guard let top = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw DataError.malformed("store list")
        }
        var states: [String: [String: StoreInfo]] = [:]
        for (stateCode, value) in top {
            guard let cities = value as? [String: Any] else { continue }
            var parsed: [String: StoreInfo] = [:]
            for (city, raw) in cities {
                guard let info = raw as? [String: Any] else { continue }
                parsed[city] = StoreDirectory.parseInfo(info)
            }
            states[stateCode] = parsed
        }
        self.states = states
    }

    static func parseInfo(_ info: [String: Any]) -> StoreInfo {
        var coordinate: LatLng?
        if let lat = parsePrice(info["lat"]), let lng = parsePrice(info["lng"]), lat != 0, lng != 0 {
            coordinate = LatLng(lat, lng)
        }
        var hours: WeeklyHours?
        if let raw = info["gas_hours"] as? [String: Any] {
            var week: WeeklyHours = [:]
            for (day, value) in raw {
                if let pair = value as? [String], pair.count >= 2 {
                    week[day] = DayHours(open: pair[0], close: pair[1])
                }
            }
            hours = week
        }
        return StoreInfo(
            url: info["url"] as? String,
            coordinate: coordinate,
            address: info["address"] as? String,
            phone: (info["phone"] as? String).flatMap { $0.isEmpty ? nil : $0 },
            gasHours: hours,
            timeZone: (info["tz"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        )
    }
}

/// us_latest.json: the current prices, plus the prices about 72 hours earlier for trends.
public struct PriceSnapshot: Sendable {
    public var timestamp: String?
    public var previousTimestamp: String?
    public var prices: [String: [String: GradePrices]]
    public var previous: [String: [String: GradePrices]]

    public init(timestamp: String?, previousTimestamp: String? = nil,
                prices: [String: [String: GradePrices]], previous: [String: [String: GradePrices]] = [:]) {
        self.timestamp = timestamp
        self.previousTimestamp = previousTimestamp
        self.prices = prices
        self.previous = previous
    }

    public init(data: Data) throws {
        guard let top = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw DataError.malformed("price snapshot")
        }
        timestamp = top["timestamp"] as? String
        previousTimestamp = top["previous_timestamp"] as? String
        prices = PriceSnapshot.parseTable(top["prices"])
        previous = PriceSnapshot.parseTable(top["previous"])
    }

    /// `{ "CA": { "Turlock": [4.19, 4.59, null] } }`
    static func parseTable(_ value: Any?) -> [String: [String: GradePrices]] {
        guard let states = value as? [String: Any] else { return [:] }
        var out: [String: [String: GradePrices]] = [:]
        for (stateCode, cities) in states {
            guard let cities = cities as? [String: Any] else { continue }
            var parsed: [String: GradePrices] = [:]
            for (city, raw) in cities {
                if let p = GradePrices.parse(raw) { parsed[city] = p }
            }
            out[stateCode] = parsed
        }
        return out
    }
}

public struct Station: Identifiable, Hashable, Sendable {
    public let state: String
    public let city: String
    public let address: String?
    public let coordinate: LatLng?
    public let url: String?
    public let phone: String?
    public let gasHours: WeeklyHours?
    public let timeZone: String?
    public var prices: GradePrices
    public var previous: GradePrices?

    public init(state: String, city: String, address: String? = nil, coordinate: LatLng? = nil, url: String? = nil,
                phone: String? = nil, gasHours: WeeklyHours? = nil, timeZone: String? = nil,
                prices: GradePrices, previous: GradePrices? = nil) {
        self.state = state
        self.city = city
        self.address = address
        self.coordinate = coordinate
        self.url = url
        self.phone = phone
        self.gasHours = gasHours
        self.timeZone = timeZone
        self.prices = prices
        self.previous = previous
    }

    /// "CA_Turlock": how stations are named in ?store= links and saved favorites.
    public var id: String { Station.key(state: state, city: city) }

    public static func key(state: String, city: String) -> String { "\(state)_\(city)" }

    public static func parseKey(_ key: String) -> (state: String, city: String)? {
        guard let sep = key.firstIndex(of: "_") else { return nil }
        let state = String(key[..<sep])
        let city = String(key[key.index(after: sep)...])
        return state.isEmpty || city.isEmpty ? nil : (state, city)
    }

    public var name: String { "\(city), \(state)" }
    public func price(_ grade: Grade) -> Double? { prices[grade] }
    public func previousPrice(_ grade: Grade) -> Double? { previous?[grade] }
    public func hasPrice(_ grade: Grade) -> Bool { prices[grade] != nil }
    public func trend(_ grade: Grade) -> Trend? { Trend(current: price(grade), previous: previousPrice(grade)) }

    /// Every grade except Diesel at stations that don't sell it.
    public var visibleGrades: [Grade] { Grade.allCases.filter { $0 != .diesel || hasPrice(.diesel) } }

    public var displayAddress: String { formatAddress(address) }

    public var phoneURL: URL? {
        guard let phone else { return nil }
        let digits = phone.filter { $0.isNumber || $0 == "+" }
        return digits.isEmpty ? nil : URL(string: "tel:\(digits)")
    }

    /// Case-insensitive match of the city, address or state against a lowercased query.
    public func matches(_ lowercasedQuery: String) -> Bool {
        city.lowercased().contains(lowercasedQuery)
            || (address ?? "").lowercased().contains(lowercasedQuery)
            || state.lowercased().contains(lowercasedQuery)
    }
}

/// Every station in the store list that has an entry in the snapshot, sorted by state then city.
public func buildStations(snapshot: PriceSnapshot, directory: StoreDirectory) -> [Station] {
    var out: [Station] = []
    for stateCode in directory.states.keys.sorted() {
        guard let statePrices = snapshot.prices[stateCode], let cities = directory.states[stateCode] else { continue }
        for city in cities.keys.sorted() {
            guard let prices = statePrices[city], let info = cities[city] else { continue }
            out.append(Station(
                state: stateCode, city: city, address: info.address, coordinate: info.coordinate, url: info.url,
                phone: info.phone, gasHours: info.gasHours, timeZone: info.timeZone,
                prices: prices, previous: snapshot.previous[stateCode]?[city]
            ))
        }
    }
    return out
}

// MARK: - Addresses

private let addressKeepUpper: Set<String> = ["N", "S", "E", "W", "NE", "NW", "SE", "SW", "US", "PO", "SR", "CR", "FM"]

/// Store addresses arrive in capitals ("2207 W COMMONWEALTH AVE, ALHAMBRA, CA 91803-1302").
/// Title-case them for reading, keeping state codes, compass points and highway prefixes.
public func formatAddress(_ address: String?) -> String {
    guard let address, !address.isEmpty else { return "" }
    if address.contains(where: { ("a"..."z").contains($0) }) { return address }

    func titleWord(_ w: String) -> String {
        if addressKeepUpper.contains(w) { return w }
        guard let first = w.first else { return w }
        if ("0"..."9").contains(first) { return w.lowercased() }
        return String(first) + w.dropFirst().lowercased()
    }
    func isStateCode(_ w: String) -> Bool { w.count == 2 && w.allSatisfy { ("A"..."Z").contains($0) } }

    let parts = address.components(separatedBy: ",")
    return parts.enumerated().map { i, part in
        let isLast = i == parts.count - 1
        return part.components(separatedBy: " ").map { word -> String in
            if isLast && isStateCode(word) { return word }
            return word.components(separatedBy: "-").map(titleWord).joined(separator: "-")
        }.joined(separator: " ")
    }.joined(separator: ",")
}

// MARK: - Directions

public enum DirectionsApp: String, CaseIterable, Codable, Identifiable, Sendable {
    case google, apple, waze

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .google: return "Google Maps"
        case .apple: return "Apple Maps"
        case .waze: return "Waze"
        }
    }
}

/// Like JavaScript's encodeURIComponent.
public func encodeURIComponent(_ s: String) -> String {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-_.!~*'()")
    return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
}

/// Turn-by-turn directions to the station in the chosen app (each opens the app if installed).
public func directionsURL(for station: Station, app: DirectionsApp) -> URL {
    let coords = station.coordinate.map { "\($0.lat),\($0.lng)" }
    let address = "Costco Gas, \(station.address ?? "\(station.city), \(station.state)")"
    let target = encodeURIComponent(coords ?? address)
    let string: String
    switch app {
    case .apple:
        string = "https://maps.apple.com/?daddr=\(target)&dirflg=d"
    case .waze:
        string = coords != nil
            ? "https://waze.com/ul?ll=\(target)&navigate=yes"
            : "https://waze.com/ul?q=\(target)&navigate=yes"
    case .google:
        string = "https://www.google.com/maps/dir/?api=1&destination=\(target)"
    }
    return URL(string: string)!
}
