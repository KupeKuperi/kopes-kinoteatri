# Kope's Kinoteatri for iPhone — build guide

The iPhone app runs the engine itself (no computer needed). This file is the plan, the contract
between the parts, and the rules for everyone working on it (people and agents). Read it fully
before touching anything under `ios/`.

## Step 1 goal (current)

A test app that, **on its own on an iPhone**, searches MovieBox, opens a title, lists its
streams and plays one in the iPhone's own player. Proven in the iOS Simulator on GitHub's Macs
(automated test: search → streams → play → video advancing), installable on a real iPhone with
**AltStore** (free Apple ID; the app is built unsigned and AltStore signs it).

Out of scope for step 1: other sources (4KHDHub, Dramachi, add-ons), Live TV, downloads,
history sync, the Georgian UI (step 2 reuses the desktop screens), subtitle choice UI.

## Architecture

```
SwiftUI app (ios/app)                       kino-core (ios/core, Rust staticlib)
  KinoCore.swift ── C ABI: kino_call(JSON) ──▶ lib.rs: dispatch on a tokio runtime
                                               ├─ engine.rs ──▶ moviebox-tui library (ios/engine, v0.1.26)
                                               │                 search / details / streams / resolve
                                               └─ server.rs ──▶ local HTTP server on 127.0.0.1:<port>
  AVPlayer ◀── http://127.0.0.1:<port>/s/<session>/master.m3u8 ──┘   relays the stream with the
                                                                      source's headers; DASH → HLS
```

- **ios/engine** — moviebox-tui v0.1.26 source (MIT OR Apache-2.0), used as a library. Keep it
  as close to upstream as possible; every change is listed in `ios/engine/KINO-CHANGES.md`
  (file, why, how) so newer upstream versions can be merged later.
- **ios/core** — our crate `kino-core`: the C ABI, the engine calls, the local stream server and
  the DASH→HLS conversion (a Rust port of the desktop app's `src/main/phone/{dash,mp4,subs}.ts`).
  Feature `engine` (default) uses the real engine; `--no-default-features` builds a **stub** that
  returns canned titles and plays Apple's public HLS test stream (so the app and CI can be built
  and tested before/without the engine).
- **ios/app** — the SwiftUI app, generated with XcodeGen (`project.yml`), linking the core as a
  static library, plus XCTest tests that run in the Simulator.

Why a local server: MovieBox streams are DASH (an iPhone plays HLS, not DASH) and the CDN wants
headers (Referer, User-Agent, a Cookie) that AVPlayer can't send. The server turns the DASH
manifest into HLS playlists (segments untouched, HEVC init segments relabelled `hev1`→`hvc1`),
and fetches everything with the source's headers. Same design as desktop phone access, which is
proven (a real MovieBox film played at 1080p HEVC through it).

## The contract (C ABI + JSON)

Header: `ios/core/include/kino.h`.

```c
char *kino_start(const char *data_dir);  // once; NULL = ok, else an error message
char *kino_call(const char *request);     // JSON request → JSON response; blocking, call off the main thread
void  kino_free(char *s);                 // frees any string the core returned
```

Every response is `{"ok":true,"value":…}` or `{"ok":false,"error":"…"}`.

| Request | `value` |
| --- | --- |
| `{"op":"version"}` | `{"core":"0.1.0","engine":"0.1.26","mode":"engine"\|"stub"}` |
| `{"op":"search","query":"Inception"}` | `[Title]` |
| `{"op":"details","id":"…"}` | `Details` |
| `{"op":"streams","id":"…","season":0,"episode":0}` | `[Stream]` (season/episode 0 for movies) |
| `{"op":"play","id":"…","season":0,"episode":0,"stream":0,"subtitles":"English"}` | `Play` (`subtitles` optional: a language name, or omitted for none) |
| `{"op":"stop","session":"…"}` | `null` |

```
Title   { id, title, year?, kind: "movie"|"series", poster?, rating? }
Details { id, title, year?, kind, description?, poster?, rating?, duration?, genres: [String],
          seasons: [{ season, episodes: [{ episode, title? }] }],   // [] for movies
          audio: [{ id, label }] }                                   // other dubs (each its own id)
Stream  { index, quality?, size_bytes?, codec?, audio?, label }
Play    { session, url, kind: "hls"|"file", subtitles?, title }      // url/subtitles on 127.0.0.1
```

