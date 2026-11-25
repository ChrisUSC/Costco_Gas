import Foundation

// --- Network services: price snapshots with an on-disk copy for offline use, OSRM driving
//     routes, Nominatim place search and the IP-based state guess ---

/// The website that serves us_latest.json, us_history.json (from R2) and us_stores.json.
public let siteURL = URL(string: "https://costco-gas.pages.dev/")!

public struct FetchResult: Sendable {
    public let data: Data
    /// True when the network couldn't be reached and this is the saved copy.
    public let fromSavedCopy: Bool
}

/// Fetches snapshot files from the site and keeps the last good copy of each on disk, so the
/// app opens offline with the last prices it saw (what sw.js does for the website).
public final class SnapshotClient: @unchecked Sendable {
    public let baseURL: URL
    private let session: URLSession
    private let directory: URL

    public init(baseURL: URL = siteURL, session: URLSession = .shared, directory: URL? = nil) {
        self.baseURL = baseURL
        self.session = session
        if let directory {
            self.directory = directory
        } else {
            let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? FileManager.default.temporaryDirectory
            self.directory = support.appendingPathComponent("Snapshots", isDirectory: true)
        }
    }

    public func url(for name: String, cacheBuster: String) -> URL {
        var comps = URLComponents(url: baseURL.appendingPathComponent(name), resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "t", value: cacheBuster)]
        return comps.url!
    }

    /// From the network only.
    public func fetchFromNetwork(_ name: String, cacheBuster: String, timeout: TimeInterval = 20) async throws -> Data {
        let request = URLRequest(url: url(for: name, cacheBuster: cacheBuster),
                                 cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        let (data, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw DataError.http(http.statusCode)
        }
        return data
    }

    /// From the network, else the saved copy, else `fallback` (a copy bundled with the app).
    /// Call `save` once the data has been read successfully.
    public func fetch(_ name: String, cacheBuster: String, fallback: URL? = nil) async throws -> FetchResult {
        do {
            let data = try await fetchFromNetwork(name, cacheBuster: cacheBuster)
            return FetchResult(data: data, fromSavedCopy: false)
        } catch {
            if let saved = savedCopy(name) { return FetchResult(data: saved, fromSavedCopy: true) }
            if let fallback, let bundled = try? Data(contentsOf: fallback) {
                return FetchResult(data: bundled, fromSavedCopy: true)
            }
            throw error
        }
    }

    public func savedCopy(_ name: String) -> Data? {
        try? Data(contentsOf: directory.appendingPathComponent(name))
    }

    public func savedCopyDate(_ name: String) -> Date? {
        let attrs = try? FileManager.default.attributesOfItem(atPath: directory.appendingPathComponent(name).path)
        return attrs?[.modificationDate] as? Date
    }

    /// Atomic, so a crash can't leave a truncated copy.
    public func save(_ data: Data, as name: String) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? data.write(to: directory.appendingPathComponent(name), options: .atomic)
    }
}

// MARK: - Live price for one store

/// Asks Costco directly for one warehouse's current prices: the same request the scrapers
/// make for every store each hour (scraper/costco.js, pipeline get_gas_prices_ajax). Used when
/// a station is opened. It's a single reading, without the scrapers' re-fetch-until-a-quorum-
/// agrees check, so it's shown as live and never saved into the shared price files.
public enum LivePriceService {
    /// A browser user agent, as the scrapers send: Costco's servers turn away unknown clients.
    static let userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

    public static func url(warehouseID: String) -> URL {
        var comps = URLComponents(string: "https://www.costco.com/AjaxGetGasPricesService")!
        // A unique query string so no cache along the way answers with an old reply.
        comps.queryItems = [
            URLQueryItem(name: "warehouseid", value: warehouseID),
            URLQueryItem(name: "_", value: String(Int(Date().timeIntervalSince1970 * 1000)))
        ]
        return comps.url!
    }

    /// Reads `{"146": {"regular": "4.999", "premium": "5.599", "diesel": ""}}`, rounding to
    /// cents like the scrapers. Nil when no grade has a price.
    public static func parse(_ data: Data) -> GradePrices? {
        guard let top = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let inner = top.values.first as? [String: Any] else { return nil }
        var lower: [String: Any] = [:]
        for (key, value) in inner { lower[key.lowercased()] = value }
        func cents(_ value: Any?) -> Double? {
            parsePrice(value).map { ($0 * 100).rounded() / 100 }
        }
        let prices = GradePrices(regular: cents(lower["regular"]), premium: cents(lower["premium"]),
                                 diesel: cents(lower["diesel"]))
        return prices.regular == nil && prices.premium == nil && prices.diesel == nil ? nil : prices
    }

