# Architecture

Sirus is a terminal client that runs AI coding agents. It does not run an agent loop of its
own: each participant is a Claude Code session or a Codex thread in a separate process,
reached over the Agent Client Protocol. The code is organised as a handful of subsystems,
each behind one small entry point. Read the entry point first; the files next to it are its
implementation.

| Subsystem | Entry point | What it owns |
| --- | --- | --- |
| Session | `src/agent_runtime/session/index.ts` | One conversation: participants, their transcripts, rounds, checkpoints, queue, draft, and the workers it owns. |
| Participant | `src/agent_runtime/agent.ts` | One agent in a session: its record, its credentials, and the runtime that answers for it. |
| Runtime | `src/agent_runtime/runtime/runtime.ts` | One ACP session, and the process that holds it and every session forked from it; the contract everything above is written against. |
| Providers | `src/agent_runtime/providers/index.ts` | Credentials only: which vendor, which key or subscription, in which order. |
| Routing | `src/agent_runtime/router.ts` | Which model a new session starts on, and which model and depth a worker runs on, when nobody has said. |
| Tools | `src/agent_runtime/tools/index.ts` | The tools only Sirus can offer, served to every runtime by one MCP server. |
| Permissions | `src/agent_runtime/permissions/policy.ts` | The three modes, and the queue for whatever a vendor escalates. |
| Persistence | `src/persistence/index.ts` | Settings and session snapshots on disk. Knows nothing about the runtime. |
| Memory | `src/memory/store.ts` | Long-term memories in SQLite with vector search. |
| Commands | `src/commands/registry.ts` | Slash commands the user types. |
| Frontend | `src/frontend/app.tsx` | The Ink UI, worker strip included. Consumes the facades above; owns no runtime logic. |

## Tracing one message

One user prompt, in the order a reader opens the files:

1. `frontend/chat/Chat.tsx`: `send()` builds the user entry and calls
   `session.sendMessage(draft)`.
2. `agent_runtime/session/index.ts`: `Session.sendMessage` reads the mentions through
   `ParticipantRoster`, stamps the entry with the session-wide sequence number and puts it
   in the transcript of every participant it addresses, and nothing else's. The pre-turn
   checkpoint is awaited before anything is prompted, because the runtimes run their tools
   themselves and cannot wait on a barrier. Then the round goes to `TurnRunner`.
3. `agent_runtime/session/turnRunner.ts`: the round loop. Every addressed participant runs
   in parallel; what each produced is delivered to the participants it mentioned, whole and
   attributed, and those run in the next round, until nobody is mentioned.
4. `agent_runtime/agent.ts`: `SessionAgent.respond` walks the vendor's credentials in order
   and starts a runtime on one. A new runtime is seeded with this participant's own record
   in its first prompt; a warm one is prompted with the turn's text alone. Everything the
   runtime reports is recorded into the assistant entry as it arrives.
5. `agent_runtime/runtime/runtime.ts`: `createRuntime` starts the vendor's adapter, or the
   scripted runtime the test suite bound to that model id.
6. `agent_runtime/runtime/acp.ts`: the ACP client. Spawn, `initialize` advertising
   compaction and nothing else, `session/new`, `session/set_mode`, one `session/prompt` per
   turn, `session/cancel` to stop one, `session/fork` for a worker that starts from its
   owner's conversation, and `_session/steering` to put text into a prompt in flight. One
   process can hold several sessions, so every update is routed by the session id it names.
   `runtime/launch.ts` holds the two launch specs: the command, the environment built from
   the credential, and `session()`, which every session opened on that process goes
   through.
7. The adapter process runs the model and the vendor's own file, shell, search and web
   tools. Its `session/update` notifications become transcript entries: text, thoughts,
   tool calls merged by id, the context gauge, a compaction boundary.
8. `agent_runtime/tools/server.ts`: a Sirus tool the model called arrives here over
   loopback HTTP, carrying the session's bearer token and the caller's name, so the call
   knows which session it belongs to and who issued it. The registry is `tools/index.ts`;
   delegation runs in `tools/subagents/`.
9. `agent_runtime/permissions/approvals.ts`: whatever the vendor escalates arrives as
   `session/request_permission`, is queued here, and `Chat.tsx` renders it and answers with
   one of the options the vendor offered.

## Session

`session/index.ts` holds the facade plus its input shapes, `SessionOptions`,
`SessionSnapshot` and `resolveSessionOptions`, which fills in every default. `Session` is a
facade over collaborators in the same folder, each constructible on its own:

