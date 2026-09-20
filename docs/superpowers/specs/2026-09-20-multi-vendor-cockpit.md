# Sirus as a multi-vendor cockpit over Claude Code and Codex

Status: draft for approval. Scope: the migration only, delivered as one PR on
one branch. The subagent work that follows it (fork, worktree isolation,
mid-run messages to a worker, persisted worker runs, in that order) is out of
scope here and starts once the migration lands.

## Goal

Stop running our own agent loop. Each participant becomes a Claude Code
session or a Codex thread, running the vendor's own tools, prompt caching, and
compaction, reached through one protocol. Sirus keeps what makes it Sirus:
several participants of different vendors in one place, addressed by `@name`;
one standardised cross-vendor subagent tool; one permission UI; checkpoints
and rewind; memory; sessions saved to disk.

## Decisions

1. **ACP is the provider abstraction.** Sirus becomes an Agent Client
   Protocol client (`@agentclientprotocol/sdk`). A participant runtime is one
   agent process on stdio and one ACP session inside it: Claude through
   `@agentclientprotocol/claude-agent-acp` (the Agent SDK underneath, as
   today), Codex through `@agentclientprotocol/codex-acp` (the app-server
   underneath, as today). A vendor is a launch spec: the command, the
   environment built from a credential, and the vendor's `session/new`
   extras. Everything above the launch spec is written once against ACP's
   shapes: recording the transcript, rendering tool calls and diffs, the
   permission gate, the context gauge, compaction, model selection. Adding a
   vendor is a launch spec and a catalog entry. "Why ACP" below lists what
   was verified.
2. **One harness per vendor, for every credential.** A credential is the
   environment of the agent process: `ANTHROPIC_API_KEY` or a profile's
   `CLAUDE_CONFIG_DIR` for Claude, `OPENAI_API_KEY` or a profile's
   `CODEX_HOME` for Codex, built by `subscriptionEnvironment` as today. The
   direct API transports and the host tool loop are deleted. A vendor is one
   launch spec, one credential list, one fallback order; falling back to the
   next credential starts a new process.
3. **Per-participant transcripts.** A message enters a participant's
   transcript only if it was directed to that participant: a user prompt that
   mentions it, an unmentioned prompt for the default participant, or another
   participant's response that mentions it. There is no shared history and no
   replay of "new shared messages". If `@sirus` wants `@reviewer` to know
   something, it says so in the message that mentions `@reviewer`.
4. **Native built-in tools on; nothing pulls execution back into Sirus.**
   Sirus advertises no `fs`, `terminal`, `elicitation`, `plan` or
   `subagents` client capability, so the agents run their tools themselves on
   disk and Sirus only renders what the tool call updates carry. Claude's
   tool list is an explicit allowlist in `_meta.claudeCode.options.tools`:
   Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch. Task, Agent,
   AskUserQuestion, TodoWrite, NotebookEdit and ExitPlanMode are not on it, so
   native subagents stay off. Codex runs its shell, `apply_patch` and web
   search; it has no native subagent tool on by default. Adding a tool later
   is an allowlist entry (AskUserQuestion also needs `elicitation.form`
   advertised and a form rendered).
5. **Sirus tools over MCP, on loopback HTTP.** `SpawnAgent`, `CheckAgent`,
   `CancelAgent` and the memory tools move from the in-process SDK server and
   Codex dynamic tools to one streamable HTTP MCP server inside the Sirus
   process (`@modelcontextprotocol/sdk`, already a dependency), bound to
   127.0.0.1 on an ephemeral port. Each `session/new` lists it with two
   headers, a per-session bearer token and the participant name, so a tool
   call knows who issued it. One server serves both vendors; both adapters
   accept the `http` transport. ACP's own MCP-over-ACP transport is unstable
   and neither adapter supports it.
6. **Delegation stays the standardised Sirus tool** on every vendor, with the
   subagent model a session setting rather than the model's free choice.
7. **Native compaction.** Each runtime compacts its own conversation and
   reports it as `compaction_update`, which Sirus receives by advertising
   `session.compaction`. `/compact` in Sirus sends `/compact` as the prompt;
   both adapters list it as a slash command. The transcript-level compaction
   added on 2026-09-20 goes away with the shared transcript.
