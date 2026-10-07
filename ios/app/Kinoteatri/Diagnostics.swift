// "Copy diagnostics": the last 200 lines of what the app did, for when a film won't play on the
// phone. The core's version, the requests to the core (op names and ids), play sessions, the
// player's status (item status, error and access log summaries, stalls).
// Never cookies, headers, tokens or stream addresses: every line goes through `redact`. A URL keeps
// only its host (the core's own 127.0.0.1 server: its path, without the query); anything shaped
// like a cookie, a token or a signature is cut.

import Foundation

final class Diagnostics: @unchecked Sendable {
    static let shared = Diagnostics(echo: true)
    /// How many lines are kept.
    static let capacity = 200
    /// Longer lines are cut.
    static let maxLineLength = 300

    private let capacity: Int
    /// Also print each line (debug builds), so test logs show them.
    private let echo: Bool
    private let lock = NSLock()
    private var buffer: [String] = []
    private let clock: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "HH:mm:ss.SSS"
        return formatter
    }()

    init(capacity: Int = Diagnostics.capacity, echo: Bool = false) {
        self.capacity = max(1, capacity)
        self.echo = echo
    }

    /// Adds a line (redacted, with the time); the oldest goes once there are `capacity`.
    func log(_ message: String) {
        var text = Self.redact(message)
        if text.count > Self.maxLineLength {
            text = String(text.prefix(Self.maxLineLength)) + "…"
        }
        lock.lock()
        let line = "\(clock.string(from: Date())) \(text)"
        buffer.append(line)
        if buffer.count > capacity {
            buffer.removeFirst(buffer.count - capacity)
        }
        lock.unlock()
        #if DEBUG
        if echo {
            print("[diag] \(line)")
        }
        #endif
    }

    /// The lines kept, oldest first.
    var lines: [String] {
        lock.lock()
        defer { lock.unlock() }
        return buffer
    }

    /// What "Copy diagnostics" copies: the app, the device, the system, then the lines.
    var text: String {
        let header = "Kinoteatri \(Self.appVersion) · \(Self.deviceModel) · \(ProcessInfo.processInfo.operatingSystemVersionString)"
        return ([header] + lines).joined(separator: "\n")
    }

    /// "0.1.0 (1)"
    static let appVersion: String = {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "?"
        let build = info["CFBundleVersion"] as? String ?? "?"
        return "\(version) (\(build))"
    }()

    /// "iPhone17,1", or the simulated model in the Simulator.
    static let deviceModel: String = {
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] {
            return "\(simulated) Simulator"
        }
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { bytes in
            String(decoding: bytes.prefix { $0 != 0 }, as: UTF8.self)
        }
    }()

    // MARK: Redaction

    /// `text` without secrets: URLs shortened (see `shortenURLs`), then cookie and authorization
    /// headers, bearer tokens, JWTs, key=value pairs whose key reads like a token, a signature or a
    /// password, and long opaque strings (base64 in a path, say) replaced by "<redacted>".
    static func redact(_ text: String) -> String {
        var clean = shortenURLs(text)
        for (pattern, template) in secretPatterns {
            guard let pattern else { continue }
            clean = pattern.stringByReplacingMatches(in: clean, range: NSRange(location: 0, length: (clean as NSString).length), withTemplate: template)
        }
        return clean
    }

    private static func regex(_ pattern: String) -> NSRegularExpression? {
        try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
    }

    /// scheme, authority (user info, host, port), path, query, fragment.
    private static let urlPattern = regex(##"\b([a-z][a-z0-9+.-]*)://([^\s/?#"'<>]*)([^\s?#"'<>]*)(\?[^\s#"'<>]*)?(#[^\s"'<>]*)?"##)

    /// In this order, each with its replacement.
    private static let secretPatterns: [(NSRegularExpression?, String)] = [
        // Cookie: …, "Cookie":"…", Authorization: …, X-…-Token: … (up to the line's end or the closing quote).
        (regex(##"\b(cookie|set-cookie|authorization|proxy-authorization|x-[a-z0-9-]*(?:token|auth|key|signature|session)[a-z0-9-]*)\b("?\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|[^\r\n]*)"##), "$1$2<redacted>"),
        (regex(##"\bbearer\s+[a-z0-9._~+/=-]+"##), "Bearer <redacted>"),
        (regex(##"\beyJ[a-z0-9_-]{6,}\.[a-z0-9_-]{6,}(?:\.[a-z0-9_-]*)?"##), "<redacted>"),
        // token=…, access_token: …, sign=…, password=…
        (regex(##"\b([a-z0-9_.-]*(?:token|secret|password|passwd|signature|sign|sig|auth|apikey|api_key|key|jwt|credential|session_?id|sessid|cookie)[a-z0-9_.-]*)(\s*[=:]\s*)("?)[^\s&;,"'}]+"##), "$1$2$3<redacted>"),
        (regex(##"[a-z0-9_+=-]{40,}"##), "<redacted>"),
    ]

    /// URLs keep their scheme and host only ("https://cdn.example.com/…"), without user info. The
    /// core's own server (127.0.0.1, localhost) keeps its path too, never the query or fragment.
    private static func shortenURLs(_ text: String) -> String {
        guard let pattern = urlPattern else { return text }
        let source = text as NSString
        var result = ""
        var last = 0
        for match in pattern.matches(in: text, range: NSRange(location: 0, length: source.length)) {
            result += source.substring(with: NSRange(location: last, length: match.range.location - last))
            let scheme = source.substring(with: match.range(at: 1))
            var authority = source.substring(with: match.range(at: 2))
            if let at = authority.lastIndex(of: "@") {
                authority = String(authority[authority.index(after: at)...])
            }
            let pathRange = match.range(at: 3)
            let path = pathRange.location == NSNotFound ? "" : source.substring(with: pathRange)
            result += isLocal(authority) ? "\(scheme)://\(authority)\(path)" : "\(scheme)://\(authority)/…"
            last = match.range.location + match.range.length
        }
        result += source.substring(from: last)
        return result
    }

    private static func isLocal(_ authority: String) -> Bool {
        let host: String
        if authority.hasPrefix("[") {
            host = String(authority.prefix { $0 != "]" }) + "]"
        } else {
            host = String(authority.split(separator: ":", maxSplits: 1).first ?? "")
        }
        return ["127.0.0.1", "localhost", "[::1]"].contains(host.lowercased())
    }
}
