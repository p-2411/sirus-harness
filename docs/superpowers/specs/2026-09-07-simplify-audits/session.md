# Audit: session and turn orchestration

Files: `src/agent_runtime/session.ts` (952), `agent.ts`, `turn.ts`, `chat.ts`, `usage.ts`,
`src/mentions.ts`, `src/fileMentions.ts`, `src/checkpoints.ts`, `src/abort.ts`.

`SessionAgent` and `TurnContext` are single-purpose and well-factored; do not decompose them.
The complexity is concentrated in `session.ts`.

## Responsibilities in Session today

1 identity/config store (id, name, directory, permissionMode, inputContent) · 2 transcript
(`messages`, `append`, `getMessages`, `clear`, direct push/splice in `runInvocations` 818/845/861
and `rewind` 419) · 3 participant roster (`participants`, `defaultAgent`, `addParticipant`,
`findParticipant`, `createAgent` 932-940) · 4 thinking-level routing (568-600) · 5 user mention
parsing + participant creation (`mentionPattern` 111, `parseMentions` 708-742, `resolveMentions`
744-756) · 6 model-span stripping (`withoutCreationModels` 758-791) · 7 file-mention masking +
attachment resolution (300-308) · 8 agent→agent routing (`existingMentions` 907-921,
`delegationPrompt` 923-928, coalescing 875-901) · 9 the round loop (`runInvocations` 793-905) ·
10 streaming throttle (`STREAM_NOTIFY_MS` 127, `notifyStreaming` 690-702) · 11 status machine
(143-146, 678-682) · 12 checkpointing (432-437, barrier 328/344) · 13 rewind + guards (391-430)
· 14 cross-session directory locking (module globals 130-131) · 15 message queue + auto-drain
(452-495) · 16 timing/recency (155-162, 251-256) · 17 usage folds (511-534, imports
`contextWindowFor`) · persistence snapshot + auto-naming + legacy (624-640, 218-249, 79-86) ·
observer/versioning (140-142, 655-688) · subagent fan-out (357-370) · permission-context
construction (942-950).

## Public surface and callers

Used by frontend: `create`, `sendMessage`, `getActiveSubagentCount`, `cancel`, `queueMessage`,
`shiftQueuedMessage`, `getQueuedMessageCount`, `getQueuedMessages`, `updateQueuedMessage`,
`getActiveTurnStartedAt`, `getLastActivity`, `getConversationStartedAt`, `getContextUsage`,
`getMessages`, `isEmpty`, `getId`, `getName`, `getDirectory`, `getParticipants`, `getModel`,
`getThinkingLevel`, `getStatus`, `wasLastTurnCancelled`, `getAssistantVersion`,
`getPermissionMode`, `getInputContent`, `setInputContent`, `subscribe`, `getVersion`.
Used by commands: `clear`, `getCheckpoints`, `rewind`, `setName`, `getName`, `getDirectory`,
`isEmpty`, `getThinkingLevel`, `setThinkingLevel`, `changeParticipantModel`, `getTotalUsage`,
`getContextUsage`, `getPermissionMode`, `setPermissionMode`.
Used by persistence: constructor (legacy path), `fromSnapshot`, `toSnapshot`, `isEmpty`, `getId`.
Test-only: `append` (~30 sites), `addParticipant` (17), `setModel` (4), `clearQueuedMessages` (1).
No external caller: `getDefaultParticipant`, `sessionNameFromPrompt`, `SESSION_NAME_LIMIT`,
`TokenTotals`, `RewindOptions` exports, `LegacySessionSnapshot` + legacy `fromSnapshot` branch
(persistence.ts:226 constructs legacy sessions directly; the branch is unreachable).

## Problems

- 14-positional constructor (164-179); `Session.create` passes six `undefined`s; tests are
  unreadable (`tests/frontend/sidebar.test.tsx:93`, `tests/data/session_checkpoints.test.ts:203`).
  Argument-dependent default at 178 hides a rule in a parameter list.
- Module globals `directoryTurns`/`restoringDirectories` (130-131): not injectable, not
  resettable; directory liveness answered by three sources (405, 402, and
  `commands/checkpoints/behavior.ts:132`).
- Mention grammar encoded three times (711-717, 910-918, validation regex 269); `.replace(/^@/,'')`
  four times; two name-equality notions (`sameName` locale-accent vs `toLocaleLowerCase` keys).
  `fileMentions.ts:26` has a fourth `@` pattern reconciled by the space-masking hack at 302-304.
- `runInvocations`: index-correlated `pending`/`liveMessages`/`settled`; two divergent commit
  paths (842-847 vs 848-866); `indexOf`-splice into a shared array (860-861); `changed` is
  vacuously true (863); three failure flavours in one function.
- `startConversationIfNeeded` called from two mutually exclusive guards (260 test-only path,
  322 production path).
- Two queue drainers: `sendNextQueuedPrompt` (472-479) and `Chat.tsx:443-447`; the `/` policy
  comment (469-471) is a UI concern inside the domain object.
- Session imports six concrete modules (3, 5, 7, 8, 16-21, 22); tests must mutate global
  `modelStrategies` and `enableCheckpoints`.
- Untested: the empty-failed-bubble splice (856-862). Reaching it needs one participant to
  stream while a sibling fails before emitting anything. `tests/data/data.test.ts:784` covers
  the kept-partial case only.

## Behaviours to preserve (test that pins each)

1. Barrier: provider starts immediately; every mutating tool waits on `beforeMutation`
   (`tests/agent/checkpoint_barrier.test.ts:21,34,47`; `tests/data/session_checkpoints.test.ts:53`).
