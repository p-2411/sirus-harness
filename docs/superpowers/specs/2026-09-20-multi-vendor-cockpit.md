# Sirus as a multi-vendor cockpit over Claude Code and Codex

Status: draft for approval. Scope: the migration only. The subagent work that
follows it (fork, worktree isolation, mid-run messages, persisted worker runs)
is out of scope here and starts once phase 3 lands.

## Goal

Stop running our own agent loop. Each participant becomes a Claude Code
session (Claude Agent SDK) or a Codex thread (app-server), running the vendor's
own tools, prompt caching, and compaction. Sirus keeps what makes it Sirus:
several participants of different vendors in one place, addressed by `@name`;
one standardised cross-vendor subagent tool; one permission UI; checkpoints and
rewind; memory; sessions saved to disk.

## Decisions

1. **One harness per vendor, for every credential.** API keys go through the
   same harness as subscriptions (the Agent SDK reads `ANTHROPIC_API_KEY`,
   Codex reads `OPENAI_API_KEY`). The direct API transports and the host tool
   loop are deleted. A vendor is then one transport, one credential list, one
   fallback order.
2. **Per-participant transcripts.** A message enters a participant's
   transcript only if it was directed to that participant: a user prompt that
   mentions it, an unmentioned prompt for the default participant, or another
   participant's response that mentions it. There is no shared history and no
   replay of "new shared messages". If `@sirus` wants `@reviewer` to know
   something, it says so in the message that mentions `@reviewer`.
3. **Native built-in tools on; Sirus tools over MCP.** Claude Code runs its
   file, shell, search, and web tools; Codex runs its shell, `apply_patch`, and
   web search. Sirus's tools are the ones neither vendor has: `SpawnAgent`,
   `CheckAgent`, `CancelAgent`, and the memory tools, served as today (an
   in-process MCP server for Claude, dynamic tools for Codex).
4. **Native subagents stay off** in both harnesses. Delegation is the Sirus
   tool only, on any vendor, with the subagent model a session setting rather
   than the model's free choice.
5. **Native compaction.** Each participant's runtime compacts its own
   conversation. `/compact` asks the runtime to compact now. The transcript
   level compaction added on 2026-09-20 goes away with the shared transcript.
6. **Sirus's permission gate decides**, through the harness's permission
   callback (Claude: `canUseTool`; Codex: the app-server's approval request).
   ask/auto/bypass and the judge stay. The classifier learns the harness tool
   names (Claude's `Bash` and Codex's command execution map onto today's shell
   rules; file edits onto today's write rules). Harness sandboxing stays off,
   as it is now.
7. **Checkpoint before the turn, not per write.** Native tools cannot wait on a
   barrier, so the pre-turn snapshot is awaited before the runtime turn starts.
   Chat rewind works on a session-wide sequence number stamped on every
   transcript entry: a checkpoint records the sequence at capture; rewinding
   drops later entries from every participant and resets their runtimes.

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
  participant; mentions in a response schedule the next round. What changes is
  delivery: the recipient's transcript gets the sender's whole message,
  attributed to the sender, and nothing else.

### Runtimes

- The vendor's conversation is authoritative while its runtime lives. Sirus
  records the participant's transcript from the harness event stream (Claude:
  SDK messages; Codex: item and turn notifications), as it does today for tool
  calls and web activity, and this record is what the UI renders and the
  snapshot saves.
- When a runtime is lost or must be rebuilt (fallback to another credential,
  model or thinking change, restored session, rewind), the new runtime is
  seeded from the participant's own recorded transcript as text, the way the
  first turn is replayed today. Vendor-side resume (Claude `resume`, Codex
  thread resume) is an optimisation for the same vendor and profile, not the
  mechanism.
- Fallback stays as it is in spirit: credentials in order, sticky per runtime.
  The "carry completed tool work into a retry" logic simplifies to reseeding
  from the recorded transcript, since tool work is now in that record.

### Usage and status

- Context gauge from the harness's reported usage, as today (Claude
  `modelUsage`, Codex `thread/tokenUsage/updated`). The gauge is per
  participant; the status row shows the default participant's, or the last
  responder's.
- Native compaction events (Claude's `compact_boundary` system message, the
  Codex equivalent) render as a `context compacted` rule in that participant's
  entries.

### What goes

`providers/anthropic/api.ts`, `providers/openai/api.ts`, the tool loop in
`chat.ts` and `fallback.ts`'s continuation handling, `tools/files.ts`,
`tools/shell.ts`, `tools/search.ts`, `tools/web.ts`, `providers/subscription.ts`
(replay), `agent_runtime/compaction.ts`, `codex-models.json` and most of
`MODEL_ONLY_CONFIG`, the shared `Transcript`. What stays: `tools/agents.ts` and
`tools/subagents/`, `tools/memories.ts`, permissions, checkpoints, memory,
persistence, commands, the frontend.

## Phases

Each phase is a PR that leaves the app working. Tests move with the code.

1. **Native tools on the existing subscription transports**, behind a flag,
   with the permission callback wired to Sirus's gate and the pre-turn
   checkpoint awaited. Shared transcript untouched. Measure against the current
   transports on a few real tasks: tool-call quality, permission prompts, what
   the chat shows. This is the go/no-go for the rest.
2. **Per-participant transcripts.** Sequence numbers, the merged timeline,
   delivery by mention, rewind on sequence, runtime reseeding from the
   participant's record. Delete replay and the transcript-level compaction;
   route `/compact` to the runtime.
3. **API keys through the harnesses.** Delete the API transports, the host tool
   loop, and the built-in tool implementations. Collapse each vendor to one
   transport.
4. Then the subagent work, in the order agreed: fork, worktree isolation,
   mid-run messages, persisted worker runs.

## Open questions

- **Repository instructions.** Sirus injects `SIRUS.md` or `AGENTS.md` into the
  prompt itself. Claude Code would load `CLAUDE.md` natively and Codex
  `AGENTS.md`. Proposal: keep Sirus's injection and leave native loading off,
  so both vendors read the same file and nothing is loaded twice.
- **Which extra Claude Code tools to allow.** Proposal: the file, shell,
  search, and web set only; no `TodoWrite`, `AskUserQuestion`, or notebook
  tools until there is a reason.
- **What a mentioned participant receives.** Proposal: the sender's whole
  message, attributed. The alternative, only the paragraph carrying the
  mention, saves tokens but drops context the sender assumed was shared.
- **Subscription usage.** Native harness prompts are larger than Sirus's. On a
  subscription this is allowance, not money; worth watching in phase 1.
