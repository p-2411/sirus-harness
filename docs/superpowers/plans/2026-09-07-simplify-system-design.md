# Simplify System Design Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose the five god-modules (Session, provider, permissions/tools, persistence, memory store) into small units with obvious interfaces, delete dead code, and make "add a model / vendor / tool / command / setting" a one-place change, with every existing test still green.

**Architecture:** Each subsystem gets a facade with the same public names its consumers use today, backed by collaborators that are constructible and testable on their own. Module-level singletons become injectable instances with a process-wide default. Static facts (models, vendors, tool effects) become data tables so shared logic never needs editing to extend.

**Tech Stack:** Bun 1.3, TypeScript 5.9 strict, Ink/React TUI, zod, bun:sqlite. Tests: `bun test`.

**Spec:** `docs/superpowers/specs/2026-09-07-simplify-system-design.md` and the audits in `docs/superpowers/specs/2026-09-07-simplify-audits/`.

## Global Constraints

- No commits. The owner reviews the working tree. (Harness rule; overrides the skill's commit steps.)
- No new test files unless the spec names the gap: the empty-failed-bubble discard, and characterisation tests for the shell classifier. Existing tests are edited only where they reach internals that no longer exist.
- Public names used by `src/frontend` and `src/commands` survive unless the spec says otherwise (see the frontend audit for the list).
- Verification after every task, both green:
  - `bun run typecheck`
  - `HOME=<scratch>/home SIRUS_DATA_DIR=<scratch>/home/data FORCE_COLOR=1 bun test tests`
  Both can exceed 30 s; run them in the background writing to a log file and poll it.
- Never run the app or tests against the real `~/Library/Application Support/Sirus`.
- The owner may edit files concurrently. Re-read a file immediately before editing it and use exact-match edits.
- Frozen strings: the two continuation-rewrite prompts in the provider fallback loop; every `Usage:` string a test asserts; every user-facing error message a test asserts.
- Directory-vs-file resolution hazard: never leave both `foo.ts` and `foo/` for the same import path. When a module becomes a directory, delete the file and add `index.ts`.

## Task ordering

```
Task 0 (dead code)          — inline, first
Task 1 (session)  ∥  Task 6 (memory)     — disjoint files
Task 3 (tools, toolbox, permissions, subagents)
Task 2 (providers, catalog, registry)
Task 4 (persistence) ∥ Task 5 (commands + frontend adaptations)
Task 7 (final review, smoke run, docs)
```

Task 3 precedes Task 2 because transports switch to `turn.toolbox` (Task 3) before the
provider layer is rebuilt around them (Task 2).

---

### Task 0: Remove dead code

**Files:**
- Delete: `config.ts`, `src/agent_runtime/providers/credentials.ts`, `src/memory/graph.ts`, `debug.log`
- Modify: `src/memory/store.ts` (remove `listMemories`), `src/commands/registry.ts:23` (drop the `loginMenuItems` re-export; make `commandRegistry` `readonly CommandSpec[]`), `tests/commands/command_register.test.ts:11` (import `loginMenuItems` from `../../src/commands/authentication/behavior`), `src/frontend/chat/Chat.tsx:32` (delete the commented `../../state` import)

- [ ] Step 1: `git rm` the four files.
- [ ] Step 2: Remove `listMemories` (`store.ts:225-234`) and any type it alone used.
- [ ] Step 3: Registry and test edits above.
- [ ] Step 4: Typecheck and full test run; both green.

---

### Task 1: Session decomposition

**Files:**
- Create: `src/agent_runtime/session/index.ts` (facade), `options.ts`, `transcript.ts`, `roster.ts`, `turnRunner.ts`, `checkpointLog.ts`, `messageQueue.ts`, `changeFeed.ts`
- Delete: `src/agent_runtime/session.ts`
- Modify: `src/persistence.ts:226-241` (construct `new Session({...})`), `src/frontend/app.tsx:44` (`new Session({ name, directory, model, autoNamePending: true })`), `src/commands/checkpoints/behavior.ts:132` (directory activity query), every test that uses the positional constructor, `Session.create`, `setModel`, or `clearQueuedMessages`
- Test (new, one file): `tests/data/session_rounds.test.ts` with the empty-failed-bubble discard case

**Interfaces:**
- Produces: `Session` as in spec §1; `SessionOptions`; `SessionSnapshot` unchanged;
  `isAutoSendable(text: string): boolean` exported from `session/messageQueue.ts` and re-exported
  from `session/index.ts`; `DirectoryActivity` interface and `defaultDirectoryActivity` exported
  from `session/checkpointLog.ts` (Task 3 wires `activeSubagentCount` into it; until then the
  default implementation calls the existing `activeSubagentCount` from `tools/subagents`);
  `Session` keeps a private method that builds the per-turn `PermissionContext` (Task 3 replaces
  it with a toolbox factory).
- Consumes: nothing new.

- [ ] Step 1: Read the spec §1 and `audits/session.md` in full. Note behaviours 1-43.
- [ ] Step 2: Write the new test for behaviour 7's erase path: two participants in one round; the first streams a text block then finishes; the second rejects before any `updateStream`. Assert the transcript ends with exactly one assistant message (the first participant's) and that `sendMessage` rejects with the second's error. Run it against the current code; it must pass (it characterises existing behaviour).
- [ ] Step 3: Create `changeFeed.ts`, `messageQueue.ts`, `checkpointLog.ts`, `transcript.ts`, `roster.ts`, `turnRunner.ts` with the responsibilities in spec §1. Move code, do not rewrite behaviour. Unify the mention grammar into one scanner in `roster.ts`; name keys are `toLocaleLowerCase()`.
- [ ] Step 4: Create `session/index.ts` with the facade. Delete `session.ts`. Keep `append`, `addParticipant`, `sessionNameFromPrompt` (used by the facade), `DEFAULT_MODEL`, `SESSION_NAME_LIMIT` exports. Remove `Session.create`, `setModel`, `clearQueuedMessages`, `getDefaultParticipant`, `LegacySessionSnapshot`.
- [ ] Step 5: Update `persistence.ts`, `app.tsx`, `commands/checkpoints/behavior.ts`, and tests. `Chat.tsx:443-447` uses `isAutoSendable`.
- [ ] Step 6: Typecheck and full test run; both green. Report the new line count of each file.

