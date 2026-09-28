# Remote control: `/rc` and the Sirus iOS app

Agreed with the owner on 2026-09-28.

## Intent

Drive Sirus sessions running on the Mac from an iPhone, the way Claude remote
control and Codex remote do. `/rc` in a chat makes that session appear on the
phone. The app is a thin native wrapper: Sirus shapes everything, the app only
draws it, so Sirus can change without the app needing a release. Minimal,
aesthetic in Sirus's own design language, near-zero maintenance.

## Decisions

- Native SwiftUI app (the owner has Xcode and a paid developer account).
- Transport: Tailscale only. Sirus listens on its Tailscale address, never
  0.0.0.0 and never the Wi-Fi address. No relay, no Bonjour.
- Authentication is Tailscale identity: a connection is accepted only when
  `tailscale whois` says the peer device belongs to the same Tailscale user as
  the Mac. No pairing secret, no QR key exchange. `/rc` makes a session
  available immediately.
- Traffic is WireGuard-encrypted by Tailscale, so the socket itself is plain
  `ws://` on the tailnet.
- One-time phone setup: the first `/rc` while no phone has ever connected shows
  a QR code in the TUI holding only the address (`sirus://connect?host=…`).
  The Camera opens the app already configured. It never shows again once a
  device has connected (recorded in settings). The app also accepts the host
  typed by hand.
- Push notifications via APNs, sent by Sirus itself with the owner's .p8 key.
  Approvals carry lock-screen action buttons.
- Keep-awake: the Mac stays awake while any agent in any session of this
  process is working, and while any session of this process has `/rc` on.
- No `/rc always`. No session creation, model/thinking changes, files, diffs,
  images, rewind or Live Activities from the phone. No background session host
  (sessions still die with their terminal; deferred to a later version).

## Sirus side

New subsystem `src/remote/`, entry point `src/remote/index.ts`, consuming the
Session facade, the approval and question queues, and nothing else. Add a row to
`docs/ARCHITECTURE.md`'s table.

### `/rc`

- `/rc` toggles remote control for the current session. Feedback says what
  happened and where: `Remote control on · <magicdns-name>:<port>`.
- The session snapshot persists `remote: true` (optional field in the sessions
  zod schema), so it survives restarts; the listener comes back with it.
- The TUI header shows a small `rc` mark (theme `mention` colour) on a session
  with remote control on.
- Clear failures, from `/rc` and never silently: Tailscale not installed,
  not running, or logged out; no free port in the range. In each case `/rc`
  stays off and says exactly which, and how to fix it.
- Tailscale CLI: `tailscale` on PATH, else
  `/Applications/Tailscale.app/Contents/MacOS/Tailscale`. Own address and user:
  `tailscale status --json` (`Self.TailscaleIPs`, `Self.UserID`, `Self.DNSName`).
  Peer check: `tailscale whois --json <ip>` and compare `UserProfile.ID` with
  `Self.UserID`; cache the verdict per peer IP for the socket's lifetime.
- Development override `SIRUS_REMOTE_LOOPBACK=1`: bind 127.0.0.1, skip
  Tailscale entirely, accept loopback peers only. Used for smoke runs and the
  simulator.

### Listener

- `Bun.serve` with its native WebSocket, no new dependency. Started when the
  process's first session turns `/rc` on, stopped when the last turns off or
  is deleted.
- Port: the first free of 47470–47479 on the Tailscale IPv4 address. Several
  Sirus processes each take their own port; the app scans the range.
- `GET /v1/hello` (plain HTTP, same identity check) returns
  `{ "protocol": 1, "sirus": "<version>", "pid": 123 }`; the app uses it to scan.
- `GET /v1/socket` upgrades to the WebSocket carrying everything else.

### Protocol v1 (JSON text frames)

Every frame is an object with `type`. Client requests carry `id` (string); the
server answers each with `{ "type": "result", "id", "ok": true }` or
`{ "type": "result", "id", "ok": false, "error": "<human sentence>" }`.
Unknown `type`s and unknown fields are ignored on both sides: that is the
compatibility rule, and the only one. Enums the app does not know render as
their neutral default.

