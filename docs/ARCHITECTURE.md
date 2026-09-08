# Architecture

Sirus is a terminal client that runs AI coding agents. The code is organised as a handful of
subsystems, each behind one small entry point. Read the entry point first; the files next to it
are its implementation.

| Subsystem | Entry point | What it owns |
| --- | --- | --- |
| Session | `src/agent_runtime/session/index.ts` | One conversation: history, participants, turns, checkpoints, queue, draft. |
| Turn loop | `src/agent_runtime/chat.ts`, `turn.ts`, `agent.ts` | Running one agent turn: provider requests alternating with tool calls. |
| Providers | `src/agent_runtime/providers/index.ts` | Which vendor serves a model, with which credential, with what fallback. |
| Tools | `src/agent_runtime/tools/index.ts` | The tools a model may call and the toolbox a turn hands its transport. |
| Permissions | `src/agent_runtime/permissions/policy.ts` | Whether a tool call may run: classification, prompts, the judge. |
| Persistence | `src/persistence/index.ts` | Settings and session snapshots on disk. Knows nothing about the runtime. |
| Memory | `src/memory/store.ts` | Long-term memories in SQLite with vector search. |
| Commands | `src/commands/registry.ts` | Slash commands the user types. |
| Frontend | `src/frontend/app.tsx` | The Ink UI. Consumes the facades above; owns no runtime logic. |

## Tracing one message

One user prompt, in the order a reader opens the files:

1. `frontend/chat/Chat.tsx` — `send()` builds the user `Message` and calls
   `session.sendMessage(msg)`.
2. `agent_runtime/session/index.ts` — `Session.sendMessage` routes the mentions through
   `ParticipantRoster`, appends to `Transcript`, takes the pre-turn checkpoint, and hands the
   round, with a `toolboxFor` factory, to `TurnRunner`, which builds one `Toolbox` per
   participant.
3. `agent_runtime/session/turnRunner.ts` — the round loop; for each mentioned agent it calls
   `participant.respond(history, …)`.
4. `agent_runtime/agent.ts` — `SessionAgent.respond` opens a `TurnContext`
   (`agent_runtime/turn.ts`) and calls `getResponse`.
5. `agent_runtime/chat.ts` — `getResponse` asks `providerForModel(agent.model)` and loops:
   one provider response, then any tool calls it returned.
6. `agent_runtime/providers/index.ts` — `providerForModel` picks the vendor's `Provider`.
7. `agent_runtime/providers/provider.ts` → `fallback.ts` → `providers/<vendor>/api.ts` — the
   credential list in source order, then the one transport that speaks the wire protocol.
8. `agent_runtime/tools/toolbox.ts` — `turn.toolbox.run(call)`: checkpoint barrier, then the
   gate, then the tool's own `run` from its family file (`tools/files.ts`, `shell.ts`, …).
9. `agent_runtime/permissions/policy.ts` — `authorizeToolCall` classifies the call
   (`classify.ts`), consults `judge.ts` when unsure, and queues a prompt in `approvals.ts`
   that `Chat.tsx` renders and resolves.

## Session

`session/index.ts` holds the facade plus its input shapes — `SessionOptions`, `SessionSnapshot`
and `resolveSessionOptions`, which fills in every default. `Session` is a facade over six
collaborators in the same folder, each constructible on its own:

- `Transcript` — the message list and every fact derived from it (activity clocks, the
  five-minute conversation-start rule, token usage). `openRound()` reserves the assistant
  bubbles for one round and returns a handle that fills or discards them.
- `ParticipantRoster` — the agents in the session and all `@name` routing. The mention
  grammar exists once, here.
- `TurnRunner` — the round loop: run every mentioned agent in parallel, then any agents they
  mentioned, until nobody is mentioned. Cancellation ends the turn.
- `CheckpointLog` — directory snapshots taken before each turn, and the cross-session
  interlock that makes restoring one safe. Injectable `DirectoryActivity`; the default is
  process-wide.
- `MessageQueue` — prompts typed while a turn runs. `isAutoSendable` is the one rule for
  which of them drain on their own.
- `ChangeFeed` — listeners, version counters, and the 50 ms streaming throttle.

Every turn gets a `Toolbox` built by the session from the tool registry, the permission
context, the checkpoint barrier, and a `SubagentHost` bound to the acting agent.

## Providers

Layered so that adding a model is one row and adding a vendor is one folder plus a few
compile-checked rows:

