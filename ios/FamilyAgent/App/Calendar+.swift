import Foundation

extension Calendar {
    /// Gregorian calendar pinned to a Monday first-weekday — the Android app
    /// hard-codes Monday-start (`mondayOf`), independent of device locale.
    static var gregorianMonday: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.firstWeekday = 2  // Monday
        c.timeZone = .current
        return c
    }
}

extension Date {
    /// "yyyy-MM-dd" in the current timezone.
    var isoDay: String {
        let f = DateFormatter()
        f.calendar = .gregorianMonday
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: self)
    }
}

/// Parse a "yyyy-MM-dd" day string to a local Date at midnight.
func parseISODay(_ s: String?) -> Date? {
    guard let s, s.count >= 10 else { return nil }
    let f = DateFormatter()
    f.calendar = .gregorianMonday
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = .current
    f.dateFormat = "yyyy-MM-dd"
    return f.date(from: String(s.prefix(10)))
}

/// Minutes-of-day from "HH:MM", or nil.
func parseMinutesOfDay(_ hhmm: String?) -> Int? {
    guard let hhmm, hhmm.count >= 4 else { return nil }
    let parts = hhmm.split(separator: ":")
    guard parts.count == 2, let h = Int(parts[0]), let m = Int(parts[1]) else { return nil }
    return h * 60 + m
}

func hhmm(fromMinutes total: Int) -> String {
    String(format: "%02d:%02d", (total / 60) % 24, total % 60)
}

/// "MMM d · h:mm a" for an ISO string — mirrors Android `shortWhen` (routines).
func shortWhen(_ iso: String) -> String {
    let parsers = [ISO8601DateFormatter(), { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()]
    let date = parsers.compactMap { $0.date(from: iso) }.first
        ?? { let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd'T'HH:mm"; return f.date(from: String(iso.prefix(16))) }()
    guard let date else { return iso }
    let f = DateFormatter()
    f.locale = .current
    f.dateFormat = "MMM d · h:mm a"
    return f.string(from: date)
}

/// Friendly relative-ish timestamp for an ISO string (activity, chat sessions).
func friendlyTimestamp(_ iso: String) -> String {
    // Server sends ISO 8601; take the "T…" time or fall back to the raw string.
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let date = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    guard let date else { return iso }
    let rel = RelativeDateTimeFormatter()
    rel.unitsStyle = .abbreviated
    if abs(date.timeIntervalSinceNow) < 60 { return "just now" }
    if abs(date.timeIntervalSinceNow) < 86_400 * 6 {
        return rel.localizedString(for: date, relativeTo: .now)
    }
    let df = DateFormatter()
    df.dateStyle = .medium
    df.timeStyle = .short
    return df.string(from: date)
}