Server → client:

```jsonc
// Sent on connect and whenever the list changes (throttled 250 ms).
{ "type": "sessions", "focus": { "sessionId": "…", "participant": "sirus", "at": 1759000000000 } | null,
  "sessions": [ {
    "id": "…", "name": "Fix login redirect", "directory": "~/code/app",
    "working": true, "needsYou": false,      // needsYou: an approval or question is waiting
    "lastActivity": 1759000000000 } ] }

// Sent after `subscribe`, then on every change (throttled 100 ms).
// `rows` is an upsert list: new ids append, known ids replace. `removed` drops ids.
// The first frame after subscribe has `reset: true` and the whole window.
{ "type": "view", "sessionId": "…", "participant": "sirus", "reset": false,
  "header": {
    "participants": [ { "name": "sirus", "model": "opus[1m]", "vendor": "Claude",
                        "working": true, "needsYou": false } ],
    "status": { "participant": "sirus", "thought": "Reading the router", "startedAt": 1759… } | null,
    "queued": 0, "permissionMode": "Ask" },
  "rows": [ Row ], "removed": [ "rowId" ],
  "requests": [ Request ] }                  // the whole pending list for this session, every frame
```

`Row` (the last 200 visible rows of the participant's conversation, in order;
hidden entries and thoughts are left out, as in the TUI):

```jsonc
{ "id": "12:0", "kind": "user" | "assistant" | "tool" | "notice" | "compaction",
  "author": "you" | "sirus",               // display name, no @
  "to": ["codex"],                         // user rows: who it was addressed to
  "blocks": [ Block ],                     // user, assistant, notice, compaction
  "tool": { "title": "Edit src/app.ts", "kind": "edit",
            "state": "running" | "done" | "failed" | "declined" | "cancelled",
            "detail": [ Block ] },          // tool rows; detail is short, pre-trimmed
  "time": 1759000000000 }
```

`Block`: markdown already split by the server with `marked`'s lexer, so the app
only renders inline markdown per block (`AttributedString(markdown:)` with
inline-only syntax). `{ "kind": "paragraph" | "heading" | "code" | "quote" |
"list" | "rule", "text": "…", "level": 1, "language": "ts", "items": ["…"],
"ordered": false }`.
Mentions stay as `@name` text; the app tints `@known-participant` in the
mention colour.

`Request`:

```jsonc
{ "id": "…", "kind": "approval", "requester": "@codex",
  "title": "Run npm test", "detail": [ Block ],
  "options": [ { "id": "…", "label": "Allow once", "kind": "allow_once" } ] }   // ACP option kinds
{ "id": "…", "kind": "question", "requester": "@sirus", "message": "…",
  "fields": [ QuestionField ] }             // exactly src/agent_runtime/permissions/questions.ts QuestionField
```

Client → server:

```jsonc
{ "type": "subscribe", "id": "1", "sessionId": "…", "participant": "sirus" }   // replaces the previous subscription
{ "type": "send", "id": "2", "sessionId": "…", "participant": "sirus", "text": "…" }
    // Routed exactly as the TUI routes a message typed in that participant's
    // conversation (same draft building as Chat.tsx send(): @mentions, queueing
    // while busy, steering). Text starting with `/` runs through the command
    // registry like the TUI; a command that needs the terminal fails with its
    // own message. Feedback text comes back as the result's "feedback" string.
{ "type": "cancel", "id": "3", "sessionId": "…" }                              // what Esc does
{ "type": "approve", "id": "4", "requestId": "…", "optionId": "…" }
{ "type": "answer", "id": "5", "requestId": "…",
  "answer": { "action": "accept", "content": { } } | { "action": "decline" } } // QuestionAnswer
{ "type": "device", "id": "6", "apnsToken": "hex", "environment": "sandbox" | "production" }
```

Only sessions with `/rc` on are listed or reachable; anything naming another
session fails with "That session is not remote controlled." `focus` is the
session and participant last selected in this process's TUI, if it is `/rc`'d.

### Push notifications

