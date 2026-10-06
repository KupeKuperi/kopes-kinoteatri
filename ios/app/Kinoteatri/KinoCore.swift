// The Rust core (kino-core) as Swift sees it: a thin wrapper over ios/core/include/kino.h.
// One JSON request in, one JSON answer out: {"ok":true,"value":…} or {"ok":false,"error":"…"}.

import Foundation
import KinoFFI

enum KinoError: LocalizedError, Equatable {
    /// The core answered {"ok":false,"error":…}.
    case core(String)
    /// kino_start failed.
    case start(String)
    /// The answer isn't what the contract (ios/GUIDE.md) says.
    case badAnswer(String)

    var errorDescription: String? {
        switch self {
        case .core(let message): return message
        case .start(let message): return "The engine didn't start: \(message)"
        case .badAnswer(let message): return "Unexpected answer from the engine: \(message)"
        }
    }
}

final class KinoCore: @unchecked Sendable {
    static let shared = KinoCore()

    /// kino_call blocks until the answer is ready (network), so calls run here, never on the main
    /// thread. Concurrent: the core handles requests in parallel.
    private let queue = DispatchQueue(label: "com.kope.kinoteatri.core", qos: .userInitiated, attributes: .concurrent)
    private let lock = NSLock()
    private var dataDir: URL?

    /// Where the app keeps the engine's settings, caches and history.
    static func defaultDataDir() throws -> URL {
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return support.appendingPathComponent("Kinoteatri", isDirectory: true)
    }

    /// The folder the core was started with (nil until then).
    var startedDataDir: URL? {
        lock.lock()
        defer { lock.unlock() }
        return dataDir
    }

    /// Starts the core with `dataDir` (once; later starts do nothing). Calls start the core with
    /// the default folder if nobody did.
    func start(dataDir: URL) async throws {
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
            queue.async {
                done.resume(with: Result { try self.startBlocking(dataDir) })
            }
        }
    }

    private func startBlocking(_ dir: URL?) throws {
        lock.lock()
        defer { lock.unlock() }
        if dataDir != nil { return }
        let folder = try dir ?? Self.defaultDataDir()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        if let error = folder.path.withCString({ kino_start($0) }) {
            let message = String(cString: error)
            kino_free(error)
            throw KinoError.start(message)
        }
        dataDir = folder
    }

    /// One request (see ios/GUIDE.md), e.g. `["op": "search", "query": "Inception"]`; returns the
    /// answer's `value`, or throws the core's error.
    func call<T: Decodable>(_ request: [String: Any]) async throws -> T {
        let answer = try await send(request)
        return try Self.decode(T.self, from: answer)
    }

    /// A request whose answer has no value (`stop`).
    func run(_ request: [String: Any]) async throws {
        let answer = try await send(request)
        _ = try Self.decodeAnswer(Ignored.self, from: answer)
    }

    private func send(_ request: [String: Any]) async throws -> Data {
        guard JSONSerialization.isValidJSONObject(request) else {
            throw KinoError.badAnswer("Request isn't JSON: \(request)")
        }
        let text = String(decoding: try JSONSerialization.data(withJSONObject: request), as: UTF8.self)
        return try await withCheckedThrowingContinuation { (done: CheckedContinuation<Data, Error>) in
            queue.async {
                done.resume(with: Result {
                    try self.startBlocking(nil)
                    guard let answer = text.withCString({ kino_call($0) }) else {
                        throw KinoError.badAnswer("No answer.")
                    }
                    defer { kino_free(answer) }
                    return Data(String(cString: answer).utf8)
                })
            }
        }
    }

    // MARK: Answers

    private struct Answer<Value: Decodable>: Decodable {
        let ok: Bool
        let value: Value?
        let error: String?
    }

    private struct Ignored: Decodable {
        init(from decoder: Decoder) throws {}
    }

    /// The `value` of an answer (nil when it's null), or the core's error.
    static func decodeAnswer<T: Decodable>(_ type: T.Type, from data: Data) throws -> T? {
        let answer: Answer<T>
        do {
            answer = try JSONDecoder().decode(Answer<T>.self, from: data)
        } catch {
            throw KinoError.badAnswer("\(error) in \(String(decoding: data.prefix(500), as: UTF8.self))")
        }
        guard answer.ok else { throw KinoError.core(answer.error ?? "Unknown error.") }
        return answer.value
    }

    static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        guard let value = try decodeAnswer(type, from: data) else { throw KinoError.badAnswer("No value.") }
        return value
    }
}

// MARK: The requests (ios/GUIDE.md)

/// The arguments of `play`, kept so a failed play can be asked for again.
struct PlayRequest: Hashable {
    let id: String
    /// 0 for movies, like `episode`.
    let season: Int
    let episode: Int
    let stream: Int
    var subtitles: String?
}

extension KinoCore {
    func version() async throws -> CoreVersion {
        try await call(["op": "version"])
    }

    func search(_ query: String) async throws -> [Title] {
        try await call(["op": "search", "query": query])
    }

    func details(id: String) async throws -> Details {
        try await call(["op": "details", "id": id])
    }

    /// Season and episode are 0 for movies.
    func streams(id: String, season: Int = 0, episode: Int = 0) async throws -> [Stream] {
        try await call(["op": "streams", "id": id, "season": season, "episode": episode])
    }

    /// `subtitles`: a language name ("English"), or nil for none.
    func play(id: String, season: Int = 0, episode: Int = 0, stream: Int, subtitles: String? = nil) async throws -> Play {
        var request: [String: Any] = ["op": "play", "id": id, "season": season, "episode": episode, "stream": stream]
        if let subtitles { request["subtitles"] = subtitles }
        return try await call(request)
    }

    func play(_ request: PlayRequest) async throws -> Play {
        try await play(id: request.id, season: request.season, episode: request.episode, stream: request.stream, subtitles: request.subtitles)
    }

    func stop(session: String) async throws {
        try await run(["op": "stop", "session": session])
    }
}
