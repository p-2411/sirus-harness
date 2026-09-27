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
   in the transcript of every participant it addresses, and nothing else's. The entry keeps
   the prompt as typed; the model that introduced a participant is marked
   (`creationModels`) and everything a runtime reads goes without it
   (`withoutCreationModels`). The pre-turn
   checkpoint is awaited before anything is prompted, because the runtimes run their tools
   themselves and cannot wait on a barrier. Then the round goes to `TurnRunner`.
3. `agent_runtime/session/turnRunner.ts`: the round loop. Every addressed participant runs
   in parallel; what each produced is delivered to the participants it mentioned, whole and
   attributed, and those run in the next round, until nobody is mentioned.
4. `agent_runtime/agent.ts`: `SessionAgent.respond` walks the vendor's credentials in order
   and starts a runtime on one. A new runtime is seeded with this participant's own record
   in its first prompt; a warm or natively resumed one gets the turn's text alone. Everything the
   runtime reports is recorded into the assistant entry as it arrives.
5. `agent_runtime/runtime/runtime.ts`: `createRuntime` starts the vendor's adapter, or the
   scripted runtime the test suite bound to that model id.
6. `agent_runtime/runtime/acp.ts`: the ACP client. Spawn, `initialize` advertising
   compaction and form elicitation and nothing else, `session/new` (or `session/resume` for a saved vendor session), `session/set_mode`, one `session/prompt` per
   turn, `session/cancel` to stop one, `session/fork` for a worker that starts from its
   owner's conversation, and `_session/steering` to put text into a prompt in flight. One
   process can hold several sessions, so every update is routed by the session id it names.
   `runtime/launch.ts` holds the two launch specs: the command, the environment built from
   the credential, and `session()`, which every session opened on that process goes
   through.
7. The adapter process runs the model and the vendor's own file, shell, search and web
   tools. Its `session/update` notifications become transcript entries: text (a new block
   for each message), timed thoughts, tool calls merged by id, the context gauge, a
   compaction boundary, and once the turn ends what it used (`TurnUsage`: the prompt
   response's tally from Claude; from Codex, whose response covers its last model call
   only, the sum of the turn's usage updates when it made several). A call the user declined at the approval prompt is marked so in `acp.ts`
   (`outcome`), since both vendors report it only as failed.
8. `agent_runtime/tools/server.ts`: a Sirus tool the model called arrives here over
   loopback HTTP, carrying the session's bearer token and the caller's name, so the call
   knows which session it belongs to and who issued it. The registry is `tools/index.ts`;
   delegation runs in `tools/subagents/`.
9. `agent_runtime/permissions/approvals.ts`: whatever the vendor escalates arrives as
   `session/request_permission`, is queued here, and `Chat.tsx` renders it and answers with
   one of the options the vendor offered. A question the agent asks arrives as
   `elicitation/create` and is queued in `permissions/questions.ts` the same way.

## Session

`session/index.ts` holds the facade plus its input shapes, `SessionOptions`,
`SessionSnapshot` and `resolveSessionOptions`, which fills in every default. `Session` is a
facade over collaborators in the same folder, each constructible on its own:

- `Transcript`: one participant's record. Every entry directed to it, in arrival order: a
  user prompt that addressed it, another participant's message that mentioned it, its own
  responses. The same entry object sits in every transcript it was delivered to.
- `Timeline`: what sits above the transcripts. It hands out the session-wide sequence
  numbers, a reply's when its first output arrives, so replies running in parallel stand
  in the order they began; merges the transcripts into the one ordered view the UI and the snapshot read,
  keeps the activity clocks, and owns the identity of the assistant entries a round fills
  in.
- `ParticipantRoster`: the agents in the session and all `@name` routing. The mention
  grammar exists once, here.
- `TurnRunner`: the round loop, and the one place that decides what a participant is
  prompted with, including who a user prompt added to the session
  (`withIntroductions`), since the runtimes read the prompt without the model that created
  them.
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
tasks: nothing waits on one. A foreground spawn is the exception, whose SpawnAgent call waits
for the report (`awaitForeground`); when that wait ends first, because the owner's turn was
cancelled or it reached `TOOL_WAIT_LIMIT_MS`, a little inside the five minutes after which
both vendors give up on a tool call, the run becomes a background one. When a worker ends, `workerFinished` queues its report and
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
on launch. Nothing restarts on its own. A later SendMessage reopens the worker’s saved vendor
session, including an owner-context fork, before giving it the new message. `getWorkers`, `cancelWorker`, `messageWorker` and
`dismissWorker` are what `/agents` and the worker strip call; `dispose` is asynchronous for
the workers' sake, since each one must be stopped and waited for before its worktree can be
removed.

Compaction belongs to the runtime. Each one folds its own conversation when its window
fills and reports it; `Session.compact` asks a participant's runtime (the selected one's
unless named) to do it now by sending `/compact` as a prompt, which both vendors take as a
slash command, with whatever the user wants the summary to keep after it: Claude Code reads
those as instructions, Codex compacts without any and the command says so. What comes back
is a compaction block in that participant's record, rendered as a rule in the chat. There is
no automatic step of Sirus's own and nothing to switch off.

