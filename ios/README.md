# Sirus Remote

The iPhone app for `/rc`: it lists the remote-controlled sessions on your Mac
and drives them. Sirus shapes everything and the app only draws it; the
protocol is in `docs/superpowers/specs/2026-09-28-remote-control-design.md`.

## Setup

1. Open `SirusRemote.xcodeproj` in Xcode 26 or later (iOS 26 target: the
   interface is Liquid Glass throughout).
2. Under Signing & Capabilities, choose your team and change the bundle id
   from `com.sirus.remote` to one of yours. Keep the Push Notifications
   capability.
3. For pushes, create an APNs key (.p8) in your developer account and add it
   to Sirus's `settings.json`:

   ```json
   "remote": { "apns": { "keyPath": "~/keys/AuthKey_XXXXXXXXXX.p8", "keyId": "XXXXXXXXXX", "teamId": "YOURTEAMID", "bundleId": "<your bundle id>" } }
   ```

   Builds run from Xcode register with the APNs sandbox; release builds with
   production.
4. Install Tailscale on the Mac and the iPhone, signed in as the same user.
5. Run the app on the phone. In a Sirus session on the Mac, enter `/rc`, then
   scan the QR code it shows with the Camera. You can also type the Mac's
   Tailscale name (for example `mac.tailnet.ts.net`) into the app.

Approval notifications carry Allow and Deny, plus Always Allow when the
request offers it. Allowing needs the phone unlocked (Face ID or passcode);
the answer goes straight to Sirus without opening the app.

## Simulator

The simulator reaches the Mac's loopback. Start Sirus with
`SIRUS_REMOTE_LOOPBACK=1`, enter `/rc`, and connect the app to `127.0.0.1`.

Launch arguments set the interface up for screenshots without tapping:
`-host <name>` (an empty name shows setup), `-sidebarExpanded YES`, and in
debug builds `-composerDraft <text>`, `-composerFocused YES`,
`-openPicker <command>`, `-sendOnLaunch <text>` and `-connectTo <name>`.

## Screenshots

`Screenshots/shoot.sh` shoots every screen in each state worth checking on
the iPhone SE and the largest iPhone, and at the largest text size, against
a stand-in Sirus (`Screenshots/mock-sirus.ts`) with long names, many agents
and waiting requests. The iOS screenshots workflow runs it on a change under
`Screenshots/`, or from the Actions tab, and keeps the pictures as an
artifact. Each shot prints what the app asked the stand-in and what it
logged, and the gist of any crash. To look at a few scenes quickly, list
them in `ONLY` or in a file named `Screenshots/only`, for example
`menu-command approval`; those are shot on the iPhone SE only.
