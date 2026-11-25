import Foundation

// --- Distances and route-corridor geometry (port of public/js/geo.js) ---

public struct LatLng: Codable, Hashable, Sendable {
    public var lat: Double
    public var lng: Double

    public init(_ lat: Double, _ lng: Double) {
        self.lat = lat
        self.lng = lng
    }
}

/// Great-circle distance in miles.
public func distanceMiles(_ a: LatLng, _ b: LatLng) -> Double {
    let r = 3958.8
    let dLat = (b.lat - a.lat) * .pi / 180
    let dLon = (b.lng - a.lng) * .pi / 180
    let h = pow(sin(dLat / 2), 2) + cos(a.lat * .pi / 180) * cos(b.lat * .pi / 180) * pow(sin(dLon / 2), 2)
    return r * (2 * atan2(sqrt(h), sqrt(1 - h)))
}

/// Distance from a point to the segment a–b, on a flat projection around the segment.
public func distanceToSegmentMiles(_ p: LatLng, _ a: LatLng, _ b: LatLng) -> Double {
    var cosMid = cos(((a.lat + b.lat) / 2) * .pi / 180)
    if cosMid == 0 { cosMid = 0.000001 }
    let x = (p.lng - a.lng) * cosMid
    let y = p.lat - a.lat
    let dx = (b.lng - a.lng) * cosMid
    let dy = b.lat - a.lat
    let lenSq = dx * dx + dy * dy
    let t = lenSq == 0 ? 0 : max(0, min(1, (x * dx + y * dy) / lenSq))
    return distanceMiles(p, LatLng(a.lat + t * dy, a.lng + (t * dx) / cosMid))
}

public func minDistanceToRouteMiles(_ p: LatLng, _ route: [LatLng]) -> Double {
    guard let first = route.first else { return .infinity }
    if route.count == 1 { return distanceMiles(p, first) }
    var best = Double.infinity
    for i in 0..<(route.count - 1) {
        best = min(best, distanceToSegmentMiles(p, route[i], route[i + 1]))
    }
    return best
}

public struct GeoBounds: Hashable, Sendable {
    public var minLat: Double
    public var maxLat: Double
    public var minLng: Double
    public var maxLng: Double

    public init(minLat: Double, maxLat: Double, minLng: Double, maxLng: Double) {
        self.minLat = minLat
        self.maxLat = maxLat
        self.minLng = minLng
        self.maxLng = maxLng
    }

    public func contains(_ p: LatLng) -> Bool {
        p.lat >= minLat && p.lat <= maxLat && p.lng >= minLng && p.lng <= maxLng
    }
}

/// The route's bounding box grown by `bufferMiles`, a cheap first filter before measuring
/// each station's distance to the route.
public func routeBoundsPadded(_ route: [LatLng], bufferMiles: Double) -> GeoBounds {
    var minLat = Double.infinity, maxLat = -Double.infinity
    var minLng = Double.infinity, maxLng = -Double.infinity
    for p in route {
        minLat = min(minLat, p.lat); maxLat = max(maxLat, p.lat)
        minLng = min(minLng, p.lng); maxLng = max(maxLng, p.lng)
    }
    let midLat = (minLat + maxLat) / 2
    let padLat = bufferMiles / 69
    let padLng = bufferMiles / (69 * max(0.2, cos(midLat * .pi / 180)))
    return GeoBounds(minLat: minLat - padLat, maxLat: maxLat + padLat, minLng: minLng - padLng, maxLng: maxLng + padLng)
}