- `catalog.ts` — pure data. `MODELS` (id, vendor, context window, traits) and `VENDOR_INFO`
  (display names, API-key env var, judge model, profile directory, allowance window).
  Consumers import model facts straight from here.
- `sources.ts` — a vendor's credentials: API keys and subscription profiles, in priority
  order, persisted through settings.
- `fallback.ts` — try sources in order, stay sticky per agent runtime, never replay a tool
  whose outcome is unknown.
- `provider.ts` — the `Transport`/`Response` contract and the composition of one vendor from
  the above. `toolExecution` says whether the host runs tools (`'host'`, the direct APIs) or
  the transport runs them itself (`'delegated'`, the subscription runtimes).
- `index.ts` — the registry itself: `providerForModel`, `providerFor`, `allProviders`,
  `servesModel`, `boundTransports`, `onProviderChange`, `resetAllRuntimes`, `disposeAll`.
- `login.ts`, `usage.ts`, `profiles.ts`, `subscription.ts` — auth flows, allowance reads, and
  the per-vendor profile directory. Imported directly by the frontend and the commands.

To add a model: one row in `MODELS` (a Claude model on the legacy thinking API also needs
the regex in `providers/anthropic/api.ts`). To add a vendor: a `VENDOR_TABLE` row, a
transport or two under `providers/<vendor>/`, a row in `providers/index.ts`, the three exhaustive
`switch` statements in `login.ts` and `usage.ts`, and the vendor enums in
`persistence/settings.ts` and `persistence/subscriptionLimits.ts`. Every one of those is a
compile error until it is done, so nothing fails silently.

## Tools and permissions

A `Tool` is a plain object: name, description, argument schema, `effect` (`'read'` or
`'mutates'`, or a function of the arguments), optional `audience` and `requires`, and `run`.
The registry is an ordered array in `tools/index.ts`. A tool only needs edits elsewhere
when it wants custom approval copy (`permissions/describe.ts`) or a custom "allow for this
session" key (`permissions/classify.ts`). `createToolbox` (in `tools/toolbox.ts`, imported from there
directly because the toolbox reads the registry in `tools/index.ts`) filters by audience
and settings, waits for the checkpoint barrier before a mutating call, asks the permission
policy, executes, and formats the result. Transports only ever see `turn.toolbox`.

Permissions split into `classify.ts` (the shell-command parser and its policy tables),
`approvals.ts` (the prompt queue the UI subscribes to, and `isAwaitingApproval`), `policy.ts`
(the gate for the `ask`/`auto`/`bypass` modes, the mode vocabulary and `PermissionContext`),
`describe.ts` (UI copy), and `judge.ts` (a cheap same-vendor model asked to classify unusual
shell commands). There is no `permissions/index.ts`: every import names the file that defines
the symbol, so `'…/permissions'` does not resolve.

Subagents live in `tools/subagents/`: `index.ts` (the observable index of runs the UI and
rewind query), `run.ts` (lifecycle, including the temporary transcript file a run streams to),
`report.ts` (what the parent model is told). `run.ts` reads the index, so the lifecycle calls
are imported from `subagents/run` rather than re-exported by `subagents/index`.

## Persistence

`src/dataDirectory.ts` is a leaf. `persistence/settings.ts` exposes `openSettings()` with
typed `get`/`set` over one `SettingsShape`; the on-disk file keeps its shape and unknown keys
survive a write. A new setting is four entries in that one file (schema field, shape field,
default, codec) and a missing one is a compile error. `persistence/sessions.ts` reads and writes plain `SessionSnapshot` values
and normalises legacy files; `Session.fromSnapshot` is the only way a `Session` is rebuilt.
Nothing under `persistence/` imports runtime code except the zero-dependency type module.

## Commands

A command is a `CommandSpec` with `run(args, context)` where `context` is
`{ session: CommandSession, signal, notify }` plus opt-in capabilities (`AttachesImages`,
`QuitsApp`). `CommandSession` is the structural subset of `Session` that commands use, so
the command layer never depends on the class. The registry array fixes the user-visible
order. See `src/commands/README.md` for the file-layout rule.

## Verification

```
bun run typecheck
HOME=<scratch> SIRUS_DATA_DIR=<scratch>/data bun test tests
```

Point `HOME` and `SIRUS_DATA_DIR` at a scratch directory; otherwise tests and smoke runs
read and write the real data directory.