- `Transcript`: one participant's record. Every entry directed to it, in arrival order: a
  user prompt that addressed it, another participant's message that mentioned it, its own
  responses. The same entry object sits in every transcript it was delivered to.
- `Timeline`: what sits above the transcripts. It hands out the session-wide sequence
  numbers, merges the transcripts into the one ordered view the UI and the snapshot read,
  keeps the activity clocks, and owns the identity of the assistant entries a round fills
  in.
- `ParticipantRoster`: the agents in the session and all `@name` routing. The mention
  grammar exists once, here.
- `TurnRunner`: the round loop, and the one place that decides what a participant is
  prompted with.
- `CheckpointLog`: directory snapshots taken before each turn, and the cross-session
  interlock that makes restoring one safe. Injectable `DirectoryActivity`; the default is
  process-wide.
- `MessageQueue`: prompts typed while a turn runs. `isAutoSendable` is the one rule for
  which of them drain on their own.
- `ChangeFeed`: listeners, version counters, and the 50 ms streaming throttle.

A checkpoint records the sequence number of the prompt that started its turn. Rewinding the
chat drops every participant's entries from that number on and rebuilds their runtimes, so
each one is reseeded from the record that is left. A rewind waits on the session's workers:
the chat on all of them, since it rebuilds the records they belong to, the files only on one
running in the project directory itself, since a worker in its own worktree changes nothing
there.

The session's workers are the subagents its participants spawned, and they are background
tasks: nothing waits on one. When a worker ends, `workerFinished` queues its report and
`flushReports` delivers it as soon as nothing else holds the session: no turn, rewind,
compaction or directory restore. `deliverReports` gives it to the agent that spawned it as a
message from the run, which starts that agent's turn the way a peer's message does, one turn
per owner however many of its workers ended; `sendNextQueuedPrompt` sends the reports before
it drains what the user queued. That entry is `hidden`: the runtimes read it in the record,
the chat shows no message for it, and the same text is set as the `output` of the SpawnAgent
call the run came from (`toolCallOf`), which is where the user reads it. The snapshot
carries a `WorkerRecord` per run, so a run still working when Sirus quits comes back
`interrupted`, a record with no agent behind it, and `appendRestoredReports` reads its
report into the owner's record at the start of the next prompt rather than starting a turn
on launch. Nothing restarts on its own. `getWorkers`, `cancelWorker`, `messageWorker` and
`dismissWorker` are what `/agents` and the worker strip call; `dispose` is asynchronous for
the workers' sake, since each one must be stopped and waited for before its worktree can be
removed.

Compaction belongs to the runtime. Each one folds its own conversation when its window
fills and reports it; `Session.compact` asks the default participant's runtime to do it now
by sending `/compact` as a prompt, which both vendors take as a slash command. What comes
back is a compaction block in that participant's record, rendered as a rule in the chat.
There is no automatic step of Sirus's own and nothing to switch off.

## Participants and runtimes

`agent.ts` is one agent in a session: its name and model, its transcript, the credential its
runtime is on, and its subagents. It asks `RuntimeHost` (implemented by `Session`) for
everything that belongs to the session rather than the participant: the system prompt, the
MCP server entry, the permission mode, and where an escalation goes.

A runtime is one ACP session; the process behind it holds the session it was started for and
every session forked from that one. `fork` opens such a session for a worker, in the
worker's directory and on its model, with its own mode, callbacks and MCP entry, so the
worker begins with the conversation its owner has had; `steer` puts text into the prompt a
session is running, which is how a worker is sent instructions mid-task. Disposing a fork
ends that session alone, and disposing the runtime it came from takes the process and the
fork with it. `runtime/runtime.ts` is the contract, the tool-call reduction every update
goes through, the mapping from Sirus's modes onto the vendor mode kinds, and
`boundRuntimes`, the seam the test suite binds scripted runtimes to so sessions run without
an agent process. `acp.ts` is the only code that speaks the wire protocol. `launch.ts` is
the per-vendor part: Claude through `@agentclientprotocol/claude-agent-acp` with an explicit
tool allowlist and the system prompt in `_meta`, Codex through
`@agentclientprotocol/codex-acp` with the prompt written to a file and named in
`CODEX_CONFIG`. `Launch.session` builds what one session carries, whether it is opened by
`session/new`, `session/fork` or `session/resume`, so the vendor's extras are written once
and each session names the participant it was opened for; `forkNeedsResume` says whether the
vendor's fork answers with a live session (Codex) or has to be reopened in the worker's
directory first (Claude). On both vendors a fork keeps the system prompt of the conversation
it was forked from, so the worker's own contract arrives in its first prompt instead
(`FORKED_WORKER_HANDOVER` in `prompt.ts`). Adding a vendor is a launch spec and a catalog
row.

