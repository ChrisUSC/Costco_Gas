import CoreLocation
import CostcoGasKit
import Foundation

enum LocationError: LocalizedError {
    case denied, timedOut, unavailable

    var errorDescription: String? {
        switch self {
        case .denied: return "Location access is off. Turn it on in Settings › Costco Gas, or search for a city instead."
        case .timedOut: return "Locating you timed out. Try again, or search for a city instead."
        case .unavailable: return "Couldn't get your location. Try again, or search for a city instead."
        }
    }
}

/// One-shot positions from Core Location, as async calls.
@MainActor
final class LocationService: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var pending: [UUID: CheckedContinuation<LatLng, Error>] = [:]
    private var authorizationWaiters: [CheckedContinuation<Void, Never>] = []

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    var isAuthorized: Bool {
        let status = manager.authorizationStatus
        return status == .authorizedWhenInUse || status == .authorizedAlways
    }

    /// The position, but only if location access is already allowed: never shows the
    /// permission prompt. `maxAge` is how old a cached position may be.
    func currentIfAuthorized(maxAge: TimeInterval = 600) async -> LatLng? {
        guard isAuthorized else { return nil }
        if let cached = manager.location, -cached.timestamp.timeIntervalSinceNow <= maxAge {
            return LatLng(cached.coordinate)
        }
        return try? await requestFix(timeout: 5)
    }

    /// The position, asking for permission the first time.
    func requestLocation() async throws -> LatLng {
        switch manager.authorizationStatus {
        case .denied, .restricted:
            throw LocationError.denied
        case .notDetermined:
            await withCheckedContinuation { continuation in
                authorizationWaiters.append(continuation)
                manager.requestWhenInUseAuthorization()
            }
            guard isAuthorized else { throw LocationError.denied }
        default:
            break
        }
        return try await requestFix(timeout: 15)
    }

    private func requestFix(timeout: TimeInterval) async throws -> LatLng {
        try await withCheckedThrowingContinuation { continuation in
            let id = UUID()
            pending[id] = continuation
            manager.requestLocation()
            Task {
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                self.finish(id, with: .failure(LocationError.timedOut))
            }
        }
    }

    private func finish(_ id: UUID, with result: Result<LatLng, LocationError>) {
        pending.removeValue(forKey: id)?.resume(with: result)
    }

    private func finishAll(with result: Result<LatLng, LocationError>) {
        let waiting = pending
        pending = [:]
        for continuation in waiting.values { continuation.resume(with: result) }
    }

    private func authorizationChanged() {
        guard manager.authorizationStatus != .notDetermined else { return }
        let waiters = authorizationWaiters
        authorizationWaiters = []
        for waiter in waiters { waiter.resume() }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let last = locations.last else { return }
        let position = LatLng(last.coordinate.latitude, last.coordinate.longitude)
        Task { @MainActor in self.finishAll(with: .success(position)) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let denied = (error as? CLError)?.code == .denied
        Task { @MainActor in self.finishAll(with: .failure(denied ? .denied : .unavailable)) }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in self.authorizationChanged() }
    }
}
