// The Swift models read the contract's JSON (ios/GUIDE.md, ios/core/src/api.rs), and answers turn
// into values or errors. No core needed.

import XCTest
@testable import Kinoteatri

final class ModelsTests: XCTestCase {
    private func value<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try KinoCore.decode(type, from: Data(json.utf8))
    }

    func testVersion() throws {
        let version = try value(CoreVersion.self, #"{"ok":true,"value":{"core":"0.1.0","engine":"0.1.26","mode":"engine"}}"#)
        XCTAssertEqual(version, CoreVersion(core: "0.1.0", engine: "0.1.26", mode: "engine"))
    }

    func testSearchResults() throws {
        let titles = try value([Title].self, #"""
        {"ok":true,"value":[
          {"id":"8906247916759695608","title":"Inception","year":"2010","kind":"movie","poster":"https://example.com/p.jpg","rating":"8.8"},
          {"id":"stub-series","title":"Bip Bop (test series)","year":null,"kind":"series","poster":null,"rating":null},
          {"id":"x","title":"No optional fields","kind":"movie"}
        ]}
        """#)
        XCTAssertEqual(titles.count, 3)
        XCTAssertEqual(titles[0], Title(id: "8906247916759695608", title: "Inception", year: "2010", kind: "movie", poster: "https://example.com/p.jpg", rating: "8.8"))
        XCTAssertTrue(titles[1].isSeries)
        XCTAssertNil(titles[1].year)
        XCTAssertNil(titles[2].poster)
    }

    func testDetailsOfASeries() throws {
        let details = try value(Details.self, #"""
        {"ok":true,"value":{
          "id":"123","title":"Dark","year":"2017","kind":"series","description":"A missing child…","poster":null,
          "rating":"8.7","duration":"60m","genres":["Drama","Mystery"],
          "seasons":[{"season":1,"episodes":[{"episode":1,"title":"Secrets"},{"episode":2,"title":null}]},
                     {"season":2,"episodes":[{"episode":1}]}],
          "audio":[{"id":"124","label":"German"},{"id":"125","label":"English"}]
        }}
        """#)
        XCTAssertTrue(details.isSeries)
        XCTAssertEqual(details.genres, ["Drama", "Mystery"])
        XCTAssertEqual(details.seasons.map(\.season), [1, 2])
        XCTAssertEqual(details.seasons[0].episodes, [EpisodeInfo(episode: 1, title: "Secrets"), EpisodeInfo(episode: 2, title: nil)])
        XCTAssertEqual(details.audio, [AudioTrack(id: "124", label: "German"), AudioTrack(id: "125", label: "English")])
    }

    func testDetailsOfAMovie() throws {
        let details = try value(Details.self, #"""
        {"ok":true,"value":{"id":"stub-movie","title":"Bip Bop (test movie)","year":"2010","kind":"movie",
          "description":null,"poster":null,"rating":"7.5","duration":"30m","genres":[],"seasons":[],"audio":[]}}
        """#)
        XCTAssertFalse(details.isSeries)
        XCTAssertTrue(details.seasons.isEmpty)
        XCTAssertNil(details.description)
    }

    func testStreams() throws {
        let streams = try value([Kinoteatri.Stream].self, #"""
        {"ok":true,"value":[
          {"index":0,"quality":"1080p","size_bytes":2147483648,"codec":"HEVC","audio":"English","label":"1080p · HEVC · 2.0 GB"},
          {"index":1,"quality":null,"size_bytes":null,"codec":null,"audio":null,"label":"Apple test stream"}
        ]}
        """#)
        XCTAssertEqual(streams.map(\.index), [0, 1])
        XCTAssertEqual(streams[0].sizeBytes, 2_147_483_648)
        XCTAssertEqual(streams[0].codec, "HEVC")
        XCTAssertNil(streams[1].sizeBytes)
    }

    func testPlay() throws {
        let play = try value(Play.self, #"""
        {"ok":true,"value":{"session":"a1b2","url":"http://127.0.0.1:50123/s/a1b2/master.m3u8","kind":"hls",
          "subtitles":"http://127.0.0.1:50123/s/a1b2/subs.vtt","title":"The Lord of the Rings"}}
        """#)
        XCTAssertEqual(play.id, "a1b2")
        XCTAssertEqual(play.kind, "hls")
        XCTAssertEqual(URL(string: play.url)?.port, 50123)
        XCTAssertNotNil(play.subtitles)
    }

    /// The TUI's default dub: Original, else English, else the first (kino-smoke's preferred_audio).
    func testPreferredAudio() {
        func preferred(_ labels: String...) -> String? {
            let tracks = labels.enumerated().map { AudioTrack(id: "\($0.offset)", label: $0.element) }
            return Details.preferredAudio(in: tracks)?.label
        }
        XCTAssertEqual(preferred("Hindi", "English", "Original Audio"), "Original Audio")
        XCTAssertEqual(preferred("Hindi", "ENGLISH"), "ENGLISH")
        XCTAssertEqual(preferred("Hindi", "Orig. (Japanese)", "English"), "Orig. (Japanese)")
        XCTAssertEqual(preferred("French", "Eng"), "Eng")
        XCTAssertEqual(preferred("Hindi", "Tamil"), "Hindi")
        XCTAssertNil(preferred())
    }

    func testStopAnswersNull() throws {
        XCTAssertNoThrow(try KinoCore.decodeAnswer(String.self, from: Data(#"{"ok":true,"value":null}"#.utf8)))
        XCTAssertNil(try KinoCore.decodeAnswer(String.self, from: Data(#"{"ok":true,"value":null}"#.utf8)))
    }

    func testErrorAnswer() {
        XCTAssertThrowsError(try value([Title].self, #"{"ok":false,"error":"No title stub-x."}"#)) { error in
            XCTAssertEqual(error as? KinoError, .core("No title stub-x."))
            XCTAssertEqual(error.localizedDescription, "No title stub-x.")
        }
    }

    func testContractDriftIsReported() {
        // A Details without its lists breaks the contract.
        XCTAssertThrowsError(try value(Details.self, #"{"ok":true,"value":{"id":"1","title":"T","kind":"movie"}}"#)) { error in
            guard case .badAnswer = error as? KinoError else {
                return XCTFail("Expected a bad-answer error, got \(error)")
            }
        }
    }
}