8. **Sirus's permission gate answers `session/request_permission`.** The
   request carries the tool call (kind, title, locations, raw input) and the
   options allow once, allow always, reject once, reject always. ask/auto/
   bypass and the judge stay; `allow-session` maps to allow always. The
   classifier learns ACP shapes: kind `execute` with its command goes through
   today's shell rules, `edit`, `delete` and `move` with their locations
   through today's write rules, and `read`, `search`, `fetch` and `think` are
   reads. Claude runs in `default` mode: reads never ask, everything else
   calls back. Codex runs in the adapter's `read-only` mode (displayed "Ask
   for approval"): a workspace-write sandbox with no network, every action
   outside it forwarded to Sirus. This changes Codex participants:
   in-workspace edits and commands run sandboxed without a prompt, and only
   escalations reach the gate. The alternative, `agent-full-access`, never
   asks at all, so the gate would see nothing.
9. **Checkpoint before the turn, not per write.** Native tools cannot wait on
   a barrier, so the pre-turn snapshot is awaited before `session/prompt`.
   Chat rewind works on a session-wide sequence number stamped on every
   transcript entry: a checkpoint records the sequence at capture; rewinding
   drops later entries from every participant and rebuilds their runtimes.
10. **Repository instructions stay Sirus's.** Sirus keeps injecting
    `SIRUS.md` or `AGENTS.md` into its system prompt. Claude: the prompt goes
    as `_meta.systemPrompt` (a string replaces the Claude Code preset, as
    Sirus replaces it today) and `settingSources: []` keeps `CLAUDE.md` and
    settings files out, as today. Codex: the adapter has no prompt hook, so
    the prompt is written to a file per runtime and named by
    `model_instructions_file` ("replacement for built-in instructions") in
    the `CODEX_CONFIG` overrides the adapter passes to the app-server, with
    `project_doc_max_bytes = 0` so `AGENTS.md` is not loaded twice. Both
    keys are in the config reference and known to the Codex binary Sirus
    ships.
11. **A mentioned participant receives the sender's whole message**,
    attributed. Only the mentioning paragraph would save tokens but drop
    context the sender assumed was shared.

## Why ACP

Verified on 2026-09-21 against `@agentclientprotocol/sdk` 1.4.0,
`@agentclientprotocol/claude-agent-acp` 0.79.0 (Agent SDK 0.3.274) and
`@agentclientprotocol/codex-acp` 1.12.0 (Codex 0.154), by reading the SDK
types and both adapters' sources. The protocol is at version 1; the
`@zed-industries` packages are the same adapters under their old names.

- Context gauge: `usage_update` carries tokens in context and the window
  size. Claude emits it from `modelUsage` after each result and after
  compaction; Codex from `thread/tokenUsage/updated`. Per-turn token totals
  on `PromptResponse.usage` are marked unstable and not relied on.
- Tool activity: `tool_call` and `tool_call_update` with a kind (read, edit,
  delete, move, search, execute, think, fetch, switch_mode, other), title,
  status, locations, raw input and output, and content blocks including
  diffs and terminal output. Claude maps its eight file, shell, search and
  web tools onto these; unlisted tools such as NotebookEdit arrive as kind
  `other` with raw input, one reason they stay off the allowlist.
- Permissions: `session/request_permission`, as in decision 8.
- Model selection: there is no `session/set_model`. `session/new` returns
  `configOptions`; `model` is a select option set by
  `session/set_config_option` (Claude also exposes effort and fast mode,
  Codex adds approval and sandbox), and `config_option_update` keeps Sirus in
  sync. Permission modes are `session/set_mode`.
- Compaction: `compaction_update` and `compaction_summary_chunk`, sent only
  when the client advertises `session.compaction`; `/compact` on both.
- MCP: `session/new` takes `mcpServers` of type stdio, http, sse or acp.
  Claude accepts stdio, http and sse; Codex accepts stdio and http.
- Questions to the user: `elicitation/create` in form mode, a JSON schema of
  string, number, boolean, enum and multi-select fields. Claude renders
  AskUserQuestion as one and Codex its request-user-input tool, both only
  when the client advertises `elicitation.form`. Sirus does not, for now.
- Later work is covered: `session/fork` (Claude advertises it, Codex not
  yet), prompt queueing for messages mid-run (Claude), `session/load` and
  `session/resume` on both.
- Client options: Claude takes Agent SDK options through
  `_meta.claudeCode.options` on `session/new` (tools, disallowedTools,
  settingSources, env, resume, hooks) and the system prompt through
  `_meta.systemPrompt`. Codex takes process-level knobs: `CODEX_CONFIG`
  (JSON config overrides), `INITIAL_AGENT_MODE`, `CODEX_PATH`, `NO_BROWSER`,
  and the API key variables.

What ACP does not cover stays Sirus's: routing and rounds between
participants, the cross-vendor subagent tool and memory (over MCP), and
checkpoints.

## Shape

### Transcripts and the timeline

- `Participant` owns a `Transcript`: ordered entries, each stamped with a
  session-wide sequence number and the participant name. Entry kinds: a user
  prompt, a message from another participant (attributed `@name`), the
  participant's own response with its tool activity, a compaction boundary.
