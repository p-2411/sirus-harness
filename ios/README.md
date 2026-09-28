# Sirus Remote

The iPhone app for `/rc`: it lists the remote-controlled sessions on your Mac
and drives them. Sirus shapes everything and the app only draws it; the
protocol is in `docs/superpowers/specs/2026-09-28-remote-control-design.md`.

## Setup

1. Open `SirusRemote.xcodeproj` in Xcode 16 or later (iOS 18 target).
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

Approval notifications carry Allow, Always Allow and Deny. Allowing asks for
Face ID first; the answer goes straight to Sirus without opening the app.

## Simulator

The simulator reaches the Mac's loopback. Start Sirus with
`SIRUS_REMOTE_LOOPBACK=1`, enter `/rc`, and connect the app to `127.0.0.1`.