    public static func fetch(warehouseID: String, session: URLSession = .shared) async throws -> GradePrices {
        var request = URLRequest(url: url(warehouseID: warehouseID), cachePolicy: .reloadIgnoringLocalCacheData,
                                 timeoutInterval: 10)
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("application/json, text/plain, */*", forHTTPHeaderField: "Accept")
        request.setValue("no-cache, no-store", forHTTPHeaderField: "Cache-Control")
        request.setValue("no-cache", forHTTPHeaderField: "Pragma")
        let (data, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw DataError.http(http.statusCode)
        }
        guard let prices = parse(data) else { throw DataError.malformed("live price") }
        return prices
    }
}

// MARK: - Places

public struct Place: Codable, Hashable, Sendable {
    public var lat: Double
    public var lng: Double
    public var label: String

    public init(lat: Double, lng: Double, label: String) {
        self.lat = lat
        self.lng = lng
        self.label = label
    }

    public init(_ coordinate: LatLng, label: String) {
        self.init(lat: coordinate.lat, lng: coordinate.lng, label: label)
    }

    public var coordinate: LatLng { LatLng(lat, lng) }

    /// A route end labelled this means wherever the device is now, not where it was saved.
    public static let yourLocationLabel = "Your location"
    public var isYourLocation: Bool { label == Place.yourLocationLabel }
}

/// A saved route, stored the same way as the website's favoriteRoutes.
public struct SavedRoute: Codable, Hashable, Identifiable, Sendable {
    public var id: Int64
    public var origin: Place
    public var destination: Place
    public var bufferMiles: Double

    public init(id: Int64, origin: Place, destination: Place, bufferMiles: Double) {
        self.id = id
        self.origin = origin
        self.destination = destination
        self.bufferMiles = bufferMiles
    }

    public func sameRoute(as other: SavedRoute) -> Bool {
        origin.label == other.origin.label && destination.label == other.destination.label && bufferMiles == other.bufferMiles
    }
}

// MARK: - Driving routes (OSRM)

public struct DrivingRoute: Codable, Hashable, Sendable {
    public let coords: [LatLng]
    public let distanceMiles: Double
    /// True when live routing failed and this is a straight line between the two ends.
    public let isApproximate: Bool

    public init(coords: [LatLng], distanceMiles: Double, isApproximate: Bool) {
        self.coords = coords
        self.distanceMiles = distanceMiles
        self.isApproximate = isApproximate
    }
}

public enum RouteService {
    struct OSRMResponse: Decodable {
        struct Route: Decodable {
            struct Geometry: Decodable { let coordinates: [[Double]] }
            let distance: Double
            let geometry: Geometry
        }
        let code: String
        let routes: [Route]?
    }

    public static func osrmURL(from origin: LatLng, to destination: LatLng) -> URL {
        URL(string: "https://router.project-osrm.org/route/v1/driving/\(origin.lng),\(origin.lat);\(destination.lng),\(destination.lat)?overview=full&geometries=geojson")!
    }

    /// Reads an OSRM /route response.
    public static func decode(_ data: Data) throws -> DrivingRoute {
        let response = try JSONDecoder().decode(OSRMResponse.self, from: data)
        guard response.code == "Ok", let route = response.routes?.first else {
            throw DataError.malformed("route")
        }
        let coords = route.geometry.coordinates.compactMap { $0.count >= 2 ? LatLng($0[1], $0[0]) : nil }
        guard !coords.isEmpty else { throw DataError.malformed("route") }
        return DrivingRoute(coords: coords, distanceMiles: route.distance / 1609.34, isApproximate: false)
    }

    /// The driving route, or a straight-line corridor when routing is unavailable (8 s limit).
    public static func drivingRoute(from origin: LatLng, to destination: LatLng,
                                    session: URLSession = .shared) async -> DrivingRoute {
        do {
            let request = URLRequest(url: osrmURL(from: origin, to: destination), timeoutInterval: 8)
            let (data, response) = try await session.data(for: request)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                throw DataError.http(http.statusCode)
            }
            return try decode(data)
        } catch {
            return DrivingRoute(coords: [origin, destination],
                                distanceMiles: distanceMiles(origin, destination), isApproximate: true)
        }
    }
}

// MARK: - Place search (Nominatim)

public struct GeoResult: Identifiable, Hashable, Sendable {
    public let id: String
    public let place: Place
    /// "City", "Zip Code", "Address", …
    public let kind: String
}

public enum Geocoder {
    /// Nominatim asks every client to identify itself.
    public static let userAgent = "CostcoGasPrices-iOS/1.0"

    struct NominatimResult: Decodable {
        let lat: String
        let lon: String
        let display_name: String
        let type: String?
        let addresstype: String?
        let address: [String: String]?
        let osm_id: Int64?
    }