- The session's timeline is a merge of all transcripts by sequence number. It
  is derived for the UI and the snapshot; it is not a source of truth.
- Routing is unchanged in grammar (`ParticipantRoster` stays): mentions in a
  user prompt pick recipients; an unmentioned prompt goes to the default
  participant; mentions in a response schedule the next round. What changes
  is delivery: the recipient's transcript gets the sender's whole message,
  attributed to the sender, and nothing else.

### Runtimes

- A runtime is one agent process plus one ACP session. Start: spawn the
  launch spec's command with the credential's environment; `initialize` with
  protocol version 1 and `session.compaction` as the only client capability;
  `session/new` with the working directory, the Sirus MCP server, and the
  vendor's extras (Claude: the tool allowlist, the system prompt,
  `settingSources: []`, `permissionMode: "default"`; Codex: mode and config
  arrive through the environment); `session/set_config_option` for `model`
  when it differs from the default. Each turn is one `session/prompt`;
  `session/cancel` stops it. Runtimes stay warm between turns.
- The vendor's conversation is authoritative while its runtime lives. Sirus
  records the participant's transcript from `session/update`: message and
  thought chunks, tool calls and their updates, compaction. This record is
  what the UI renders and the snapshot saves.
- When a runtime is lost or must be rebuilt (fallback, a model change the
  config option cannot apply, restored session, rewind), the new runtime is
  seeded from the participant's own recorded transcript as text in its first
  prompt, the way the first turn is replayed today. `session/load` and
  `session/resume` are same-vendor, same-profile optimisations, not the
  mechanism.
- Fallback stays as it is in spirit: credentials in order, sticky per
  runtime. Tool work completed before a failure is already in the record, so
  the retry reseeds from it.

### Usage and status

- Context gauge from `usage_update`, per participant; the status row shows
  the default participant's, or the last responder's. It is empty until the
  runtime's first update. The catalog's static context windows go, since the
  runtime reports the size.
- `compaction_update` renders as a `context compacted` rule in that
  participant's entries.

### Rendering

Tool calls render from ACP shapes, once: the kind picks the verb and icon,
the title is the line, diff content becomes today's diff view, text and
terminal content the output preview, and status moves from pending through
in progress to completed or failed. Thought chunks render as thinking. Plans,
terminals and elicitations are not advertised and never arrive.

### What goes

`providers/anthropic/api.ts` and `claude-subscription.ts`,
`providers/openai/api.ts`, `codex-subscription.ts`, `codex-rpc.ts` and
`codex-models.json`, the tool loop in `chat.ts` and `fallback.ts`'s
continuation handling, `tools/files.ts`, `tools/shell.ts`,
`tools/search.ts`, `tools/web.ts`, `providers/subscription.ts` (replay),
`agent_runtime/compaction.ts`, `MODEL_ONLY_CONFIG`, the shared `Transcript`.
The direct dependencies on `@anthropic-ai/sdk`, `openai`,
`@anthropic-ai/claude-agent-sdk` and `@openai/codex` go; the two adapters and
`@agentclientprotocol/sdk` come in at pinned versions.

What stays: `provider.ts`'s source list and fallback order, with the
transport reduced to the launch spec; `catalog.ts` for the `@name model`
syntax and defaults; `tools/agents.ts` and `tools/subagents/`;
`tools/memories.ts`; permissions; checkpoints; memory; persistence;
commands; the frontend.

## Delivery

One PR on one branch. The implementing session uses subagents for the units
that do not share files, and integrates them itself:

1. The ACP runtime and launch specs: spawn, initialize, `session/new`,
   prompt, cancel, the update stream into transcript entries; the two launch
   specs.
2. The Sirus MCP server over loopback HTTP with participant identity.
3. Per-participant transcripts: sequence numbers, the merged timeline,
   delivery by mention, rewind on sequence, reseeding.
4. The permission handler and the classifier mapping.
5. Frontend: ACP tool call rendering, the gauge, the compaction rule.
6. Deletions, catalog cleanup, docs; tests move with the code.

Before merge: typecheck and the test suite, then a headless smoke run on both
vendors on a few real tasks, judged on tool-call quality, permission prompts,
and what the chat shows. This is the go/no-go the old phase 1 provided.

## Watch

- Subscription usage. Native harness prompts are larger than Sirus's. On a
  subscription this is allowance, not money.
- Two processes per participant (adapter plus CLI or app-server). Startup
  latency is paid once per runtime, not per turn.
- Adapter drift. Both adapters move fast; versions are pinned exactly and
  bumped deliberately.