2. `finally` awaits the barrier even on failure/cancel (`session_checkpoints.test.ts:186`).
3. Streaming throttle 50 ms, first immediate, latest-wins, timer unref'd (`tests/data/data.test.ts:176`).
4. Round coalescing: several agents mentioning one peer → one invocation with all mentioners
   (`data.test.ts:644`, asserts `calls[2].turn.turnPrompt`/`calls[3]`).
5. Self-mention excluded (`data.test.ts:704`).
6. Cancelled round throws immediately; a peer that finished first must not start round N+1
   (`data.test.ts:357`, `:278`).
7. Streamed content survives cancel/failure; a bubble that never produced content is removed
   (`data.test.ts:784` kept case; erase case untested — add one).
8. User mentions run in parallel, commit in mention order, `@FIRST` after `@first` collapses
   (`data.test.ts:450`).
9. Round bubbles reserved all at once on first stream; `messages` stays length 1 until then
   (`data.test.ts:450`).
10. Every participant in a round sees the same immutable history snapshot (`data.test.ts:644`).
11. New-participant model span stripped from stored history and from providers (`data.test.ts:450`).
12. A model after an existing participant is not stripped (`data.test.ts:498`).
13. Whole-turn validation before mutation: bad mention → no participant, no history
    (`data.test.ts:520`; `tests/file_mentions.test.ts:203`).
14. Agents cannot create participants (`data.test.ts:644`).
15. Mentions route only from top-level prose (`tests/mentions.test.ts:5,33`; `data.test.ts:549,592,621`).
16. `@scope/package` stays text (`data.test.ts:530`; `file_mentions.test.ts:177`).
17. File mentions masked before routing, offsets preserved (`file_mentions.test.ts:134,177,188`).
18. Attachments resolve synchronously before participant creation (`file_mentions.test.ts:134,203`;
    `tests/frontend/file_mentions_integration.test.tsx:264`).
19. Auto-naming: first prompt while `autoNamePending`; 40-char word-boundary cut with `…`;
    `setName` clears the flag (`data.test.ts:45`).
20. Conversation-start 5-minute rule from `lastResponseFinishedAt`, inclusive at exactly
    300 000 ms; rejected prompts do not move it (`tests/data/session_recency.test.ts:14,45`).
21. Old snapshots without clock fields fall back to `updatedAt` (`session_recency.test.ts:79`).
22. `lastResponseFinishedAt` stamped at end of model work (`session_recency.test.ts:45`).
23. Queued `/` commands never auto-sent; anything behind them waits (`data.test.ts:259`).
24. Non-command queued prompts drain FIFO without a mounted Chat; a cancelled turn still
    releases the next (`data.test.ts:230,278`).
25. Queue not persisted (`data.test.ts:217`).
26. Queued prompts capture their own checkpoint and index (`session_checkpoints.test.ts:118`).
27. Status: `working` on send, `error` sticky until next send, `idle` after cancel
    (`data.test.ts:784`, `:357`).
28. `wasLastTurnCancelled` drives notification suppression (`tests/frontend/notifications.test.ts:96`).
29. Chat rewind drops that checkpoint and all later; file-only keeps all (`session_checkpoints.test.ts:70,84`).
30. Chat rewind and `clear` reset provider runtimes (`session_checkpoints.test.ts:56`).
31. Rewind guards: active turn, active rewind, own working subagents, another session in the
    directory, any subagent in the directory (`session_checkpoints.test.ts:186,211,279`).
32. Failed file restore leaves history/checkpoints untouched (`session_checkpoints.test.ts:201`).
33. `sendMessage` refused while restoring (`session_checkpoints.test.ts:186`).
34. `clear` refuses during turn/rewind; clearing empty is a silent no-op (`data.test.ts:838,850`).
35. Default agent's runtime id is the session id; others `${id}/participants/${encodeURIComponent(lower)}`
    (`data.test.ts:878`; `tests/frontend/session_subagents.test.tsx:13`).
36. `setThinkingLevel` resets only that participant, no-op when unchanged (`data.test.ts:25`;
    `tests/data/persistence.test.ts:32`).
37. Permission mode read live via closure (`session_checkpoints.test.ts`).
38. Empty sessions neither saved nor restored (`persistence.test.ts:136`).
39. Legacy `{model}` snapshots load with launch directory and `updatedAt: 0`
    (`persistence.test.ts:112`; `session_recency.test.ts:79`).
40. `version` monotonic; `assistantVersion` separate (`data.test.ts:868`; `tests/frontend/sidebar.test.tsx:121,134`).
41. `notifyListeners` cancels pending streaming timer and resets the throttle clock.
42. Draft per session, survives switching, persisted (`tests/frontend/input_bar.test.tsx:27`;
    `persistence.test.ts:88`).
43. `sendMessage` rejects non-user messages (no test).

## Migration

- `persistence` → snapshot-only (see persistence audit). `app.tsx:44` → `new Session({...})`.
- `Chat.tsx`, `Sidebar.tsx`, `useNotifications.ts`, `commands/*`: zero edits if facade names
  survive.
- Tests: ~30 positional `new Session(...)`, 14 `Session.create`, 4 `setModel`, 1
  `clearQueuedMessages`. `append`/`addParticipant` stay public.
- Sequence: options object → ChangeFeed/MessageQueue/CheckpointLog → Transcript → Roster →
  TurnRunner (highest risk; write the erase-path test first) → delete dead code.
- `getMessages()` must keep returning the live array; the UI depends on identity + version.
