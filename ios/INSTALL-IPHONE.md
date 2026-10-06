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

1. Get `kinoteatri-ipa.zip` (the lead sends the link) and unzip it with the password you were
   given: inside is `Kinoteatri.ipa`.
2. Put `Kinoteatri.ipa` on the iPhone: save it to **iCloud Drive** from the PC (or email it to
   yourself and save the attachment to **Files**).
3. Open **AltStore → My Apps → +** (top left), pick `Kinoteatri.ipa`. AltStore signs and installs
   it (the PC must be on with AltServer running, same Wi-Fi).
4. Open **Kinoteatri** from the home screen.

Install it from AltStore like this, not with AltServer's "Sideload .ipa…" menu: apps AltStore
installs renew themselves every week; apps sideloaded from the PC menu must be reinstalled by hand.

## Good to know

- **7 days.** With background refresh on (AltStore → Settings) the app renews by itself when the
  PC runs AltServer on the same Wi-Fi. If it ever stops opening, open AltStore → **Refresh All**.
- **3 apps.** A free Apple ID allows 3 sideloaded apps at a time (AltStore itself is one).
- The app works anywhere on its own: home Wi-Fi, other Wi-Fi, mobile data. The PC is only needed
  for the weekly renewal.
