@preconcurrency import CoreLocation
import Foundation

/// This device's own location, for the assistant's get_current_location tool
/// (agent-core) — the phone's GPS, requested only when Settings → "Let the
/// assistant use my location" is on and only for a Chat turn (never a family
/// Messages send). A thin async wrapper over CLLocationManager, the iOS
/// mirror of android/.../data/LocationProvider.kt.
///
/// `kCLLocationAccuracyHundredMeters`, not best/nearest — "state parks near
/// me" doesn't need turn-by-turn precision, and asking for less is a smaller
/// promise to the person granting permission.
@MainActor
final class LocationProvider: NSObject {
    static let shared = LocationProvider()

    private let manager = CLLocationManager()
    private var locationContinuation: CheckedContinuation<CLLocation?, Never>?
    private var authContinuation: CheckedContinuation<Void, Never>?
    private var cached: (location: CLLocation, capturedAt: Date)?
    private static let cacheTTL: TimeInterval = 180

    private override init() {
        super.init()
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        manager.delegate = self
    }

    var authorizationStatus: CLAuthorizationStatus { manager.authorizationStatus }

    /// Returns a location for the current chat turn, requesting the
    /// when-in-use permission first if it hasn't been decided yet. Never
    /// throws — nil covers denied/restricted/unavailable/timed out alike,
    /// all of which get_current_location degrades to plainly the same way.
    func currentLocation() async -> CLLocation? {
        if let cached, Date().timeIntervalSince(cached.capturedAt) < Self.cacheTTL {
            return cached.location
        }
        if manager.authorizationStatus == .notDetermined {
            await requestAuthorization()
        }
        guard manager.authorizationStatus == .authorizedWhenInUse || manager.authorizationStatus == .authorizedAlways else {
            return nil
        }
        return await withCheckedContinuation { (cont: CheckedContinuation<CLLocation?, Never>) in
            locationContinuation = cont
            manager.requestLocation()
        }
    }

    private func requestAuthorization() async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            authContinuation = cont
            manager.requestWhenInUseAuthorization()
        }
    }
}

extension LocationProvider: CLLocationManagerDelegate {
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            self.authContinuation?.resume()
            self.authContinuation = nil
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        Task { @MainActor in
            guard let loc = locations.last else {
                self.locationContinuation?.resume(returning: nil)
                self.locationContinuation = nil
                return
            }
            self.cached = (loc, Date())
            self.locationContinuation?.resume(returning: loc)
            self.locationContinuation = nil
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in
            self.locationContinuation?.resume(returning: nil)
            self.locationContinuation = nil
        }
    }
}
