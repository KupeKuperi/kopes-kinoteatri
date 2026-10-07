// The diagnostics log ("Copy diagnostics") never keeps cookies, tokens, signatures or stream
// addresses, keeps what helps (the local session URLs without their query, hosts, error codes),
// and holds only the last lines. No core needed.

import XCTest
@testable import Kinoteatri

final class DiagnosticsTests: XCTestCase {
    func testCookiesTokensAndStreamAddressesAreCut() {
        // Each line, and what must not be left of it.
        let lines: [(String, [String])] = [
            ("Cookie: t=1728300000; bcdn_token=SECRET1", ["SECRET1", "1728300000"]),
            ("set-cookie=SECRET2; Path=/", ["SECRET2"]),
            (#"{"Cookie":"t=1; tok=SECRET3","Referer":"https://h5.aoneroom.com/"}"#, ["SECRET3", "tok="]),
            ("Authorization: Bearer SECRET4", ["SECRET4"]),
            ("headers: authorization=Basic SECRET5", ["SECRET5"]),
            ("GET https://bcdnw.hakunaymatata.com/abc/video.mpd?sign=SECRET6&t=1728300000 answered 403", ["SECRET6", "sign=", "video.mpd", "1728300000"]),
            ("error: token=SECRET7, access_token: SECRET8", ["SECRET7", "SECRET8"]),
            ("x-amz-security-token: SECRET9", ["SECRET9"]),
            ("bearer abc.SECRET10", ["SECRET10"]),
            ("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpM", ["eyJ", "SflKxwRJ"]),
            ("https://user:SECRET11@example.com/films/1.mp4", ["SECRET11", "films"]),
            ("http://127.0.0.1:55552/s/abcd/master.m3u8?token=SECRET12", ["SECRET12", "token"]),
            ("http://127.0.0.1:55552/s/abcd/h/aHR0cHM6Ly9jZG4uZXhhbXBsZS5jb20vdmlkZW8ubTN1OD9zaWduPWFiYw.m3u8", ["aHR0cHM6"]),
            ("password=SECRET13&next=1", ["SECRET13"]),
        ]
        for (line, leaks) in lines {
            let clean = Diagnostics.redact(line)
            for leak in leaks {
                XCTAssertFalse(clean.contains(leak), "\"\(line)\" kept \"\(leak)\": \(clean)")
            }
        }
    }

    func testWhatHelpsIsKept() {
        XCTAssertEqual(
            Diagnostics.redact("http://127.0.0.1:55552/s/UPvTHbOpvftSI09F/master.m3u8?token=x"),
            "http://127.0.0.1:55552/s/UPvTHbOpvftSI09F/master.m3u8"
        )
        XCTAssertEqual(
            Diagnostics.redact("GET https://bcdnw.hakunaymatata.com/a/b.mpd?x=1 answered 403"),
            "GET https://bcdnw.hakunaymatata.com/… answered 403"
        )
        let plain = [
            "play session UPvTHbOpvftSI09F (hls, subtitles found)",
            "core 0.1.0 · engine 0.1.26 · engine",
            "error log: CoreMediaErrorDomain -12318 Segment exceeds specified bandwidth for variant /s/x/seg/3/1.m4s",
            "access log: indicated 617 kb/s, observed 2100 kb/s, stalls 0, dropped frames 0",
            "→ play id 5238552786089955104 season 0 episode 0 stream 0 subtitles English",
        ]
        for line in plain {
            XCTAssertEqual(Diagnostics.redact(line), line)
        }
    }

    func testOnlyTheLastLinesAreKept() {
        let log = Diagnostics(capacity: 200)
        for i in 1...250 {
            log.log("event \(i)")
        }
        let lines = log.lines
        XCTAssertEqual(lines.count, 200)
        XCTAssertTrue(lines.first?.hasSuffix(" event 51") == true, lines.first ?? "")
        XCTAssertTrue(lines.last?.hasSuffix(" event 250") == true, lines.last ?? "")
        XCTAssertTrue(log.text.hasPrefix("Kinoteatri "))
        XCTAssertEqual(log.text.components(separatedBy: "\n").count, 201)
    }

    func testLinesAreRedactedAndCut() {
        let log = Diagnostics(capacity: 5)
        log.log("Cookie: t=SECRET")
        log.log(String(repeating: "word ", count: 200))
        XCTAssertFalse(log.lines[0].contains("SECRET"))
        XCTAssertLessThanOrEqual(log.lines[1].count, Diagnostics.maxLineLength + 20)
    }
}
