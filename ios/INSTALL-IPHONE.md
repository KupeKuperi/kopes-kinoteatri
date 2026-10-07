# Installing Kinoteatri on an iPhone (AltStore, free)

Apple only allows App Store apps, so the app goes on the iPhone through **AltStore**, which signs
it with your own Apple ID. Free; the one catch is that apps signed with a free Apple ID last
7 days, and AltStore renews them in the background while your PC runs AltServer and the phone
is on the same Wi-Fi (or you tap **Refresh All** in AltStore yourself).

Your Apple ID and password are typed only into AltServer (it sends them only to Apple).

## Once: put AltStore on the iPhone (from the Windows PC)

1. Install **iTunes** and **iCloud** from Apple's website, *not* the Microsoft Store:
   - iTunes: https://www.apple.com/itunes/download/win64
   - iCloud: https://updates.cdn-apple.com/2020/windows/001-39935-20200911-1A70AA56-F448-11EA-8CC0-99D41950005E/iCloudSetup.exe
2. Download **AltServer**: https://cdn.altstore.io/file/altstore/altinstaller.zip, unzip it, run
   `Setup.exe`. Start AltServer from the Start menu with **Run as administrator** and allow it on
   the network.
3. Plug the iPhone into the PC with a cable, unlock it and tap **Trust**.
4. Open iTunes, sign in with your Apple ID, select the iPhone and turn on **Sync with this iPhone
   over Wi-Fi** (so AltStore can renew apps without the cable later).
5. Click the AltServer icon in the taskbar → **Install AltStore** → your iPhone. Sign in with your
   Apple ID when it asks.
6. On the iPhone: **Settings → General → VPN & Device Management** → your Apple ID → **Trust**.
7. On the iPhone: **Settings → Privacy & Security → Developer Mode** → on, and restart when asked.

AltStore is now on the home screen.

## Each new version: install Kinoteatri

1. Get `Kinoteatri.ipa`. On this PC it's ready at `moviebox-gui\ios\out\Kinoteatri.ipa`. (New
   builds come from GitHub Actions as `Kinoteatri-ipa.zip`, locked with the IPA password, which
   is in `moviebox-gui\ios\out\ipa-password.txt` on this PC; Windows opens the zip with a
   double-click and asks for it.)
2. Put `Kinoteatri.ipa` on the iPhone, in the **Files** app. Easiest ways:
   - **Telegram:** on the PC, send the file to your own **Saved Messages**; on the iPhone open it
     there → share button → **Save to Files**.
   - **iCloud Drive:** copy it into the iCloud Drive folder on the PC (iCloud for Windows, signed
     in with iCloud Drive on); it appears in Files → iCloud Drive.
   - **Email:** mail it to yourself; on the iPhone tap the attachment → **Save to Files**.
3. Open **AltStore → My Apps → +** (top left), pick `Kinoteatri.ipa`. AltStore signs and installs
   it (the PC must be on with AltServer running, same Wi-Fi).
4. Open **Kinoteatri** from the home screen: search a film, open it, tap a stream. Rotate the
   phone or use the player's full-screen button for landscape.

Install it from AltStore like this, not with AltServer's "Sideload .ipa…" menu: apps AltStore
installs renew themselves every week; apps sideloaded from the PC menu must be reinstalled by hand.

## If "Install AltStore" fails

- **"This action cannot be completed at this time (-22411)":** sign in to **iCloud for Windows**
  (Start → iCloud) with the same Apple ID the iPhone uses (Settings → your name), enter the code
  the iPhone shows, untick the sync options if you like, then try Install AltStore again with
  that Apple ID. (Confirmed fix in AltStore's GitHub issues #1720 and #785, 2026.)
- Click AltServer's icon → **Check for Updates…** first: AltServer fixed an Apple ID sign-in
  problem in September 2026.
- After several failed tries in a row Apple blocks sign-ins for a while: wait an hour.
- The iPhone isn't in the Install AltStore list: unlock it, tap **Trust** on "Trust This
  Computer?", keep iTunes open.

## Optional: no PC after the setup (Remote AltServer)

AltServer only runs on a computer, and the first setup above needs one once. After that,
AltStore can install and renew apps from the phone itself, through AltStore's Remote AltServers
on the internet instead of your PC:

1. AltStore → **Settings → Remote AltServer → Set up Remote AltServer…** and follow its steps
   (it pairs with the PC once and installs the small **LocalDevVPN** app).
2. To install or renew: be on **Wi-Fi** (not mobile data) with **LocalDevVPN** connected, then
   use AltStore as usual (My Apps → + for Kinoteatri, Refresh All to renew).

The 7-day renewal and the 3-app limit stay the same; only the PC is no longer needed for them.

## Good to know

- **7 days.** With background refresh on (AltStore → Settings) the app renews by itself when the
  PC runs AltServer on the same Wi-Fi. If it ever stops opening, open AltStore → **Refresh All**.
- **3 apps.** A free Apple ID allows 3 sideloaded apps at a time (AltStore itself is one).
- The app works anywhere on its own: home Wi-Fi, other Wi-Fi, mobile data. The PC is only needed
  for the weekly renewal.