- Settings (`settings.json`): `remote.apns = { keyPath, keyId, teamId, bundleId }`.
  Absent: no pushes, and `/rc` says so once in its feedback. Devices registered
  over `device` are saved in settings (`remote.devices`: token, environment,
  first seen); a token APNs rejects as unregistered is dropped.
- Sent with `node:http2` to `api.push.apple.com` / `api.sandbox.push.apple.com`,
  ES256 JWT via `node:crypto`, cached 50 minutes.
- Events, for `/rc` sessions only, beside the existing desktop notifications in
  `src/frontend/useNotifications.ts` (same wording): approval waiting, question
  waiting, turn finished (not cancelled).
- Payload: `aps.alert { title, body }`, `aps.thread-id` = session id,
  `aps.category`, and `sirus { sessionId, participant, requestId?, host, port }`.
- Approval categories: `APPROVAL` (Allow, Deny) and `APPROVAL_ALWAYS` (Allow,
  Always, Deny), chosen by which option kinds the request has. The payload
  carries `sirus.options: { "allow_once": id, "allow_always": id, "reject_once": id }`
  so the app answers by kind. Question and finish pushes open the app at that
  session.

### Keep-awake

`src/keepAwake.ts`, subscribed at app level like the notifications: while any
session in the process is working or has `/rc` on, run
`caffeinate -i -w <process.pid>` (one child; killed when the condition ends and
by `-w` if Sirus dies). Idle sleep only; a closed lid still sleeps the Mac.

## iOS app

`ios/SirusRemote/`, SwiftUI, iOS 18+, no third-party packages. Xcode project
with folder-synchronised groups (objectVersion 77) so adding a file never
touches the project file. Bundle id `com.sirus.remote` (placeholder the owner
changes), URL scheme `sirus`, push entitlement, ATS exception for `ts.net`
subdomains (insecure loads allowed; Tailscale encrypts) plus local networking
for the simulator's loopback.

Structure, each a few files:

- `Protocol/`: Codable mirrors of the frames above, lenient decoding (unknown
  kinds map to a neutral case, missing optionals are nil).
- `Connection/`: `RemoteClient` (URLSessionWebSocketTask, request ids, results,
  reconnect with backoff on foreground and network change), `HostScanner`
  (probes `/v1/hello` on 47470–47479, merges sessions from every process).
  Host stored in UserDefaults; nothing secret to store.
- `Views/`: Sessions list → Conversation (participant tabs like the TUI header,
  rows, status line with the current thought and elapsed time, input bar,
  stop button while working) → request cards in place of the input bar, as the
  TUI does. Setup screen when no host is set (paste/type host, or scan via the
  QR link).
- `Push/`: registration, categories and actions (answer approvals from the lock
  screen without opening the app), deep links from `sirus://connect` and from
  notification taps.
- Opens at `focus` if present, else the last session viewed.

Design language, from `src/frontend/styles/theme.ts`: near-black ground,
platinum `#C8CDD5` accents, arctic white `#F2F3F5` for the user's voice,
periwinkle `#8B93D6` for mentions only, gunmetal `#33373E` hairlines, titanium
`#8B919B` secondary text, amber `#E3B341` working, the one green `#00C853` for
tool activity, red `#BF6A6A`. SF Pro for prose, SF Mono for chrome (names,
tool rows, status). Hairlines over cards, no gradients, no shadows, generous
spacing. Dark only. The Sirus horse as the app icon mark.

## Verification

- Sirus: `tsc` (see the typecheck command in project notes) and the existing
  suite with a scratch HOME/SIRUS_DATA_DIR in both colour modes; no new test
  files. Smoke run with `SIRUS_REMOTE_LOOPBACK=1`: `/rc` in the TUI, then a
  script over the WebSocket that lists sessions, subscribes, sends a message to a
  scripted runtime, sees the rows stream, and answers a request.
- iOS: `swiftc -typecheck` of `Protocol/` and `Connection/` against the macOS
  SDK (the Command Line Tools have no iOS SDK). Views are verified when the
  owner opens the project in Xcode; the handover says so plainly.
