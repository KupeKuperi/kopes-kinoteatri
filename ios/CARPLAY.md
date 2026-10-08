# Kinoteatri in the car (CarPlay)

What the car's screen can do with Kinoteatri, what stays on the iPhone, and what it takes for the
app to show up in a real car. Code: `ios/app/Kinoteatri/CarPlay/` and
`ios/app/Kinoteatri/Playback/`.

## On the car's screen

CarPlay draws apps from Apple's templates (lists, tabs, Now Playing); an app can't draw its own
screens there. Kinoteatri uses the templates an **audio** app may use:

| Car screen | What it does |
| --- | --- |
| **Continue** tab | Continue watching from the phone's library. A tap plays on where it stopped (or the next episode once one was watched). |
| **Favorites** tab | The phone's favorites. A tap opens the title. |
| **Searches** tab | The phone's recent searches. A tap runs the search again and lists the results. |
| A title | **Resume** (when there's somewhere to go on from), then **Play** and every stream for a film; for a series its seasons and episodes. |
| **Now Playing** | Title, episode and poster; play/pause, 15 s back and forward, next episode. It comes up when a play starts. |

- **Data:** plays started in the car use the **lightest stream**. The sound is the same, and it costs a fraction of the mobile data.
- **Sync:** the lists follow the phone (a favorite added on the phone shows in the car), and the row of what's playing has CarPlay's playing indicator.
- **Shared controls:** the car and the phone drive **one playback** (`PlaybackCenter`). Pause in the car, and the phone's player is paused. Start something on the phone, and the car's Now Playing shows it.

## Phone only

- **The picture.** Video always plays on the iPhone. A play started in the car plays its sound through the car. The phone shows a mini player (over the tab bar), and a tap on it opens the full-screen player.
- **Typing a search.** Audio apps can't use CarPlay's search template before iOS 27, so the car offers the phone's recent searches instead.
- **Settings, the subtitle language, choosing a dub.** The car opens a title on the dub played last, or on the default one (Original, else English).

With CarPlay connected, closing the phone's player keeps the sound in the car (the mini player stays), and locking the phone doesn't stop it. Without CarPlay, closing the player stops the play as before.

## Why there's no video on the car's screen

- **Today's builds:** apps can't show video on CarPlay screens. Kinoteatri doesn't fake a video surface; on the car's screen it shows lists, Now Playing and controls.
- **iOS 26:** "AirPlay video in the car". The person AirPlays a video from any app to the car while parked. Carmakers have to build it into the car, and as far as we know no car offered it as of mid-2026.
  - Untested: AirPlay of Kinoteatri's streams. They come from the phone's own local server (`127.0.0.1`), so an AirPlay receiver may not be able to fetch them.
- **iOS 27:** Apple added a CarPlay **video** app category (`com.apple.developer.carplay-video`). It plays video in cars that support "video in car", and falls back to audio otherwise. It needs:
  - Apple's approval
  - the iOS 27 SDK (GitHub's Macs build with Xcode 26.6 for now)
  - AirPlay video support
  - `CPPlaybackConfiguration`

  Not done here. It's the route if Kinoteatri should ever show the picture in a car.

## What it takes to appear in a real car

CarPlay is a **managed capability**. The app needs the entitlement `com.apple.developer.carplay-audio` in its provisioning profile:

- **Who gets it:** Apple grants it to a **paid** developer account on request (the account holder asks).
- **Video apps may be refused:** Apple's guideline says audio apps must be designed primarily for audio playback.
- **AltStore / free Apple ID:** the free provisioning profile has no CarPlay. AltStore signs with that profile's entitlements, so the app **installs and works on the phone but doesn't appear in the car**.
- **Simulator:** Simulator builds carry the entitlement (`ios/app/Kinoteatri-CarPlay.entitlements`, set in `project.yml` for `iphonesimulator` only). In Xcode's Simulator, open **I/O → External Displays → CarPlay**: Kinoteatri is on the car's home screen.
  - CI prints the built app's entitlements and its scene manifest (step "CarPlay entitlement and scene in the Simulator app").
  - A unit test checks that the declared CarPlay scene class exists.
- **With an approved team:** set `CODE_SIGN_ENTITLEMENTS: Kinoteatri-CarPlay.entitlements` for device builds too (in `project.yml`), set the team, and sign with Xcode. The CarPlay Simulator Mac app (Additional Tools for Xcode) can then drive the phone like a car.

## How it's built

- **`Info.plist`** (from `project.yml`): `UIApplicationSceneManifest → UISceneConfigurations → CPTemplateApplicationSceneSessionRoleApplication` with `CPTemplateApplicationScene` and `CarPlaySceneDelegate`. The class has that Objective-C name (`@objc(CarPlaySceneDelegate)`). The phone's window stays SwiftUI's own. The `audio` background mode was already there.
- **`CarPlaySceneDelegate`:** connects and disconnects the car and tells `AppModel` (Settings shows "CarPlay: Connected").
- **`CarPlayController`:** the templates.
  - Tab bar: at most `CPTabBarTemplate.maximumTabCount` tabs.
  - Lists: capped at `CPListTemplate.maximumItemCount`, since some cars take 12.
  - Stack: at most 5 templates, the tab bar included. It pops to the tabs before going deeper.
  - Errors: shown as an alert with OK.
- **`CarPlayContent`:** what each row says, apart from CarPlay's classes, so it's unit-tested.
- **`NowPlaying.swift`:** the lock screen's, Control Center's and the car's Now Playing (`MPNowPlayingInfoCenter`) and their buttons (`MPRemoteCommandCenter`). `PlaybackCenter` publishes them, not Apple's player (`updatesNowPlayingInfoCenter = false`), so they're the same with or without the phone's player on screen.
- **Background playback:** `PlaybackCenter` sets `audiovisualBackgroundPlaybackPolicy = .continuesIfPossible` while the car is connected or no picture is on the phone, so the sound goes on with the phone locked.

## Not checked yet

- **A real car:** not tried. It needs a build signed with the entitlement (above).
- **The Simulator's CarPlay window:** not checked by CI. It can't open that window; it checks the entitlement, the scene manifest and the scene class.
