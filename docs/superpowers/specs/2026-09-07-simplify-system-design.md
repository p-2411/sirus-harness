# Simplify the system design

Date: 2026-09-07. Status: approved for implementation (autonomous run; the owner asked for the
refactor and set the criteria; design calls below are mine and are flagged where they matter).

## Goal

Every subsystem exposes a small, obvious interface. Complexity is hidden behind it. Adding a
model, a vendor, a tool, a command or a setting is a local change. The system meets SOLID:
single responsibility per unit, open for extension without editing shared code, substitutable
implementations behind one contract, narrow interfaces for each consumer, and high-level
modules that depend on abstractions rather than on module-level singletons.

Behaviour is preserved. The 373 existing tests stay green (they are edited only where they
reach into internals that no longer exist). No new test files are created unless a refactor
step has no coverage at all (called out per step). No commits are made; the owner reviews the
working tree.

Supporting audits, one per subsystem, are in `2026-09-07-simplify-audits/`. They list every
public symbol, its callers, the concrete problems with file:line, and the behaviours a refactor
must keep with the test that pins each one. Implementers read the audit for their phase.

## Subsystems and target shape

### 1. Session (the owner's named example)

Today `src/agent_runtime/session.ts` is one 952-line class with 17 responsibilities, a
14-positional-argument constructor, two module-level global maps, and a 110-line round loop
built on index-correlated parallel arrays.

Target: `src/agent_runtime/session/` with one facade and six collaborators.

```ts
// session/index.ts — the facade. ~200 lines. Every public name the UI and commands use today
// survives (see audit §2); removed: the positional constructor, Session.create, setModel,
// clearQueuedMessages, getDefaultParticipant, the legacy snapshot branch.
export class Session {
  constructor(options?: SessionOptions);
  static fromSnapshot(snapshot: SessionSnapshot): Session;
  sendMessage(message: Message): Promise<Message[]>;
  append(message: Message): void;                       // seed history without a turn
  cancel(): boolean; clear(): void;
  rewind(checkpointId: string, options: RewindOptions): Promise<RewindResult>;
  // getters/setters as today: id, name, directory, status, messages, participants, model,
  // thinking level, permission mode, input draft, queue, checkpoints, usage, timing, versions
  subscribe(listener: () => void): () => void;
  toSnapshot(): SessionSnapshot;
}

// session/options.ts
export interface SessionOptions {
  id?: string; name?: string; directory?: string;
  model?: string; defaultParticipant?: string; participants?: readonly Participant[];
  messages?: readonly Message[]; checkpoints?: readonly Checkpoint[];
  permissionMode?: PermissionMode; inputContent?: string; autoNamePending?: boolean;
  timing?: { updatedAt?: number; conversationStartedAt?: number; lastResponseFinishedAt?: number | null };
}
```

Collaborators (each independently constructible and testable, none importing the facade):

- `Transcript` — the message list plus every fact derived from it: activity clocks, the
  5-minute conversation-start rule, context/total usage folds, and `openRound(bubbles)`
  returning a `RoundHandle` (`publish`, `update`, `settle`, `discardIfEmpty`) that owns bubble
  identity. Replaces the parallel arrays and `indexOf`-splice in `runInvocations`.
  `history()` returns the live readonly array (the UI relies on identity plus the version
  counter; do not copy).
- `ParticipantRoster` — agents plus all `@name` routing. One private mention scanner used by
  both `routeUserMessage` (creates participants named with a model, strips the model span)
  and `routeAgentMessage` (existing participants only, speaker excluded). Name equality is
  `name.toLocaleLowerCase()` everywhere; `sameName` and the three copies of the grammar go.
- `TurnRunner` — the round loop. Knows coalescing, self-mention exclusion, the delegation
  prompt, cancel-ends-the-turn, and empty-bubble discard. Depends on Transcript, Roster, a
  toolbox factory, and two repaint hooks.
