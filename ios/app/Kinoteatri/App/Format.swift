// Times, sizes and dates as the screens show them.

import Foundation

enum Format {
    /// 2530 → "42:10"; 3730 → "1:02:10".
    static func clock(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        let total = Int(seconds.rounded(.down))
        let (hours, minutes, secs) = (total / 3600, (total % 3600) / 60, total % 60)
        return hours > 0
            ? String(format: "%d:%02d:%02d", hours, minutes, secs)
            : String(format: "%d:%02d", minutes, secs)
    }

    /// 2530 → "42 min"; 3900 → "1 h 5 min" (the system's words for the units).
    static func duration(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds > 0 else { return "" }
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = seconds >= 3600 ? [.hour, .minute] : [.minute]
        formatter.unitsStyle = .short
        formatter.zeroFormattingBehavior = .dropAll
        return formatter.string(from: max(60, seconds)) ?? ""
    }

    static func bytes(_ count: UInt64?) -> String? {
        count.map { ByteCountFormatter.string(fromByteCount: Int64(clamping: $0), countStyle: .file) }
    }

    /// A stream's facts: "4.2 GB · HEVC · English".
    static func facts(_ stream: Stream) -> String {
        [bytes(stream.sizeBytes), stream.codec?.uppercased(), stream.audio]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
    }

    /// "2 hours ago", "yesterday".
    static func ago(_ date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        formatter.dateTimeStyle = .named
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    /// Where a watch stands: "42 min left", "Watched", "Not started".
    static func standing(_ entry: WatchEntry) -> String {
        if entry.isFinished {
            return L.watched
        }
        guard entry.position >= 5 else { return L.notStarted }
        if let duration = entry.duration, duration > entry.position {
            return L.timeLeft(Format.duration(duration - entry.position))
        }
        return Format.clock(entry.position)
    }
}