The status row shows the selected agent's context gauge, model and thinking level, the tab
the chat is on. The gauge warns from `CONTEXT_LOW_PERCENT` on, and a window smaller than one
already seen for the model is taken for the adapter's placeholder. What each turn used is kept on the assistant entry it
wrote (`Message.usage`), which its footer shows; a participant's total, which `/status` and
`/usage` show, is the sum over its entries (`getTurnUsage`), a figure of the breakdown only
when every turn reported one.

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

Skills are the vendors' own, and `runtime/skills.ts` only makes sure each one can see the
user's and the project's. Claude has `Skill` on its allowlist, but its empty
`settingSources` also keep its skill folders and enabled plugins out, so each session is
handed them through the SDK's `plugins` option (`claudeSkillOptions`). Two local plugins,
`user` and `project`, are written under the launch's folder: symlinks to the skills in
`.claude/skills` and `.agents/skills` and the commands in `.claude/commands`, in the user's
home and in the session's directory up to the git root. The plugins the user installed and
enabled in Claude Code (`plugins/installed_plugins.json` and `enabledPlugins` in the user's,
the project's and the local settings) go in by path, whole: skills, commands, MCP servers and
hooks. `SessionSpec.directory` is there so a forked worker gets the project plugin of its own
worktree. The bundled skills that need tools Sirus leaves off, or act on Claude Code's own
settings, are switched off by name through `settings.skillOverrides`. Codex finds `.agents` and
`.codex` skills on its own; when a credential points `CODEX_HOME` at a profile, the user's
`~/.codex/skills` are linked into it one by one.

The vendors' own commands, skills included, are what each runtime reports in
`available_commands_update` (`runtime/commands.ts`); the last list per vendor and directory
is kept on disk. The `/` menu shows those of every vendor a participant runs on after Sirus's
commands, tagged "(claude)" or "(codex)", the selected agent's vendor first; one whose
name a Sirus command or an earlier vendor already has is listed and reached with the
vendor's prefix, `/claude:agents` or `/codex:status` (`vendorCommandNames`). `Chat.send`
sends such a line as a prompt to the selected agent when it is on that vendor, else to one
that is (`participantOn`), and `TurnRunner` puts it in
that vendor's words (`nativePrompt`): the prefix goes, and a Codex skill reads `$name`. A
command that only reports and takes no arguments (`isReportingCommand`: Claude's `/context`,
Codex's `/status`) is not sent at all: `SessionAgent.runAside` runs it on a throwaway fork of
the participant's runtime, or on a fresh runtime while the vendor holds no conversation yet,
and the chat shows what it printed as a panel, so it leaves no turn, no checkpoint and nothing
in any record. Sirus's own `/init` and `/review` go the prompt way too: the chat shows
`/init`, and `nativePrompt` hands the participant Sirus's prompt for it, except that Codex's
`/review` stays Codex's. Claude reads a slash command only from the prompt's last text
block, so a cold runtime seeded with its record gets that record as a block of its own
ahead of the command (`PromptInput.context`), and every prompt sends its images before its
text.

Delegation is the participant's own: `spawnSubagent` settles the worker's model and thinking
level (the session's fixed subagent model, else the router's answer for that task), has
`worktree.ts` cut it a checkout, and returns as soon as the run is under way.
`createSubagent` builds the worker as a `SessionAgent` of its own under `host.forWorker(id,
directory)`, with the subagent contract and none of the delegation tools, and `forkFrom`
starts its first runtime as a fork of the owner's, falling back to a fresh runtime seeded
with the owner's record as text when there is nothing to fork or the vendor refuses.

Runtimes stay warm between turns. Each participant and worker snapshot carries a
`nativeSession`: vendor, vendor session id, original session directory, credential source
id, profile home and a hash of Sirus's system prompt. After restart or process loss,
including a stuck cancel or the automatic crash retry, the next turn reopens that session.
The saved credential is tried first. A fallback credential can reuse the session when it
uses the same profile home; a different home starts fresh. Claude looks up its transcript
in the original directory; Codex resumes its thread log. `acp.ts` prefers `session/resume`
and uses `session/load` only when resume is not advertised, suppressing replayed transcript
updates while preserving live session configuration and recovered background tasks.

A rewind, clear, incompatible model switch or system-prompt change discards the native
handle and starts fresh with the bounded text recap. Prompt hashes catch changes across
app restarts too. Missing sessions, directories, credentials or profile homes, and vendor
resume refusals, produce a brief notice and use the same recap fallback. A cancelled
startup keeps an existing handle for the next attempt. A turn that is cancelled or fails
marks the tool calls it left open as failed, since nothing more will be heard of them; a
cancelled one marks them cancelled, and leaves an `Interrupted` notice where it stopped,
which a recap passes on. A snapshot restores an open call as cancelled.

A participant keeps the time its runtime last reported anything (`quietFor`), not counting
time spent waiting on the user's approval or inside a tool call that is still running. After
a minute of silence the turn status line says so. A worker, which nobody is watching, is stopped after 15 minutes of it, and its
report says why.

## Providers

Reduced to credentials: nothing here knows a wire protocol or runs a turn.

- `catalog.ts`: pure data. `MODELS` (id, vendor, and the profile the router reads) and
  `VENDOR_INFO` (the one name the user reads and types for each vendor, Claude and Codex,
  over a stored key that stays `claude` and `gpt`; the API-key environment variable Sirus
  reads, the one the vendor's harness reads, the credentials a subscription child must not
  inherit, the profile directory variable, the allowance window). Consumers import model
  facts straight from here, including what the vendors listed and what a runtime showed
  about its model: the efforts it offers, which `/thinking` offers, and the largest window
  it reported, which keeps the gauge from reading a placeholder.
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

## Tools and permissions

The vendors run their own file, shell, search and web tools, so what is left in
`tools/index.ts` is what only Sirus can do: memory and delegation. A `Tool` is a plain
object: name, description, argument schema, optional `audience` and `requires`, `label`
(how a call reads in the chat and on an approval prompt, since the vendors know it only by
its MCP name) and `run`.
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
Sirus keeps no allowance of its own. What the user decided stays on the call itself: the
ACP client marks one they declined, and the transcript keeps saying so after a restart. There is no `permissions/index.ts`: every import names
the file that defines the symbol.

Questions are the vendors' too: Claude's AskUserQuestion (on the allowlist) and Codex's
request_user_input (on in every mode through `default_mode_request_user_input`), and any
form an MCP server raises through either. Both adapters send them as ACP form elicitations,
which Sirus advertises; codex-acp still sends tool approvals as permission requests.
`questions.ts` reads the form into fields, folding each question's free-text field (marked
in its `_meta` by either adapter) into it as "Other", queues it per session behind the
approvals, and answers with the form's content. A subagent's question is declined at once.
`frontend/chat/QuestionCard.tsx` asks it one field at a time in the same `FramedCard` the
approval prompt uses; time spent waiting on either is not silence to the watchdog.

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
`QuitsApp`, `sendPrompt` for one that talks to the agents, as `/init` does). `CommandSession` is the structural subset of `Session` that commands use, so
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
while `/agents` keeps listing every run nobody has dismissed. A worker goes by the name its owner gave it (`workerName`), or its id when it has none, in
all of these and on its approval prompts. In the history, `ChatMessage.tsx` lets the
SpawnAgent row follow the run it started and keeps it out of the groups of ordinary calls. The
row is laid out like Claude Code's Agent row: the worker and its task, then how the run stands
(`runSummary`, "Done (3 tool uses · 24k tokens · 16s)"), then the report the session set as
the call's output, whole and as Markdown, open already once the run has ended. A spawn that
started no worker shows the tool's error instead. How every other call reads is
`frontend/chat/toolCalls.ts`: its line (the kind's verb unless the vendor's title has one,
Sirus's own tools by their `label`), the change it made as a numbered line diff, why it
failed, and a group of calls summed up by kind ("Read 2 files, edited 1 file").

## Verification

```
bun run typecheck
HOME=<scratch> SIRUS_DATA_DIR=<scratch>/data bun test tests
```

Point `HOME` and `SIRUS_DATA_DIR` at a scratch directory; otherwise tests and smoke runs
read and write the real data directory.
