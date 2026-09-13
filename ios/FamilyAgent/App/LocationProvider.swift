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
    private static let locationTimeout: TimeInterval = 10
    private static let authTimeout: TimeInterval = 120

    private override init() {
        super.init()
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        manager.delegate = self
    }

    var authorizationStatus: CLAuthorizationStatus { manager.authorizationStatus }

    /// Returns a location for the current chat turn, requesting the
    /// when-in-use permission first if it hasn't been decided yet. Never
    /// throws, and never hangs — nil covers denied/restricted/unavailable/
    /// timed out alike, all of which get_current_location degrades to
    /// plainly the same way.
    ///
    /// `requestLocation()`'s own delegate callback is NOT guaranteed to fire
    /// promptly (or, in practice, at all — poor signal, no network-based fix
    /// available indoors, Location Services toggled off system-wide after
    /// the per-app permission was already granted, …), and there is no
    /// built-in timeout: a caller awaiting this with no timeout of its own
    /// hangs the whole chat send forever (confirmed — the actual bug behind
    /// a report of Chat getting stuck on "…" after a "near me" question,
    /// with no failure ever surfacing). Each continuation below is guarded
    /// by its own timeout task that resumes it (with nil/Void) if nothing
    /// else has by then; the `= nil` after every resume anywhere means
    /// whichever of "the real callback" or "the timeout" runs first wins,
    /// and the other's `?.resume` on an already-nil reference is a no-op —
    /// never a double-resume.
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
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(Self.locationTimeout))
                if let pending = self.locationContinuation {
                    self.locationContinuation = nil
                    pending.resume(returning: nil)
                }
            }
        }
    }

    private func requestAuthorization() async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            authContinuation = cont
            manager.requestWhenInUseAuthorization()
            // A generous timeout, not a short one: this one resolves only
            // when the person actually answers the system permission alert,
            // which blocks all interaction until they do — the failure mode
            // here isn't "slow", it's "never came back at all" for some
            // reason (the alert failing to appear, an odd app-lifecycle
            // edge case), which is worth guarding against for the same
            // reason as the location fetch above, just with more slack.
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(Self.authTimeout))
                if let pending = self.authContinuation {
                    self.authContinuation = nil
                    pending.resume()
                }
            }
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
