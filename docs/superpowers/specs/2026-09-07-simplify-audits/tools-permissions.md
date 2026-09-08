# Audit: tools, subagents, permissions

## Layout today

- Registry `src/agent_runtime/tools.ts:19-25`; runtime factory `tools/runtime.ts:32-119`;
  singleton bound at `tools.ts:27-37`; types `tools/types.ts`; hand-rolled validation
  `tools/arguments.ts`.
- Families split as `X.ts` + `X/tools.ts` (files, shell, search, memories, agents). None earns
  the split. `agents/tools.ts:1` imports `modelStrategies` from `chat.ts`, and `chat.ts:3`
  imports `runTool` — a cycle papered over with a lazy `get args()` (`agents/tools.ts:15-16,34`).
  `tools/shell.ts` and `tools/shell/` coexist (resolution hazard).
- `tools/subagents.ts` (434): lifecycle (`startSubagent:102`, `execute:175`, `checkSubagent:140`,
  `cancelSubagent:156`), process-wide registry + change notification (`:60-79`), directory
  accounting (`activeSubagentCount:93`), model-facing formatting (`describeRun:209`,
  `finalMessageOf:243`, `summarizeChanges:266`, `renderTranscript:358`), temp-file streaming +
  exit cleanup (`:396-434`). `runs` is never deleted from; retains every worker forever.
- `permissions/permissions.ts` (637): modes `:15-33`; classification `classifyToolCall:100`,
  `READ_TOOLS:76`; shell parser + policy table `:136-406` (~250 lines, **zero direct tests**);
  UI copy `:413-446,629`; module-global store `:457-463` (pending, allowances, verdicts, judge
  cache, listeners — never evicted; `clearSessionAllowances` exists and is never called); gate
  `authorizeToolCall:586`, `requestApproval:531`, `judge:551`. `judge.ts:50-83` spins a
  throwaway `SessionAgent` per verdict.
- `tools/web.ts` is not a tool family; it is wire shapes for provider-native web tools.

## Consumers

`availableTools({subagent})` → `providers/anthropic/api.ts:289`, `openai/api.ts:169` (per
request), `claude-subscription.ts:388`, `codex-subscription.ts:397` (once per provider session —
so `/memory` must call `resetAllRuntimes()`, `commands/memory/behavior.ts:19`).
`runTool(call, dir, signal, permissions, agent)` → `chat.ts:57`, `claude-subscription.ts:218`,
`codex-subscription.ts:335`. `executeTool`/`findTool`/`toolRegistry` → tests only.
Subagents: `startSubagent`/`checkSubagent`/`cancelSubagent`/`describeSubagents` → `agent.ts`;
`subscribeSubagents`/`getSubagentsVersion`/`listAllSubagents`/`findSubagentByCall`/`SubagentStatus`
→ `ChatMessage.tsx:10-14`, `useNotifications.ts:9-12`, `Chat.tsx:31`; `activeSubagentCount` →
`session.ts:402`, `commands/checkpoints/behavior.ts:132`.
Permissions: `authorizeToolCall`, `classifyToolCall` → `runtime.ts`; mode symbols →
`commands/session/behavior.ts`, `session.ts`, `Chat.tsx:25`; `pendingApprovals`/`resolveApproval`/
`subscribePermissions`/`getPermissionsVersion` → `Chat.tsx`, `ChatMessage.tsx`, `useNotifications.ts`;
`isAwaitingApproval` → `ChatMessage.tsx:192`; `isDeclinedResult`/`DECLINED_PREFIX` →
`ChatMessage.tsx:191`; `describeRequester` → `InputBar.tsx:327`, `useNotifications.ts:70`.
Dead exports: `sessionAllowances`, `clearSessionAllowances`, `judgeVerdictFor`, `isAwaitingJudge`.

## Problems

- `Tool.func(args, directory, call?)` positional; return `unknown | Promise<unknown>` types
  nothing; `ToolCallContext` imports `SessionAgent` and `PermissionContext` (leaf depends on
  session layer); only `SpawnAgent` uses `call.agent`/`call.permissions`.