---

### Task 6: Memory store

**Files:**
- Create: `src/memory/schema.ts` (migration, moved verbatim), `src/memory/vectorIndex.ts`
- Modify: `src/memory/store.ts`, `src/agent_runtime/tools/memories.ts`, `src/agent_runtime/tools/arguments.ts:33-76`, `tests/memory/store.test.ts`, `tests/agent/tools.test.ts` (only if error text changes; prefer keeping it identical)

**Interfaces:**
- Produces: `MemoryStore` port `{ save(target, input), get(target, name), delete(target, name), search(scope, directory, query, limit?), close() }`; `MemoryTarget { scope: MemoryScope; directory: string }`; `memoryStoreFor(directory?: string): MemoryStore`; `closeAllMemoryStores(): void`. Existing `Memory`, `MemoryLink`, `MemoryScope`, `MemorySearchScope`, `MemorySearchResult` types unchanged.
- Consumes: nothing from other tasks. `tools/memories.ts` keeps its four exported functions with the same names (Task 3 folds it into one file later).

- [ ] Step 1: Read spec §6 and audit section B.
- [ ] Step 2: Move `migrate`, `createMemoryTable`, `createMemoryIndexes`, `migrateLegacyMemories`, `createVectorTable`, `tableExists`, `tableHasColumn` verbatim into `schema.ts` with signature `migrate(db, embedder: { model; dimensions }): { needsReindex: boolean }`. Preserve the ordering at `store.ts:311-316`.
- [ ] Step 3: Move the vector table + `ensureIndex`/`reindex`/`searchScope` into `vectorIndex.ts`.
- [ ] Step 4: Reshape the store to the five-method port over `MemoryTarget`; keep validation inside the store; delete the three redundant validators in `arguments.ts`; pass args through from `tools/memories.ts`.
- [ ] Step 5: Replace the singleton with `memoryStoreFor`/`closeAllMemoryStores`.
- [ ] Step 6: Update `tests/memory/store.test.ts` call shapes. Typecheck and full test run; green.

---

### Task 3: Tools, toolbox, permissions, subagents

