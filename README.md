# Kope's Kinoteatri

A desktop app for watching movies, series, anime and Asian dramas. Kope's Kinoteatri gives you:

- search with posters, IMDb ratings and the IMDb top lists;
- audio track, season, episode and quality choice;
- automatic subtitles;
- play in VLC or mpv, or download;
- continue watching, history, favorites and Live TV.

It is a window onto [**moviebox-tui**](https://github.com/mesamirh/MovieBox-Tui), a free open-source terminal app. Every search, stream lookup, playback and download is done by moviebox-tui. The app runs it in a hidden terminal, types the keys you would, and reads the answers from its screen and cache files.

![Trending now](docs/browse.png)
![A title with its streams](docs/details.png)

## Install (Windows 10 and 11)

1. Download **KopesKinoteatri-Setup.exe** from the [latest release](https://github.com/KupeKuperi/kopes-kinoteatri/releases/latest). The repository is private: sign in to GitHub with an account that has access.
2. Run it. It installs for your user only (no admin prompt) and adds Desktop and Start-menu shortcuts. The installer isn't code-signed, so Windows SmartScreen may say *"Windows protected your PC"*: click **More info → Run anyway**.
3. On first start the app checks for what it needs:
   - **moviebox-tui (required).** If it isn't installed, click **Install moviebox-tui**. The app downloads its official GitHub release (about 5 MB), checks it against the release's SHA-256 checksums, and puts it where moviebox-tui's own installer would: `%LOCALAPPDATA%\Programs\MovieBox-Tui\bin`.
   - **A video player (required to play).** Without VLC or mpv, Home shows **Install VLC**, which uses winget. Windows asks for permission because VLC installs for all users.
   - **yt-dlp (only for MovieBox downloads).** The Downloads page offers **Install yt-dlp** (winget, together with ffmpeg).

To update, install a newer Setup.exe over the old one. To remove the app, use Windows Settings → Apps. Your history, favorites and settings belong to moviebox-tui and stay.

## What it does

| Screen | |
| --- | --- |
| **Home** | Resume what you watched last, continue watching, the **IMDb top lists** (Top Rated Movies/Series, Best New Movies/Series: IMDb's own ratings with a minimum number of votes), the source's own lists (MovieBox: Trending Now, Most Watched), favorites |
| **Search** | Typo-tolerant suggestions while you type ("intersteller" → Interstellar), live results, poster grid with IMDb ratings, movie/series filter. Long titles, colons and the like are typed into moviebox-tui exactly. When nothing matches, it retries a looser query and offers similar titles |
| **Details** | Synopsis, IMDb rating and votes, cast, audio tracks (dubs), seasons and episodes, every stream with quality (4K/1080p…), size and format (REMUX, Dolby Vision, HDR, HEVC…), play, download a stream or a whole season, favorite. Titles a source lacks offer *Look on &lt;other source&gt;* |
| **Library** | History (resume, open, remove) and favorites |
| **Downloads** | Live progress with the file name. **Stop** pauses: download the same title again to continue. Finished and unfinished files show with their subtitles; leftovers of an unfinished download can be deleted |
| **Live TV** | Add M3U playlists (URL or file), browse channels by group, play, remove playlists |
| **Settings** | Player, subtitles, download folder, sources, modes, engine location; install VLC |

**Sources.** Switch in the top-right corner: MovieBox (movies, series, anime; subtitles; downloads need yt-dlp), 4KHDHub (4K/HDR/REMUX releases; slow to load streams), Dramachi (Asian dramas). IMDb lists stay put when you switch, and an open search runs again on the new source.

**Subtitles.** MovieBox titles come with subtitles. Settings → Playback → *Subtitles* picks the language loaded into the player, or saved next to a download, without asking (English by default). If a title doesn't have that language, or the setting is *Ask every time*, a dialog lets you choose.

![Choosing subtitles](docs/subtitles.png)

### Keyboard

| Keys | Action |
| --- | --- |
| `Ctrl K` or `/` | Search |
| Arrow keys | Move between posters, episodes, buttons (like a TV remote) |
| `Enter` / `Esc` | Open / back |
| `Alt 1`–`Alt 5` | Home, Library, Downloads, Live TV, Settings |
| `P` / `D` / `F` (on a title) | Play / download the first stream, favorite |
| `Ctrl \`` | Engine console: the live moviebox-tui the window drives |
| `?` | Shortcut list |

## Build from source

Requires Node.js 20+ (CI uses 22).

```bash
npm ci
npm run dev          # development, with hot reload
npm run typecheck    # type-check main process and UI
npm run dist         # installer: dist/KopesKinoteatri-Setup-<version>.exe
```

`npm run package` builds only the unpacked app (`dist/KopesKinoteatri-win32-x64/KopesKinoteatri.exe`); `npm run dist` packages it and wraps it in the installer (electron-builder, NSIS). `npm run icon` redraws the icon (`scripts/make-icon.py`, needs Pillow).

### Releasing a new version

1. Raise `version` in `package.json` and commit.
2. Tag and push: `git tag v1.0.1 && git push origin main v1.0.1`.

GitHub Actions (`.github/workflows/release.yml`) builds the installer on Windows. It attaches the installer to a release for that tag twice: as `KopesKinoteatri-Setup-<version>.exe` and as `KopesKinoteatri-Setup.exe`. The second name keeps one link working for every version: `https://github.com/KupeKuperi/kopes-kinoteatri/releases/latest/download/KopesKinoteatri-Setup.exe`.

## How it works

```
React UI ──IPC──▶ Driver ──keystrokes──▶ moviebox-tui (hidden ConPTY)
   ▲                 │                         │
   │                 ├── reads screen ◀── headless xterm buffer
   │                 └── reads caches ◀── %LOCALAPPDATA%\moviebox-tui\{moviebox,fourkhdhub,dramachi}\…
   └──────── events: status, toasts, downloads, subtitle questions, library changes
```

- **Engine session** (`src/main/engine/session.ts`): one moviebox-tui process in a pseudo-terminal (110×80, so lists render as one column), mirrored into `@xterm/headless`. Control keys go in as exact Windows key events, so non-Latin keyboard layouts (Georgian, Russian…) don't interfere.
- **Driver** (`src/main/engine/driver.ts`): turns each action into keystrokes, waits for what the screen shows (no fixed sleeps), verifies every step, and answers moviebox-tui's subtitle chooser. Operations run one at a time.
- **Screen parsers** (`src/main/engine/screen.ts`): result cards, details panes, the subtitle chooser, toasts, the download panel.
- **Caches** (`src/main/data/mbc.ts`, `cacheIndex.ts`): moviebox-tui stores responses as `MBC1` + MessagePack; posters, synopses, episodes and stream details come from there. Stream URLs never reach the UI.
- **IMDb** (`src/main/data/imdb.ts`): ratings from IMDb's official [non-commercial dataset](https://developer.imdb.com/non-commercial-datasets/) (refreshed weekly), titles and posters from Cinemeta. Metadata only: playing still goes through the active source.
- **Setup** (`src/main/tools.ts`): the moviebox-tui installer and the winget installs.

```
src/
├─ main/            Electron main process: window, IPC, engine (session, keys, screen, driver, manager), data, tools
├─ preload/         window.mb bridge
├─ shared/          types shared by main and UI
└─ renderer/src/    React UI: App, screens/, components/, lib/
scripts/            packaging and icon
probe/              development tools
```

## Good to know

- **It follows moviebox-tui's screens.** The parsers match v0.1.26. moviebox-tui updates itself by default (Settings → *Update moviebox-tui automatically*). If a future version changes its screens, the affected step fails with a clear message and the engine console still works. Turn auto-update off to stay on a known-good version.
- **Shared with the terminal app.** Settings, history, favorites and TV playlists are moviebox-tui's own files, so the terminal app and this window always agree. Saving engine settings restarts the hidden engine; the subtitle choice applies at once.
- **Left as you had it.** The window restores moviebox-tui's Streaming/Live TV mode when it closes.

## Development tools (`probe/`)

| Command | What it does |
| --- | --- |
| `npm run probe -- probe/scenarios/<name>.json` | Replays keystrokes into moviebox-tui and dumps each screen to `probe/out/`. Prefix `W32=1` for exact Windows key events. |
| `npm run probe:driver` | Runs the driver headlessly against the real moviebox-tui. |
| `node probe/cdp.mjs <steps.json>` | Drives a running app over DevTools (`npx electron . --remote-debugging-port=9333`): clicks, keys, checks, screenshots. |
| `node probe/decode.mjs <file.cache>` | Prints a moviebox-tui cache file. |
| `KINOTEATRI_SIMULATE_NO_ENGINE=1` | Starts the app as if moviebox-tui were missing, to preview the first-run screen. |

The probes use the real moviebox-tui and its real config. A scenario that enters Live TV or changes the source leaves it that way.

## Credits

[moviebox-tui](https://github.com/mesamirh/MovieBox-Tui) by mesamirh (Apache-2.0 / MIT) does the real work. Ratings: IMDb non-commercial datasets (personal use). Metadata and posters: Cinemeta / metahub. Built with Electron, React, Tailwind CSS, xterm.js and node-pty. Fonts: Big Shoulders Display, Hanken Grotesk, Martian Mono (SIL Open Font License).