Rust types for all of this live in `ios/core/src/api.rs` (serde). Don't change field names
without updating `api.rs`, the Swift `Models.swift` and this table together.

Internal Rust interfaces (also in `api.rs` / module docs):

- `engine.rs` (feature `engine`): `search`, `details`, `streams`, `resolve(id, season, episode,
  stream, subtitles) -> Source` where `Source { url, headers, subtitle_url, subtitle_lang, title,
  max_height }` is what the engine would hand a video player (its `PlaybackSource`; `max_height`
  is the picked quality: all MovieBox qualities share one manifest).
- `server.rs`: `Server::start() -> Server` (binds 127.0.0.1:0), `server.open(Source) -> Play`,
  `server.close(session)`. MovieBox's CDN throttles each connection (~130 KiB/s), so segments and
  files are fetched as 95 KiB ranges, 16 at a time; the Cookie goes only to the source's host;
  upstream 403 reaches AVPlayer as 403; a listener iOS reclaimed is re-bound (same port first).
- `hls/`: `parse_mpd`, `master_playlist`, `media_playlist`, `subtitle_playlist`, `codec_string`,
  `hvc1`, `to_webvtt` — same behaviour as the TypeScript originals.

## Who owns what (work in your own files only)

| Part | Files | Owner |
| --- | --- | --- |
| Guide, C ABI, dispatch, stub, `api.rs`, integration | `ios/GUIDE.md`, `ios/core/src/lib.rs`, `ios/core/src/api.rs`, `ios/core/include/kino.h`, `ios/Cargo.toml`, `ios/core/Cargo.toml` | lead (main session) |
| DASH→HLS + local server | `ios/core/src/hls/**`, `ios/core/src/server.rs`, `ios/core/tests/**` | agent **hls** |
| Engine bridge + smoke CLI | `ios/core/src/engine.rs`, `ios/core/src/bin/**`, `ios/engine/**` (minimal changes, logged in `KINO-CHANGES.md`) | agent **engine** |
| iOS app + CI | `ios/app/**`, `.github/workflows/ios.yml` | agent **app** |

Need a dependency or a contract change? Say so in your report; the lead adds it. Don't commit
or push from the shared working tree (the lead commits). The app agent works in its own git
worktree/branch and may commit and push there (CI runs on push).

## Building and testing

Local (this Windows PC has no Rust; WSL Ubuntu has Rust + zig as the C compiler/linker):

```bash
wsl -e bash -lc 'cd /mnt/c/Users/nikam/Desktop/Claude/moviebox-gui/ios && CARGO_TARGET_DIR=$HOME/kino-target-<you> ~/.cargo/bin/cargo test -p kino-core'
```

- Use your own `CARGO_TARGET_DIR` (`$HOME/kino-target-hls`, `-engine`, `-lead`) so parallel builds
  don't block each other; the first build compiles the engine (about a minute).
- The engine writes config/caches/history under `$MOVIEBOX_CONFIG_DIR`, `$MOVIEBOX_DATA_DIR`,
  `$MOVIEBOX_CACHE_DIR`: point them at a scratch folder in WSL (e.g. `$HOME/kino-data`). Never at
  the user's Windows folders.
- Network calls to MovieBox work from this PC (Georgia); results differ by region.
- Rust is 2024 edition; `cargo fmt` style; no `unwrap()` on anything that comes from the network.