**Files:**
- Create: `src/agent_runtime/tools/toolbox.ts`, `src/agent_runtime/tools/index.ts`, `src/agent_runtime/tools/subagents/{run,registry,report,stream}.ts` + `index.ts`, `src/agent_runtime/permissions/{classify,approvals,policy,describe}.ts` + `index.ts`
- Delete: `src/agent_runtime/tools.ts`, `tools/runtime.ts`, `tools/{files,shell,search,memories,agents}/` directories (fold into the sibling `X.ts`), `tools/subagents.ts`, `permissions/permissions.ts`
- Modify: `tools/types.ts`, `tools/{files,shell,search,memories,agents}.ts`, `turn.ts` (`tools: boolean` and `permissions` → `toolbox: Toolbox | null`), `chat.ts` (loop uses `turn.toolbox.run`), `agent.ts`, `session/index.ts` + `session/turnRunner.ts` (build the toolbox per turn), `permissions/judge.ts` (pass `toolbox: null`), `providers/anthropic/api.ts:289`, `providers/openai/api.ts:169`, `providers/anthropic/claude-subscription.ts:196-228,385-398`, `providers/openai/codex-subscription.ts:318-348,397-402` (read `turn.toolbox.tools`, call `turn.toolbox.run`), `commands/checkpoints/behavior.ts`, frontend imports of `tools/subagents` and `permissions/permissions` (paths only; names unchanged), tests under `tests/agent/` and `tests/data/data.test.ts:155-161`
- Test (new): `tests/agent/shell_classification.test.ts` characterising `classifyShellCommand`, `classifyGit`, `splitShellCommand`, `allowanceKeyFor` — written against the current code first

**Interfaces:**
- Produces: `Tool`, `ToolContext`, `SubagentHost`, `Toolbox`, `createToolbox(options)` as in spec §3; `TurnContext.toolbox: Toolbox | null`; `TurnOptions.toolbox?: Toolbox`; `PermissionContext { sessionId; mode(); requester; model }` (no `beforeMutation`); `permissions/index.ts` re-exporting every name the frontend and commands import today; `tools/subagents/index.ts` re-exporting `subscribeSubagents`, `getSubagentsVersion`, `listAllSubagents`, `findSubagentByCall`, `activeSubagentCount`, `SubagentStatus`, `SubagentRun`, `startSubagent`, `checkSubagent`, `cancelSubagent`, `describeSubagents`; `toolRegistry` and `availableTools(audience)` kept as exports of `tools/index.ts` for tests and the prompt.
- Consumes: `Session` from Task 1 (`session/index.ts`, `session/turnRunner.ts`).

- [ ] Step 1: Read spec §3 and `audits/tools-permissions.md`.
- [ ] Step 2: Write the shell-classification characterisation test against the current `permissions.ts` (at least: `ls`, `cat`, `git status`, `git commit`, `rm -rf`, `find . -delete`, `sort -o`, a pipeline with one mutating stage, `&&` chains, quoted args). Run; passes.
- [ ] Step 3: Fold each `X/tools.ts` into `X.ts` as `Tool` objects with `effect`, `audience`, `requires`, `run(args, ctx)`. `agents.ts` reads the model list via a function parameter or `providers/providers` (Task 2 replaces it with the catalog), never via `chat.ts`. Delete the directories.
- [ ] Step 4: Create `toolbox.ts`. `createToolbox` filters by audience and memory, rejects unknown and non-visible names at `run`, awaits `beforeMutation` for `effect !== 'read'`, authorises through `permissions` when present, executes, formats. Keep the cancellation and error rules from `runtime.ts:62-125`.
- [ ] Step 5: Split `permissions.ts` into the four modules; move the shell parser verbatim into `classify.ts`. Classification of a tool call = `Tool.effect` (function form for `RunShell`, which runs the shell parser; `RunShell.effect` for the barrier purpose is `'mutates'`). Drop the dead exports.
- [ ] Step 6: `turn.ts`, `chat.ts`, `judge.ts`, the four transports, `agent.ts`, `session/*` switch to `turn.toolbox`. Subagent workers get a toolbox with `audience: { subagent: true }`.
- [ ] Step 7: Split `subagents.ts` into `subagents/`. `SubagentRun` gains `sessionId`. `checkpointLog.defaultDirectoryActivity` asks the subagent registry.
- [ ] Step 8: Typecheck and full test run; green. Confirm no file imports `tools.ts` or `permissions/permissions` any more.

---

### Task 2: Providers, catalog, registry