- `createToolRuntime` special-cases families by name-set (`memoryToolNames`,
  `agentToolNames`); memory enforced twice, audience enforced **only on listing** — a subagent
  emitting `SpawnAgent` spawns a grandchild (`agent.ts:129-136` gives workers an empty map).
- `runTool` classifies `RunShell` up to three times per call (`:83`, `:595`, `:632`).
- `PermissionContext.beforeMutation` is a filesystem latch, not a permission; `runtime.ts:80-91`
  awaits it outside `authorizeToolCall` and it fires even in `bypass`. `model` is only used to
  pick the judge.
- `classifyToolCall:114-117` defaults unknown tools to `'read'`; safe only because `runTool`
  rejects unknown names first.
- Four name tables to edit per new tool: `READ_TOOLS`, the `switch` `:102`, `allowanceKeyFor`
  `:389`, `describeToolCall` `:420`.
- Schemas declared twice (`memories/tools.ts` vs `memories.ts` via `arguments.ts`); nothing
  validates against the declared schema.
- Two hand-rolled `version + listeners + subscribe` stores (`permissions.ts:462-478`,
  `subagents.ts:60-79`).
- `findSubagentByCall` filters by `run.permissions?.sessionId`.
- The gate is optional: `runtime.ts:80` skips everything when `permissions` is undefined.

## Behaviours to preserve (test)

- Reads pass unprompted and unblocked (`tests/agent/checkpoint_barrier.test.ts:34-45`).
- **`RunShell` always waits for the barrier even when classified read** (`checkpoint_barrier.test.ts:21-32`).
- A mutating tool waits for the pre-turn snapshot (`tests/data/session_checkpoints.test.ts:29-60,118-140`).
- Cancel during the barrier prevents execution (`checkpoint_barrier.test.ts:47-57`).
- Memory toggle live: tools vanish and direct calls fail with the `/memory on` message
  (`tests/agent/tools.test.ts:223-249`); prompt section toggles (`tests/agent/prompt.test.ts:45-78`).
- Registry order and exact set (`tools.test.ts:24-39,225-235`).
- Subagent audience exclusion (no direct test).
- Cancellation propagates; `RunShell` kills its process group (`tools.test.ts:196-205`);
  cancellation is never a tool error.
- Error formatting: unknown tool, thrown validation, non-string results (`tools.test.ts:77-87,146-160,207-221`).
- Judge: cheapest same-vendor model, tool-less, 10 s timeout, unexpected ⇒ sensitive (no test);
  verdicts cached per session+command (no test).
- Approval prompts reach the UI keyed by session with the requester named
  (`tests/frontend/notifications.test.ts:142-170`, `tests/frontend/input_bar.test.tsx:244-260`).
- Approval indicators don't leak between sessions reusing a call id
  (`tests/frontend/session_subagents.test.tsx:119-142`).
- "Allow for this session" offered only with an allowance key (`input_bar.test.tsx:244-260`).
- Declined result text recognisable (`ChatMessage.tsx:191`).
- `activeSubagentCount(directory)` blocks file rewind across sessions
  (`session_subagents.test.tsx:59-104`); per-session count excludes other sessions' workers (`:64-74,86-87`).
- A subagent inherits the owner's permission context re-stamped with its own requester/model (`:83`).
- Change summary read off successful tool calls (`subagents.ts:266-326`).
- `CheckAgent` 60 s wait bound (`subagents.ts:54,145-151`).
- Turn permission context shape asserted at `tests/data/data.test.ts:155-161` (will change).

## Migration notes

- Write characterisation tests for `classifyShellCommand`/`classifyGit`/`splitShellCommand`/
  `allowanceKeyFor` before moving them.
- Collapse families one per commit-sized step; delete `X/` directories after.
- Enforcing audience at execution changes one behaviour: a subagent's `SpawnAgent` is refused.
- Convert the three `runTool` call sites together; make the toolbox non-optional on turns that
  run tools.
- Keep `SubagentRun` field-compatible for the UI; add `sessionId`.
- Keep `permissions.ts:114-117` default safe once `Tool.effect` is authoritative: unknown tool
  names are rejected by the toolbox before classification.