    static let kindLabels: [String: String] = [
        "postcode": "Zip Code", "city": "City", "town": "Town", "village": "Village", "hamlet": "Town",
        "county": "County", "state": "State", "suburb": "Neighborhood", "neighbourhood": "Neighborhood",
        "administrative": "Area", "house": "Address", "building": "Building", "amenity": "Place",
        "road": "Street", "yes": "Address"
    ]

    static func kind(_ r: NominatimResult) -> String {
        kindLabels[r.addresstype ?? r.type ?? "place"] ?? "Location"
    }

    /// "1600 Main St, Turlock, CA", "95380 — Turlock, CA" or "Turlock, CA".
    static func shortName(_ r: NominatimResult) -> String {
        let addr = r.address ?? [:]
        var street = ""
        if let num = addr["house_number"], let road = addr["road"] {
            street = "\(num) \(road)"
        } else if let road = addr["road"] {
            street = road
        } else if let place = addr["amenity"] ?? addr["shop"] ?? addr["building"] {
            street = place
        }
        let city = addr["city"] ?? addr["town"] ?? addr["village"] ?? addr["hamlet"] ?? addr["county"] ?? ""
        let state = addr["ISO3166-2-lvl4"].flatMap { $0.split(separator: "-").last.map(String.init) } ?? addr["state"] ?? ""

        if !street.isEmpty {
            return [street, city, state].filter { !$0.isEmpty }.joined(separator: ", ")
        }
        let main = city.isEmpty ? (r.display_name.components(separatedBy: ",").first ?? r.display_name) : city
        if let postcode = addr["postcode"], r.addresstype == "postcode" {
            return state.isEmpty ? "\(postcode) — \(main)" : "\(postcode) — \(main), \(state)"
        }
        return state.isEmpty ? main : "\(main), \(state)"
    }

    public static func searchURL(_ query: String, limit: Int, viewbox: GeoBounds?) -> URL {
        var comps = URLComponents(string: "https://nominatim.openstreetmap.org/search")!
        var items = [
            URLQueryItem(name: "format", value: "json"),
            URLQueryItem(name: "addressdetails", value: "1"),
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "countrycodes", value: "us"),
            URLQueryItem(name: "q", value: query)
        ]
        if let b = viewbox {
            items.append(URLQueryItem(name: "viewbox", value: "\(b.minLng),\(b.maxLat),\(b.maxLng),\(b.minLat)"))
        }
        comps.queryItems = items
        return comps.url!
    }

    static func decode(_ data: Data) throws -> [GeoResult] {
        try JSONDecoder().decode([NominatimResult].self, from: data).compactMap { r in
            guard let lat = Double(r.lat), let lng = Double(r.lon) else { return nil }
            return GeoResult(id: r.osm_id.map(String.init) ?? "\(r.lat),\(r.lon)",
                             place: Place(lat: lat, lng: lng, label: shortName(r)), kind: kind(r))
        }
    }

    /// Places matching the query, preferring ones inside `viewbox` (the map in view).
    public static func search(_ query: String, limit: Int = 5, viewbox: GeoBounds? = nil,
                              session: URLSession = .shared) async throws -> [GeoResult] {
        var request = URLRequest(url: searchURL(query, limit: limit, viewbox: viewbox), timeoutInterval: 10)
        request.setValue("en-US", forHTTPHeaderField: "Accept-Language")
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        let (data, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw DataError.http(http.statusCode)
        }
        return try decode(data)
    }

    /// "37.5, -120.8" typed in as coordinates.
    public static func parseCoordinates(_ query: String) -> Place? {
        let parts = query.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        guard parts.count == 2, let lat = Double(parts[0]), let lng = Double(parts[1]),
              abs(lat) <= 90, abs(lng) <= 180 else { return nil }
        return Place(lat: lat, lng: lng, label: "\(parts[0]), \(parts[1])")
    }

    /// The best single match for a typed place, or nil.
    public static func geocode(_ query: String, viewbox: GeoBounds? = nil) async -> Place? {
        if let coords = parseCoordinates(query) { return coords }
        return (try? await search(query, limit: 1, viewbox: viewbox))?.first?.place
    }
}

// MARK: - State guess

public enum IPRegion {
    /// The two-letter state for the connection's IP address, used to pick the State lowest
    /// leaderboard before (or without) location access.
    public static func guessState(session: URLSession = .shared) async -> String? {
        guard let url = URL(string: "https://ipapi.co/region_code/") else { return nil }
        let request = URLRequest(url: url, timeoutInterval: 5)
        guard let result = try? await session.data(for: request),
              (result.1 as? HTTPURLResponse)?.statusCode == 200,
              let code = String(data: result.0, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              code.count == 2 else { return nil }
        return code.uppercased()
    }
}