**Files:**
- Create: `src/agent_runtime/providers/{catalog,transport,sources,fallback,registry}.ts`
- Rewrite: `src/agent_runtime/providers/provider.ts` (composition only), `providers/providers.ts` → delete, `providers/index.ts` (re-exports for `'../providers'` style imports if any)
- Modify: `chat.ts` (delete `ModelStrategy`; `providerForModel(agent.model).getResponse`), `agent.ts:91-93` (`resetRuntime` via `providerForModel`), `session/roster.ts` (`isKnownModel`, `modelIds()` in error text), `tools/agents.ts` (`modelIds()`), `permissions/judge.ts` (`judgeModelFor`), `providers/login.ts`, `profiles.ts`, `usage.ts` (vendor tables from `VENDOR_INFO`), `anthropic/index.ts`, `openai/index.ts`, `openai/codex-subscription.ts:83-87` (read `traits` from the catalog), `commands/agents/behavior.ts`, `commands/authentication/behavior.ts`, `commands/memory/behavior.ts`, `commands/update/behavior.ts` (`Notify` type moves to `commands/types.ts`), `frontend/app.tsx:43`, `frontend/chat/ParticipantMenu.tsx:24`, `frontend/SubscriptionLimits.tsx` (`VENDOR_INFO[vendor].limitPeriod`/`accountName`, `activeSource()`), `frontend/index.tsx:24` (`disposeAll`), tests under `tests/agent/`, `tests/frontend/subscription_limits.test.tsx`, `tests/commands/`

**Interfaces:**
- Produces: everything in spec §2. `Vendor` derived from `VENDOR_INFO` keys. `Transport.toolExecution`. `runWithFallback` in `fallback.ts` with the two prompt strings byte-identical. `registry.ts`: `providerFor`, `providerForModel`, `allProviders`, `onProviderChange`, `resetAllRuntimes`, `disposeAll`. `catalog.ts`: `MODELS`, `VENDOR_INFO`, `VENDORS`, `parseVendor`, `modelInfo`, `isKnownModel`, `modelIds`, `modelsOf`, `contextWindowFor`, `judgeModelFor`, `DEFAULT_MODEL` (moved from session).
- Consumes: `turn.toolbox` from Task 3.

- [ ] Step 1: Read spec §2 and `audits/providers.md` (behaviours 1-31 and the hazards).
- [ ] Step 2: `catalog.ts` with the eight models and two vendors as data; `gpt-6-astra` carries `contextWindow: 1_050_000` and its Codex thread traits.
- [ ] Step 3: `sources.ts`: `createSourceStore(vendor, settings)` reading `providerSources`, falling back once to the legacy `subscriptions`/`apiKeys` shape, appending the env key, and writing only `providerSources` (plus deleting `apiKeys[vendor]` as today). Keep the settings schema fields optional.
- [ ] Step 4: `fallback.ts`: move `provider.ts:239-297` verbatim, parameterised on attempts and a sticky map; the `source.type === 'subscription'` checks become `transport.toolExecution === 'delegated'`.
- [ ] Step 5: `provider.ts`: `createProvider({ vendor: VendorInfo, api: (key) => Transport, subscriptionFor: (profile) => Transport })` returning the spec's `Provider`. Per-runtime active source instead of the single slot, but keep behaviour 21 (the sidebar row switches while a fallback is in flight).
- [ ] Step 6: `registry.ts`; delete `providers.ts` and `modelStrategies`; update every consumer listed above; `shutdownCodexRuntime` becomes the OpenAI provider's `dispose`, exposed to tests through `disposeAll`.
- [ ] Step 7: Typecheck and full test run; green. Confirm `grep -r modelStrategies src tests` is empty. Show, in the report, the diff needed to add a hypothetical `claude-opus-6`.

---

### Task 4: Persistence and settings

**Files:**
- Create: `src/dataDirectory.ts`, `src/persistence/{atomicJson,settings,sessions,subscriptionLimits,index}.ts`
- Delete: `src/persistence.ts`, `src/agent_runtime/memory-access.ts`
- Modify: the nine `dataDirectory` importers, `frontend/app.tsx:64-67,119-136` (snapshot repository + empty-session filter), `frontend/terminal/notifications.ts`, `commands/agents/behavior.ts:100`, `commands/memory/behavior.ts`, `tools/toolbox.ts` and `prompt.ts` (memory flag via settings), `providers/sources.ts` and `providers/usage.ts` (settings + limit cache), `tests/data/persistence.test.ts`, `tests/data/session_recency.test.ts`, `tests/frontend/app.test.ts`, other tests that import persistence functions