- `CheckpointLog` — this session's checkpoints plus the cross-session directory interlock,
  behind an injectable `DirectoryActivity` (default: one process-wide instance). Replaces the
  module globals `directoryTurns` and `restoringDirectories`, and is the one place that asks
  "is this directory busy" (turns, restores, subagents).
- `MessageQueue` — dumb FIFO with ids. The "pause at `/` commands" rule is one exported
  predicate `isAutoSendable(text)` shared by the facade and the UI.
- `ChangeFeed` — listeners, the two version counters, and the 50 ms streaming throttle.

Legacy on-disk session shape (`{model}` without participants) is normalised by persistence
(section 4), so `Session` accepts only the modern `SessionSnapshot`.

### 2. Providers / model integration

Today one object per vendor is simultaneously the model strategy, the credential store, the
auth UI backend and the fallback engine; the model map is a hand-written literal that throws
the model identity away; adding `gpt-6-astra` required four edits; `credentials.ts` is dead;
subscription transports import the tool registry, creating an import cycle through `chat.ts`.

Target layering in `src/agent_runtime/providers/`:

```ts
// catalog.ts — pure data. Adding a model is one row. Vendor is derived from the table.
export interface ModelInfo { id: string; vendor: Vendor; contextWindow: number; traits?: Record<string, unknown> }
export interface VendorInfo { id: Vendor; displayName: string; accountName: string; apiKeyEnv: string;
  judgeModel: string; scrubEnv: readonly string[]; profileDirEnv: string; limitPeriod: '5-hour' | '7-day' }
export const MODELS: readonly ModelInfo[]; export const VENDOR_INFO: Record<Vendor, VendorInfo>;
export function modelInfo(id): ModelInfo | undefined; export function isKnownModel(id): boolean;
export function modelIds(): string[]; export function modelsOf(vendor): string[];
export function contextWindowFor(id): number | undefined; export function judgeModelFor(id): string;

// transport.ts — one request path bound to one credential.
export interface Transport {
  // 'host': returns tool_use and the host runs tools via turn.toolbox and calls continue.
  // 'delegated': runs the host's tools itself through turn.toolbox and never returns tool_use.
  readonly toolExecution: 'host' | 'delegated';
  getResponse(messages: readonly Message[], turn: TurnContext): Promise<Response>;
  resetRuntime?(runtimeId: string): void; resetAllRuntimes?(): void; dispose?(): void;
}

// sources.ts — the single source of truth for a vendor's credentials.
export type Source = { id; kind: 'api'; key; fromEnv?: true } | { id; kind: 'subscription'; profile; label? };
export interface SourceStore { list(): Source[]; addApiKey(key): Source; addSubscription(profile, label?): Source;
  remove(id): boolean; promote(id): void }

// fallback.ts — runWithFallback(attempts, messages, turn, sticky): the policy from
// provider.ts:239-297 moved verbatim, including both continuation-rewrite strings.

// provider.ts — composes the above for one vendor.
export interface Provider {
  readonly vendor: VendorInfo;
  getResponse(messages, turn): Promise<Response>;
  readonly sources: SourceStore;
  activeSource(): Source | null;                 // what the sidebar shows
  login(notify, signal?): Promise<string>; subscriptionDetail(profile, signal?): Promise<string>;
  resetRuntime(runtimeId): void; resetAllRuntimes(): void; dispose(): void;
}

// registry.ts — providerFor(vendor), providerForModel(model), allProviders(),
// onProviderChange(listener), resetAllRuntimes(), disposeAll().
```

`modelStrategies` and `ModelStrategy` are deleted. Every site that indexed the map for
"is this a model" uses `isKnownModel`/`modelIds`; `chat.ts` calls `providerForModel`.
`frontend/index.tsx` calls `disposeAll()` instead of the Codex-specific shutdown. The
`subscriptions` boolean and `apiKeys` blob stay in the settings schema as optional, read only
by the one-time legacy migration inside `SourceStore`, and are no longer written.

