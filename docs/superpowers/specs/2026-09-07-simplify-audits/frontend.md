# Audit: frontend as a consumer of the runtime

Not a refactor target. This records exactly what the UI imports from outside `src/frontend`
so runtime changes can be checked against it.

## Runtime surface the UI uses

- `agent_runtime/session`: `Session`, `DEFAULT_MODEL` (`app.tsx:5`), `SessionStatus`,
  `Participant`, `QueuedMessage`. 28 Session members (see session audit). `Session.create` at
  `app.tsx:44`.
- `agent_runtime/types`: block and message types (`Chat.tsx:2`, `ChatMessage.tsx:2`,
  `InputBar.tsx:16`, `chat/draft.ts:1`).
- `permissions/permissions`: `pendingApprovals`, `resolveApproval`, `subscribePermissions`,
  `getPermissionsVersion`, `nextPermissionMode` (`Chat.tsx:23-29`); `PERMISSION_MODE_NAMES`,
  `describeRequester`, `ApprovalDecision`, `ApprovalRequest`, `PermissionMode`
  (`InputBar.tsx:30-36`); `isAwaitingApproval`, `isDeclinedResult` (`ChatMessage.tsx:15-20`);
  `describeRequester`, `pendingApprovals`, `subscribePermissions` (`useNotifications.ts:3-7`).
- `tools/subagents`: `subscribeSubagents`, `getSubagentsVersion` (`Chat.tsx:31`);
  `findSubagentByCall`, `SubagentStatus` (`ChatMessage.tsx:9-14`, reads `run.status`,
  `run.model`, falls back to `call.arguments.model` at `:198`); `listAllSubagents`
  (`useNotifications.ts:8-12`, reads `:88-101`).
- `providers/providers`: `providerFor`, `VENDORS` (`SubscriptionLimits.tsx:3`, reads
  `currentSource()`, `.type`, `.profile`, hardcodes vendor→period at `:39,59` and label `:30`).
  `providers/provider`: `subscribeProviderChanges` (`:4`). `providers/usage`:
  `cachedSubscriptionRemaining`, `formatRemaining`, `readSubscriptionUsage`, `remainingAllowance`.
  `providers/openai/codex-subscription`: `shutdownCodexRuntime` (`index.tsx:5,24`).
- `chat.ts`: `modelStrategies` (`app.tsx:15,43` validity check; `ParticipantMenu.tsx:2,24` as a
  never-overridden default parameter).
- `usage.ts`: `contextPercent`, `formatTokens`, `ContextUsage` (`InputBar.tsx:29`).
- `commands/registry`: `commandMenu`, `executeCommand`, `matchCommands`, menu types;
  `commands/feedback`: `Feedback`; `commands/session/behavior`: `permissionsCommand`
  (`Chat.tsx:30,257` — bypasses the registry). `CommandExecution` filled at `Chat.tsx:371-377`.
- `persistence`: `loadSessions`, `saveSessions`, `loadSirusModelPreference`,
  `PersistedSessions` (`app.tsx:6-11`, wiring at `:64-67,119-136` incl. `process.on('exit')`);
  `loadNotificationPreference`, `saveNotificationPreference` (`terminal/notifications.ts:3`).
- `images`: `attachClipboardImage`, `describeImage`, `removeStoredImage`.
- `fileSearch` (`FileMenu.tsx:4`), `fileMentions` (`MentionMenu.tsx:4`, `MentionText.tsx:4`).
- `checkpoints`: `enableCheckpoints` (`index.tsx:6`). `updater`: `checkSirusUpdate` (`app.tsx:16`).
  `abort`: `isAbortError`, `TurnCancelledError` (`Chat.tsx:22`).

## Load-bearing UI behaviours that runtime changes can break

- `key={activeSession.getId()}` (`app.tsx:182`) remounts Chat per session; draft promotion keeps
  the id so no remount fires mid-turn (`tests/frontend/app.test.ts:152` asserts identity).
- Exit-save at `app.tsx:124-128` is correct only because messages are mutated in place before
  throttled notifications.
- `Chat.tsx:416-431` infers send acceptance from message-array length (three behaviours ride on
  it: attachment retention, draft restore, draft promotion) — keep `sendMessage`'s semantics.
- Five `useSyncExternalStore` sites use `getVersion`-style counters as change signals;
  `Sidebar.tsx:166` joins all versions into a string.
- `getMessages()` identity must be stable between notifications.

## Tests pinning UI behaviour

Streaming throttle: no direct test (`chat_attachments.test.tsx:142`, `session_subagents.test.tsx:13`
indirectly). Exit-save round-trip: `app.test.ts:187`. Draft promotion: `app.test.ts:128,136,152,179`.
Queued editing: `input_bar.test.tsx:170`, `chat_attachments.test.tsx:142`. Permission prompt
flow: `input_bar.test.tsx:242`, `session_subagents.test.tsx:119`. Secret input:
`input_bar.test.tsx:308`, `chat.test.ts:11`. Mention menus: `mention_menu`, `file_mentions_integration`,
`file_menu`, `participant_menu`. Image attach: `draft.test.tsx`, `chat_attachments.test.tsx`.
Notifications: `notifications.test.ts`. Escape: `chat.test.ts:11`. Geometry: `app.test.ts:29`.
Sidebar ordering: `sidebar.test.tsx:84`, `session_recency.test.ts:14`. Draft survives switching:
`input_bar.test.tsx:27`.

Run suites with `FORCE_COLOR=1` and a scratch `HOME`/`SIRUS_DATA_DIR`.