**Interfaces:**
- Produces: `dataDirectory()`; `readJson`/`writeJson`; `openSettings(directory?)` → `{ get, set }` over `SettingsShape { subscriptions; providerSources; memoryEnabled; apiKeys; sirusModel; notifications }`; `loadSessionSnapshots(directory?, fallbackDirectory?)` → `{ snapshots: SessionSnapshot[]; selectedSessionId }`; `saveSessionSnapshots(snapshots, selectedSessionId, directory?)`; `loadSubscriptionLimitCache`/`saveSubscriptionLimitCache`/`clearSubscriptionLimitCache` with an optional directory; `index.ts` re-exports all of these plus the types. Keep `loadNotificationPreference`/`saveNotificationPreference`, `loadSirusModelPreference`/`saveSirusModelPreference`, `loadMemoryAccessPreference`/`saveMemoryAccessPreference` as one-line wrappers over `openSettings` so that consumers outside the tasks in flight need no edit.
- Consumes: `Session.fromSnapshot`/`toSnapshot` from Task 1; `SourceStore` from Task 2.

- [ ] Step 1: Read spec §4 and audit section A. Add the legacy-JSON full-snapshot assertion to `tests/data/persistence.test.ts` before deleting either migration copy.
- [ ] Step 2: `dataDirectory.ts`; update importers.
- [ ] Step 3: `settings.ts` with a passthrough parse so unknown keys survive; read-through, no cache.
- [ ] Step 4: `sessions.ts` working on snapshots only (type-only import); legacy normalisation here.
- [ ] Step 5: `app.tsx` maps sessions → snapshots, filters empty ones, keeps the exit hook.
- [ ] Step 6: Typecheck and full test run; green. Confirm `src/persistence/` imports nothing from `agent_runtime` at runtime.

---

### Task 5: Commands and frontend adaptations

**Files:**
- Modify: `src/commands/types.ts` (`CommandContext`, `CommandSession`, `AttachesImages`, `QuitsApp`, `Notify`), `registry.ts`, every `commands/*/commands.ts` and `behavior.ts`, collapse `memory/`, `notifications/`, `update/` to one file each, `frontend/chat/Chat.tsx:245-258,328-347,350-404` (shift+tab via `send('/permissions …')`; secret items executed with `[...args, value]`), `tests/commands/*`, `tests/frontend/chat.test.ts`, `tests/frontend/input_bar.test.tsx` if they assert the old context shape
- Create: `src/commands/README.md` stating the file-layout rule (one paragraph)

**Interfaces:**
- Produces: `CommandContext { session: CommandSession; signal: AbortSignal; notify(text): void }`; `CommandSpec.run(args, context: CommandContext & Partial<AttachesImages & QuitsApp>)` with the two commands narrowing the type they need; `commandRegistry: readonly CommandSpec[]`; `executeCommand`, `commandMenu`, `matchCommands` unchanged in name.
- Consumes: `Session` facade names from Task 1.

- [ ] Step 1: Read spec §5 and audit section C.
- [ ] Step 2: Types and registry.
- [ ] Step 3: Collapse the three trivial folders; leave `agents/`, `authentication/`, `checkpoints/`, `session/` split (external importers).
- [ ] Step 4: `Chat.tsx` edits. Add a test case in `tests/commands/command_register.test.ts` for a secret containing a space reaching `/login gpt api` intact (this is a bug fix the spec names).
- [ ] Step 5: Typecheck and full test run; green.

---

### Task 7: Final review, smoke run, docs

- [ ] Step 1: Dispatch a reviewer that reads the spec and checks each section against the tree: every deleted symbol is gone, no `X.ts` + `X/` pairs remain, no import cycles among `chat → providers → tools → chat`, no module-level mutable state outside the documented process-wide defaults, and the "add a model / tool / command / setting" recipes are each one place.
- [ ] Step 2: Typecheck and full test run with `FORCE_COLOR=1` and again without.
- [ ] Step 3: Headless smoke run of the TUI with `HOME` and `SIRUS_DATA_DIR` in scratch: launch, type `/help`, `/model`, escape, quit. Capture the frames.
- [ ] Step 4: Update `README.md` only if a user-visible command or flag changed (none expected). Write a short `docs/ARCHITECTURE.md` (one screen) describing the subsystems and their entry points.