### 3. Tools, permissions, subagents

Today the tool signature is positional, the runtime special-cases tool families by name-set,
audience is enforced on listing but not on execution (a subagent can spawn a grandchild),
the checkpoint barrier rides inside the permission context, `permissions.ts` is 637 lines of
six concerns with unbounded global caches, and each tool family is split across `X.ts` and
`X/tools.ts` for no benefit.

Target:

```ts
// tools/types.ts — depends on nothing above the tool layer.
export interface ToolContext { directory: string; signal?: AbortSignal; callId: string; subagents?: SubagentHost }
export interface Tool<A = Record<string, unknown>> {
  name: string; description: string; args: Record<string, ToolArgumentSchema>;
  effect: 'read' | 'mutates' | ((args: A, directory: string) => 'read' | 'mutates');
  audience?: { subagent?: boolean };   // default visible to all
  requires?: 'memory';
  run(args: A, ctx: ToolContext): Promise<unknown>;
}

// tools/toolbox.ts — what a turn hands its transport.
export interface Toolbox {
  readonly tools: readonly Tool[];                       // visible to this turn's audience
  run(call: ToolCallBlock): Promise<ToolResultBlock>;    // barrier → gate → execute → format
}
export function createToolbox(options: {
  tools?: readonly Tool[]; audience?: { subagent?: boolean }; directory: string;
  memoryEnabled?: () => boolean; permissions?: PermissionContext;
  beforeMutation?: () => Promise<void>; subagents?: SubagentHost;
}): Toolbox;
```

`TurnContext.tools: boolean` and `TurnContext.permissions` become `TurnContext.toolbox:
Toolbox | null`. Transports read `turn.toolbox.tools` and call `turn.toolbox.run(call)`;
they no longer import the registry or the gate, which breaks the import cycle. Session builds
the toolbox per turn (this replaces `permissionContextFor`); the subagent runner builds one
for each worker with `audience: { subagent: true }`; the judge passes `null`.

`RunShell` declares `effect: 'mutates'`, which is what the `toolCall.name === 'RunShell'`
special case always meant. Classification for the gate comes from `Tool.effect` plus the
shell parser; the hand-kept `READ_TOOLS` list goes.

`permissions/` splits into `classify.ts` (the shell parser and tables, moved verbatim),
`approvals.ts` (the pending-prompt store the UI subscribes to, same exported names),
`policy.ts` (`authorizeToolCall` for the four modes, using the judge), `describe.ts` (UI copy),
`judge.ts` (unchanged). `PermissionContext` loses `beforeMutation`. Dead exports go.

Each tool family is one file: `tools/files.ts`, `shell.ts`, `search.ts`, `memories.ts`,
`agents.ts`. `tools/subagents.ts` splits into `subagents/run.ts` (lifecycle),
`subagents/registry.ts` (the observable index the UI and rewind query, with the same exported
names), `subagents/report.ts` (model-facing formatting). `SubagentRun` records `sessionId`
directly instead of reaching into a permission context.

### 4. Persistence and settings

Today `persistence.ts` imports the `Session` class (storage depends on domain, and the domain
depends back on storage), re-implements the legacy session migration that `Session` also
had, exposes 8 load/save pairs, and hand-enumerates every settings section on each write.

Target `src/persistence/`:

- `src/dataDirectory.ts` — leaf module; nine consumers stop depending on persistence.
- `atomicJson.ts` — `readJson`/`writeJson` unchanged.
- `settings.ts` — `openSettings(directory?)` returning `{ get(key), set(changes) }` over a
  typed `SettingsShape`. Read-through (no cache), so `SIRUS_DATA_DIR` tests keep working.
  Unknown keys survive a write. Adding a setting is one schema line plus one default.
