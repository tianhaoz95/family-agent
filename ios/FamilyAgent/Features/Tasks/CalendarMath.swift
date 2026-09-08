import Foundation

enum CalendarMath {
    static let cal = Calendar.gregorianMonday

    static func mondayOf(_ date: Date) -> Date {
        let comps = cal.dateComponents([.yearForWeekOfYear, .weekOfYear], from: date)
        return cal.date(from: comps) ?? cal.startOfDay(for: date)
    }

    static func rangeDays(view: String, anchor: Date) -> [Date] {
        let start = cal.startOfDay(for: anchor)
        switch view {
        case "day":   return [start]
        case "3day":  return (0..<3).compactMap { cal.date(byAdding: .day, value: $0, to: start) }
        case "week":
            let mon = mondayOf(anchor)
            return (0..<7).compactMap { cal.date(byAdding: .day, value: $0, to: mon) }
        default:      return [start]
        }
    }

    /// 6×7 grid of days for the month containing `anchor`, starting on Monday.
    static func monthGrid(anchor: Date) -> [Date] {
        let comps = cal.dateComponents([.year, .month], from: anchor)
        guard let first = cal.date(from: comps) else { return [] }
        let gridStart = mondayOf(first)
        return (0..<42).compactMap { cal.date(byAdding: .day, value: $0, to: gridStart) }
    }

    static func dayKey(_ date: Date) -> String { date.isoDay }

    static func isSameMonth(_ a: Date, _ b: Date) -> Bool {
        cal.component(.month, from: a) == cal.component(.month, from: b)
            && cal.component(.year, from: a) == cal.component(.year, from: b)
    }
}

extension TaskItem {
    var dayKey: String? { dueDate.map { String($0.prefix(10)) } }
    var minutesOfDay: Int? { parseMinutesOfDay(dueTime) }
}