Delegation is the participant's own: `spawnSubagent` settles the worker's model and thinking
level (the session's fixed subagent model, else the router's answer for that task), has
`worktree.ts` cut it a checkout, and returns as soon as the run is under way.
`createSubagent` builds the worker as a `SessionAgent` of its own under `host.forWorker(id,
directory)`, with the subagent contract and none of the delegation tools, and `forkFrom`
starts its first runtime as a fork of the owner's, falling back to a fresh runtime seeded
with the owner's record as text when there is nothing to fork or the vendor refuses.

Runtimes stay warm between turns. One is rebuilt when a credential fails, a model change
cannot be applied to the live session, the system prompt changes under it
(`invalidateAllRuntimes`), or the record it mirrors is rewound or cleared.

## Providers

Reduced to credentials: nothing here knows a wire protocol or runs a turn.

- `catalog.ts`: pure data. `MODELS` (id, vendor, and the profile the router reads) and
  `VENDOR_INFO` (display names, the API-key environment variable Sirus reads, the one the
  vendor's harness reads, the credentials a subscription child must not inherit, the profile
  directory variable, the allowance window). Consumers import model facts straight from
  here.
- `sources.ts`: a vendor's credentials, API keys and subscription profiles, in priority
  order, persisted through settings. The head of the list is the preferred one.
- `profiles.ts`: a credential as the environment an agent process gets.
  `sourceEnvironment` is the whole of it: an API key under the name the vendor's harness
  reads, or a subscription pointed at its own profile directory, with the vendor's other
  credentials scrubbed either way. Codex ignores a key in the environment while a ChatGPT
  login sits in its home, so a Codex API key also gets a home of its own under `api/`, and
  the launch logs the adapter in there with the key.
- `provider.ts`: one vendor composed from the above, plus which credential each runtime is
  on, which is the row the sidebar shows.
- `index.ts`: the registry. `providerFor`, `allProviders`, `servesModel`,
  `servableModelIds`, `onProviderChange`.
- `login.ts`, `usage.ts`, and the two account helpers: sign-in and allowance, which ACP
  carries nothing of. `anthropic/claude-account.ts` asks the Agent SDK for usage on a query
  that never receives a prompt, the one place that still imports it.
  `openai/codex-account.ts` runs `codex app-server` for one account request at a time over
  a small JSON-RPC client.

To add a model: one row in `MODELS`. To add a vendor: a `VENDOR_TABLE` row, a launch spec in
`runtime/launch.ts`, a row in `providers/index.ts`, the exhaustive `switch` statements in
`login.ts` and `usage.ts`, and the vendor enums in `persistence/settings.ts` and
`persistence/subscriptionLimits.ts`. Every one of those is a compile error until it is done,
so nothing fails silently.

## Routing