- `sessions.ts` — `loadSessionSnapshots(directory?, fallbackDirectory?)` and
  `saveSessionSnapshots(snapshots, selectedId, directory?)`. Works on plain
  `SessionSnapshot` values (type-only import). Legacy shapes are normalised here. The
  "empty sessions are not persisted" rule lives in the one caller (`app.tsx`) that has the
  `Session` objects.
- `subscriptionLimits.ts` — the cache, with an injectable directory.
- `index.ts` — re-exports, so `'../persistence'` keeps resolving.

### 5. Commands

Today every command receives a five-field bag with two closures most never use and the
concrete `Session` class; the frontend bypasses the registry for shift+tab; three trivial
`behavior.ts` files exist only to follow a convention two folders ignore; a secret containing
a space is split by the string re-entry path.

Target: `CommandContext { session: CommandSession; signal; notify }` where `CommandSession`
is a structural interface of the ~15 Session methods commands use; `AttachesImages` and
`QuitsApp` as opt-in capability interfaces for the two commands that need them;
`commandRegistry` is `readonly`; shift+tab sends `/permissions <mode>` through the normal
path; menu items that collect a secret are executed with `[...args, value]` rather than
re-parsed from a string; `memory/`, `notifications/`, `update/` collapse to one file each; the
rule is written down: a folder has `behavior.ts` only when something outside the folder
imports it.

### 6. Memory

Today the 631-line store mixes connection setup, a 109-line schema migration, the vector
index and CRUD; `graph.ts` and `listMemories` are dead; the singleton captures the data
directory at first use.

Target: `memory/schema.ts` (migration moved verbatim), `memory/vectorIndex.ts` (index +
reindex), `memory/store.ts` with a five-method port (`save`, `get`, `delete`, `search`,
`close`) over a `MemoryTarget { scope, directory }` value object, and `memoryStoreFor(dir)` /
`closeAllMemoryStores()` replacing the singleton. Tool-side argument validators that the
store repeats are removed.

### 7. Frontend

Not a refactor target. It changes only where the runtime surface it consumed no longer
exists: `modelStrategies` → catalog; `shutdownCodexRuntime` → `disposeAll`; `loadSessions`/
`saveSessions` → snapshot repository plus the empty-session filter; `permissionsCommand` import
→ `send('/permissions …')`; `Session.create` → `new Session({...})`. The stale commented
import of `../../state` in `Chat.tsx` is deleted.

### 8. Dead code removed outright

`config.ts` (root), `src/agent_runtime/providers/credentials.ts`, `src/memory/graph.ts`,
`MemoryStore.listMemories`, `LegacySessionSnapshot` and the legacy `fromSnapshot` branch,
`Provider.authStatus`, `Provider.setSource`, the profile-less `subscriptionTransport`
aggregates, `sessionAllowances`/`clearSessionAllowances`/`judgeVerdictFor`/`isAwaitingJudge`,
the `loginMenuItems` re-export from the registry, `debug.log`, and the vacuous `changed` flag
in the round loop.

## Decisions the audits left open

- Legacy session normalisation is owned by persistence, not `Session` (a file-format
  concern). `Session.fromSnapshot` accepts only the modern shape.
- Transports keep the `getResponse(messages, turn)` shape rather than a new `TurnRequest`
  type. The gain from a new request type does not justify touching all four transports twice.
  The one contract change is `turn.toolbox`.
- `sendMessage` keeps its return type. The UI's acceptance check by message count stays.
- Subagent runs are still retained for the process lifetime (the UI colours finished rows);
  bounding that is a product decision, not this refactor.
- No new tests except: one for the empty-failed-bubble discard (untested today, touched by
  the round-loop rewrite) and characterisation tests for the shell classifier before it moves.

## Verification

After every phase: `bun run typecheck` and `HOME=<scratch> SIRUS_DATA_DIR=<scratch>
FORCE_COLOR=1 bun test tests` both green. Final: a headless smoke run of the TUI with a
scratch `HOME`.
