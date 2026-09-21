# Workers: background, isolated, steerable, persisted, routed by Jev

Status: approved 2026-09-21. Scope: sub-project 2 of the Jev work, delivered as
one PR. Follows `2026-09-21-jev-session-routing-design.md`.

## Goal

A subagent (a worker) is a background task of the session rather than
something its owner waits on. It works in its own git worktree, can be sent a
message while it runs, survives a restart as a record, and reports back by
waking its owner. When the session has no fixed subagent model, Jev picks the
worker's model and thinking level for the task.

## Decisions

1. **Finishing wakes the owner.** When a worker ends (done, failed, cancelled,
   interrupted) its report, the final message plus branch and change summary,
   is delivered to the owner's transcript as a message from that worker
   (`participant: <run id>`, `to: [owner]`) and starts the owner's next turn,
   as a mention from another participant does. If the session is busy the
   report waits for the turn to end and goes ahead of the user's queued
   prompts. `CheckAgent` loses `wait` and answers with the current state.
2. **Escape cancels the turn, not the workers.** Workers stop through the
   `/agents` panel, `CancelAgent`, or when the session is deleted. Today Escape
   stopped every worker; it no longer does.
3. **Worktree isolation.** In a git project each worker runs in
   `git worktree add <data>/worktrees/<session>/<run> -b sirus/<run>` from the
   project's HEAD, like Claude Code's own isolation: uncommitted changes and
   ignored directories are not carried over. The report names the branch; the
   owner or the user merges it. Workers in worktrees do not block a file
   rewind of the project. Non-git projects run workers in place. Worktrees
   are removed with the session; branches stay.
4. **Fork.** `SpawnAgent` gains `context: "fresh" | "owner"` (default fresh).
   With `owner`, the worker's runtime is a `session/fork` of the owner's,
   started in the worker's directory with the worker's own MCP entry; the
   task is its first prompt. Both adapters support it. A forked runtime shares
   the owner's adapter process: if that process goes, the worker's next
   attempt starts a fresh runtime reseeded from its own record, so nothing
   is lost. If the fork fails the worker starts fresh, reseeded from the
   owner's transcript as text. Found in the build: neither vendor gives a
   fork a system prompt of its own (Claude ignores the one on the resume
   that opens the fork, Codex's instructions file is the process's), so a
   forked worker carries the subagent contract at the top of its first
   prompt instead.
5. **Mid-run messages.** `MessageAgent` (owner) and the panel's message action
   (user) send text into a running worker through the `_session/steering`
   request both adapters implement, recorded in the worker's transcript as a
   user entry. A finished worker refuses with its status.
6. **Persisted runs.** A session's snapshot carries its worker records:
   transcript, branch, status, report. On reopen a run that was working is
   `interrupted`, keeps its record, and its report reaches the owner on its
   next turn. Nothing restarts on its own.
7. **Jev picks the worker.** When `subagentModel` is null, one Jev call at
   spawn. Candidates: every catalog model of a vendor with allowance, except
   Haiku, each described by its `strengths`. State: the task, the project's
   name, each vendor's remaining allowance. Question one picks the model
   (threshold 0.5), question two the thinking level (low, medium, high,
   xhigh). Anything unsure falls back to the owner's model and level.
8. **UI.** A worker strip above the status row: one line per worker of the
   session, running first: status dot, id, model, elapsed, latest tool call,
   branch. Finished lines stay dimmed until dismissed. The SpawnAgent row in
   the chat stays the anchor. `/agents` lists the session's workers; choosing
   one offers show transcript (panel view), cancel, message (typed in the
   input bar), dismiss.

## Contracts

`runtime/runtime.ts`:

```ts
interface Runtime {
  // A new session forked from this one's conversation, on the same process,
  // in the worker's directory with the worker's own callbacks and MCP entry.
  fork(options: ForkOptions): Promise<Runtime>;
  // Injects text into the prompt in flight. Rejects when no prompt runs or the
  // vendor cannot steer.
  steer(text: string): Promise<void>;
}
type ForkOptions = Pick<RuntimeOptions, 'directory' | 'model' | 'thinkingLevel' | 'permissionMode' | 'mcpServer' | 'onPermission' | 'onUpdate'>;
```

`tools/subagents/index.ts`:

```ts
type SubagentStatus = 'working' | 'done' | 'failed' | 'cancelled' | 'interrupted';
type WorkerContext = 'fresh' | 'owner';
interface WorkerRecord {           // what the snapshot stores
  id: string; callId: string | null; owner: string; model: string; thinkingLevel: ThinkingLevel;
  context: WorkerContext; prompt: string; directory: string; branch: string | null;
  status: SubagentStatus; startedAt: number; finishedAt: number | null;
  transcript: Message[]; finalMessage: string | null; changes: string[]; error: string | null;
  dismissed: boolean;
}
interface SubagentRun extends WorkerRecord {
  sessionId: string;
  worker: SessionAgent | null;      // null once restored
  content: MessageBlock[];          // the response entry's content, live
}
```

`tools/types.ts`: `SubagentHost.spawn(prompt, context, call)`, `check(id)`,
`cancel(id)`, `message(id, text)`, `list()`. Tools: `SpawnAgent { prompt,
context? }`, `CheckAgent { id }`, `CancelAgent { id }`, `MessageAgent { id,
message }`, `ListAgents {}`.

`session/index.ts`: `getWorkers(): SubagentRun[]`, `cancelWorker(id)`,
`messageWorker(id, text)`, `dismissWorker(id)`; snapshot `workers?:
WorkerRecord[]`.

`router.ts`: `workerCandidates()`, `vendorAllowance()`,
`routeWorker({ task, directory }, candidates, allowance, options)` returning
`{ model, thinkingLevel } | null`.

`providers/catalog.ts`: `strengths` on every model; `worker: false` on
`claude-haiku-4-5`.

## Verification

Typecheck; the suite with the scripted runtime taught `fork` and `steer`; real
runs on Claude of a worktree worker, a forked worker, a steered worker and a
restart with a working run; Codex when its quota returns.

## Profiles (2026-09-21)

Decision 7's candidates are described by a `ModelProfile` rather than a
`strengths` sentence: the researched summary, published benchmarks under their
own metric names covering coding, research and writing, what users report in
practice, and list price per million tokens. Each candidate's criteria end
with its own vendor's remaining allowance, rendered by the same function the
session router uses, so `routeWorker` still takes the allowance list but the
state no longer carries one. Jev is told to weigh benchmarks and reviews
against what the task demands, cost against its size, and allowance against
both. Questions, threshold, timeout and fallbacks are unchanged.