`router.ts` is the only code that talks to Jev, TypeSafe AI's System One model, through
`@typesafe-ai/sdk` on a key from `JEV_API` in the environment or, failing that, the one
`/jev` stored in the settings; `shouldRequestJevKey` is the one-time first-launch question
`app.tsx` asks through the chat's entry prompt. Two routers of one shape: a set of candidate
models, each judged on its catalog profile (what it is good at, published benchmark results
under the metric's own name, what users report of it, its list price) together with what its
vendor has left of its allowance, which is the one part the catalog cannot know; then a
typed `choice` question, answered in one call with a two-second timeout and no retries.
`routeSessionModel` picks a new session's model from the latest model of each vendor that
can still run, and `Session` awaits it on the first prompt of a draft started with
`routePending`. `routeWorker` picks a worker's model and thinking level, from every model
the catalog does not keep off the worker list, in one call with two questions.
`usableVendor` and `vendorAllowance` read the figures the sidebar has cached; a vendor
nobody has read yet counts as available rather than making a turn wait on a live read.
Anything short of a confident answer returns null and the caller keeps the model it had, so
nothing here can fail or hold up a turn. The `client` option is the seam: the suite passes a
`RoutingClient` of its own, and null stands for no key.

## Tools and permissions

The vendors run their own file, shell, search and web tools, so what is left in
`tools/index.ts` is what only Sirus can do: memory and delegation. A `Tool` is a plain
object: name, description, argument schema, optional `audience` and `requires`, and `run`.
Adding a tool is one entry in one family file.

`tools/server.ts` is the one MCP server inside the Sirus process, on loopback at an
ephemeral port. Every `session/new` lists it with a per-session bearer token and the
requester's name in the headers, so one server serves every participant of every session and
a call knows who made it. The tool list is computed per request, so `/memory on` and `off`
take effect on the next one. `agents.ts` holds the delegation tools, SpawnAgent,
CheckAgent, MessageAgent, CancelAgent and ListAgents, whose `audience` hides them from a
worker, so a subagent cannot spawn one. The runs themselves live in `tools/subagents/`:
`index.ts` (the `WorkerRecord` the snapshot keeps, and the process-wide index of runs the
chat, the strip, the notifications and the rewind interlock read), `run.ts` (lifecycle:
start, check, steer, cancel, and the report handed to the owner at the end), `report.ts`
(everything a run says about itself, to the model that asked and in that report),
`worktree.ts` (the worker's own checkout under the data directory, cut from the project's
HEAD onto `sirus/<id>`, removed with the session while its branch stays; a project that is
no repository gets none and the worker runs in place).

Permissions are the vendor's. `policy.ts` holds the vocabulary of the three modes;
`runtime/runtime.ts` maps each onto the vendor mode kind (`standard`, `auto_review`,
`full_access`) and picks the first vendor mode of that kind. In `ask` the vendor asks about
every action that is not a read, in `auto` its own reviewer escalates only what it judges
unsafe, in `bypass` nothing is asked. `approvals.ts` is the queue for what does get
escalated: the prompt renders from the ACP tool call and nothing else, and the answer is one
of the vendor's own options, so "allow for this session" is the vendor's allow-always and
Sirus keeps no allowance of its own. There is no `permissions/index.ts`: every import names
the file that defines the symbol.

## Persistence

`src/dataDirectory.ts` is a leaf. `persistence/settings.ts` exposes `openSettings()` with
typed `get`/`set` over one `SettingsShape`; the on-disk file keeps its shape and unknown keys
survive a write. A new setting is four entries in that one file (schema field, shape field,
default, codec) and a missing one is a compile error. `persistence/sessions.ts` reads and
writes plain `SessionSnapshot` values and normalises files written by older builds, tool
calls and compaction records included; `Session.fromSnapshot` is the only way a `Session` is
rebuilt. Nothing under `persistence/` imports runtime code except the zero-dependency type
module.

## Commands

A command is a `CommandSpec` with `run(args, context)` where `context` is
`{ session: CommandSession, signal, notify }` plus opt-in capabilities (`AttachesImages`,
`QuitsApp`). `CommandSession` is the structural subset of `Session` that commands use, so
the command layer never depends on the class. The registry array fixes the user-visible
order. See `src/commands/README.md` for the file-layout rule.

`/agents` is the user's side of the workers: `agents/behavior.ts` lists the session's runs,
shows one's record as a panel, cancels it, dismisses its line, or sends it a message. That
message is the one thing a menu cannot supply, so its entry carries `input`, which hands the
input bar over to its entry prompt and sends what the user types as the command's last
argument. The worker strip above the status row (`frontend/chat/WorkerStrip.tsx`) reads the
run index directly rather than waiting for the session to hand it an array, since runs are
mutated in place. It is one line: the run with the freshest `updatedAt` of those working or
finished within the last second, with a counter for the rest. `↓` from the input bar hands
it the keyboard against a list frozen as focus arrives, so nothing moves under the user, and
`enter` sends `/agents <id>` down the path typing it takes; the ordering is the strip's own,
while `/agents` keeps listing every run nobody has dismissed. In the history, `ChatMessage.tsx`
lets the SpawnAgent row follow the run it started, keeps it out of the `Ran N commands`
groups, and shows the report the session set as the call's output, open already once the run
has ended.

## Verification

```
bun run typecheck
HOME=<scratch> SIRUS_DATA_DIR=<scratch>/data bun test tests
```

Point `HOME` and `SIRUS_DATA_DIR` at a scratch directory; otherwise tests and smoke runs
read and write the real data directory.
