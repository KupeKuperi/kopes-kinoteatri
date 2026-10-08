**New in 1.3:**

- **Find elsewhere.** A title's page links to searches for it on torrent, streaming and subtitle sites (the [IMDb Scout Mod](https://github.com/Purfview/IMDb-Scout-Mod) site list). When a source has no streams, the page offers the app's other sources and those searches.
- **Subtitles from elsewhere.** When a title lacks subtitles in your language, its page lists subtitle sites. With a free OpenSubtitles API key (Settings → Find elsewhere), VLC or mpv gets them from OpenSubtitles automatically.

**Windows 10/11:** download **KopesKinoteatri-Setup.exe** and run it. It installs for your user, without admin rights. If Windows says *"Windows protected your PC"*, click **More info → Run anyway**: the installer isn't code-signed.

**Mac:** download **KopesKinoteatri-mac-apple-silicon.dmg** for M1 and newer, or **KopesKinoteatri-mac-intel.dmg** for Intel Macs. Open it and drag Kope's Kinoteatri into Applications. The first time you start it, macOS blocks it, because the app isn't signed with an Apple Developer ID. Open **System Settings → Privacy & Security**, scroll down and click **Open Anyway**.

On first start the app offers to install what's missing:

- **moviebox-tui**, the engine: from its official GitHub release, checked against its SHA-256 checksums.
- **VLC**, to play: winget on Windows, Homebrew on a Mac.
- **yt-dlp**, only needed for MovieBox downloads.