CI (`.github/workflows/ios.yml`, public repo so GitHub's Macs are free):
- **core** (Linux): `cargo test`, then the smoke CLI against live MovieBox.
- **ios** (macOS): build the core for `aarch64-apple-ios-sim` and `aarch64-apple-ios`, generate
  the project with XcodeGen, run the XCTest suite in the Simulator, build an unsigned `.ipa`.
- The `.ipa` is only uploaded inside a password-protected zip (repo secret `IPA_PASSWORD`), with
  short retention: the repo is public, the app file shouldn't be.

## Definition of done (step 1)

1. `cargo test -p kino-core` passes (HLS conversion checked against the real LOTR manifest and
   init segments in `ios/core/tests/fixtures`).
2. `kino-smoke "The Lord of the Rings"` (WSL and CI Linux): search → details → streams → play →
   the local master playlist, a media playlist, an init segment (`hvc1`) and a first segment all
   load.
3. CI **ios** job: the Simulator test searches, opens, plays through the local server, and the
   video's current time advances for at least 5 seconds. Screenshots kept as artifacts.
4. An unsigned `.ipa` that AltStore can install; the user confirms it plays on the iPhone.

## Status

- [x] Toolchain: Rust 1.99 + zig 0.17 in WSL (user space); the engine library builds (56 s).
- [x] Engine v0.1.26 source in `ios/engine`; one change so far (iOS DNS), see `KINO-CHANGES.md`.
- [x] Skeleton: workspace, C ABI, stub (lead) — 698b2da
- [x] HLS + server (agent hls): byte-identical to the TS on fixtures; ranged fetch; quality cap;
      subtitle language; Cookie scope; listener revival. `kino-smoke` full play passes live
      (LOTR, Inception with English subtitles).
- [x] Engine bridge + smoke (agent engine): search/details/streams/resolve verified live (LOTR,
      Lanterns S1E1); `kino-smoke --resolve-only` passes
- [x] App + CI (agent app): SwiftUI app (search, title with dubs (TUI default Original > English >
      first), streams, AVPlayer with "Try again" after a failure); CI builds the real engine for
      both iOS targets (no engine source changes needed) and plays live MovieBox in the Simulator
- [x] Integration: real engine in the app, CI green end to end (lead) — merged to main 2ec0230
- [x] AltStore install guide for the user; user test on the iPhone (2026-10-07: installs and
      plays; reported: full screen didn't work)
- [x] Player fix (branch `ios-player-fix`, merged to main at 0a57857; known left: the search
      keyboard can come up over the player when its menu opens, fix in progress on the branch):
      Apple's AVPlayerViewController presented full screen
      from the top view controller (`PlayerScreen.swift`: own close button, swipe down, rotation,
      PiP; the core's `stop` runs once it's neither shown, presented nor in PiP); "English
      subtitles" switch on the title screen (on by default, @AppStorage), English legible option
      selected automatically; "Copy diagnostics" (`Diagnostics.swift`, 200 redacted lines: no
      cookies, headers, tokens or stream URLs) in the Try-again card and the About sheet.
      Test-only environment: `KINO_UI_TEST=1` (the player describes itself to the UI tests),
      `KINO_UITEST_START_AT` (start a film n seconds in). CI also has a ~1 min Swift typecheck job
      and an Inception subtitle smoke step; XCTest's automatic failure recordings are off (they
      would put film footage in the public test results).

## Later (step 2 candidates, not started)

Seen while building step 1; none blocks playback.

- **Subtitles beyond English:** the app asks only for English; a picker would need an op listing
  the languages MovieBox has for a release.
- **Georgian UI** like the desktop app (ქარ/ENG).
- **HLS BANDWIDTH:** AVPlayer logs `-12318 Segment exceeds specified bandwidth` because DASH
  `@bandwidth` (an average) goes into BANDWIDTH (meant as the peak). Playback doesn't stall; a
  fix would put it in AVERAGE-BANDWIDTH and declare a higher peak (desktop dash.ts has the same).
- **Long films:** the CDN cookie lasted ≥ 81 min in a probe (2026-10-07); past its life the app
  shows "Try again" (fresh cookie, resumes). A server-side re-resolve on 403 would make it
  seamless.
- **Caches:** the engine's cache dir is under Application Support (backed up to iCloud); move it
  to Library/Caches (needs a second dir in `kino_start` or a subfolder convention).
- **CI time:** the iOS job is ~14 min, 7 of them the core (`lto = true`, `codegen-units = 1`,
  engine never cached as a path dependency); a CI-only thin-LTO/codegen-units override would cut
  it.
- **Real-device checks** CI can't do: background the app mid-play and play again (listener
  re-bind, TN2277), Picture in Picture (the CI Simulator reports it unsupported), AltStore's
  weekly refresh.
- **CI time** grew to 11–15 min for the core build on the player-fix runs (core unchanged);
  see the CI time item above.
