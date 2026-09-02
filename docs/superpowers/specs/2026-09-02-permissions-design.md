# Permission system design

Date: 2026-09-02

## Goal

Give every Sirus session one of three permission modes that decide whether a
model-requested tool call runs, prompts the user, or is refused:

| Mode | Display name | Behaviour |
| --- | --- | --- |
| `ask` | ask for approval | Deterministic. Reads pass; writes and shell commands prompt. No model is ever consulted. |
| `auto` | auto approve | Reads and ordinary writes pass; sensitive operations prompt. Shell commands the static rules cannot place are judged by a cheap model. |
| `bypass` | bypass permissions | Everything passes. No classification at all. |

The gate is Sirus-native and identical across all four model transports
(Anthropic API, OpenAI API, Claude Code subscription, Codex subscription).
Provider permission features are not used: Claude Code keeps running with
`bypassPermissions` so it never prompts on its own, and Codex's approval
policies only govern built-in tools Sirus already disables.

## Non-goals

- Gating web search and fetch. All four runtimes execute those inside the
  provider and only report what happened, so they are classified as reads.
- Gating memory tools. SaveMemory, GetMemory, SearchMemories and DeleteMemory
  are reads in every mode.
- Persistent allow rules across launches. Session allowances live in memory
  only.
- A global default mode setting. New sessions start in `auto`.

## Architecture

New module `src/agent/permissions.ts` with three parts: mode, classification,
and requests. The single call site is `runTool` in `src/agent/tools.ts`, which
every transport, every participant, and every subagent already goes through.

### Mode

- `type PermissionMode = 'ask' | 'auto' | 'bypass'`.
- `Session` stores the mode, exposes `getPermissionMode()` /
  `setPermissionMode()`, notifies listeners on change, and includes it in
  `SessionSnapshot` as an optional `permissionMode` field. Missing or unknown
  values load as `auto`.
- Subagents inherit the mode of the session that spawned them, read at spawn
  time from the spawning call's context and stored on the `SubagentRun`.
  Changing the session mode afterwards applies to the next tool call of the
  session's own participants and of subagents already running, because the
  gate reads the mode through the session at call time rather than copying
  it.

### Tool run context

`runTool(toolCall, directory, signal)` gains a fourth argument:

```ts
interface ToolRunContext {
  sessionId: string;              // Sirus session (or subagent run) id
  mode: () => PermissionMode;     // live lookup, see Mode above
  requester: { participant: string } | { subagent: string };
  model: string;                  // the model that issued the call, for judge vendor
}
```

`ModelContext` carries the same fields so the API loop in `chat.ts`, the Claude
MCP handler in `anthropic/subscription.ts`, and the Codex dynamic-tool handler
in `openai/codex-subscription.ts` can pass them through. The SpawnAgent tool
receives the context via `ToolCallContext` so the subagent run records the
inherited mode and its own requester label.

### Classification

A pure function:

```ts
type ToolClass = 'read' | 'write' | 'sensitive' | 'unsure';
function classifyToolCall(call: ToolCallBlock, directory: string): ToolClass;
```

Per tool:

- **read:** ReadFile, SearchFiles, SaveMemory, GetMemory, SearchMemories,
  DeleteMemory, CheckAgent, ListAgents, CancelAgent, WebSearch, FetchURL,
  and any unknown tool name (it will fail as unknown anyway).
- **write:** WriteFile and EditFile when the resolved path is inside the
  session directory; SpawnAgent.
- **sensitive:** WriteFile and EditFile when the resolved path is outside the
  session directory.
- **RunShell:** command-level rules below.

Shell rules. The command is split into simple commands on `|`, `||`, `&&`,
`;` and newlines. Each simple command is classified and the strictest result
wins, ordered `sensitive > unsure > write > read`. Quoted strings are kept
intact when splitting; a command the splitter cannot parse is `unsure`.

1. **sensitive** if any simple command matches: `rm`, `chmod`, `kill`,
   `pkill`, `killall`; `sudo`, `doas`, `su`, `dd`,
   `mkfs`, `diskutil`, `shutdown`, `reboot`, `launchctl`, `systemctl`,
   `crontab`; anything piped into a shell or bare interpreter; `git push`
   (except `--dry-run`), `git reset --hard`, `git clean`, `git checkout --` /
   `git restore` discarding changes, `git branch -D`, `git stash drop`,
   `git config --global`; reading secret stores (`~/.ssh`, `~/.aws`,
   `~/.gnupg`, `~/.netrc` and the like); a redirection to a path outside the
   session directory and the temp directory; a file-changing command (`mv`,
   `cp`, `mkdir`, `touch`, `chown`, `tee`, `sed -i`, …) whose target is
   outside the session directory and the temp directory. Reads outside the
   directory are reads.
2. **read** if every simple command's first word is on the read-only list and
   the chain contains no `>` or `>>` redirection: the usual inspection
   commands (`ls`, `cat`, `grep`, `rg`, `find`, `wc`, `ps`, `lsof`, `env`,
   `uname`, …), `sed` without `-i`, `curl` without a request-body or upload
   flag, `cd` inside the directory, and read-only git subcommands (`status`,
   `diff`, `log`, `show`, `remote -v`, `stash list`, `config --get`, …).
3. **unsure** otherwise: builds, tests, package managers, git commands that
   change the repository, file commands inside the directory, redirections
   into files, interpreters, and anything unrecognised. In auto approve the
   judge decides these; in ask for approval they prompt like any write.

Shell commands therefore never classify as `write`; that class is for the
file and agent tools.

### Decision per mode

| Class | ask | auto | bypass |
| --- | --- | --- | --- |
| read | run | run | run |
| write | prompt | run | run |
| sensitive | prompt | prompt | run |
| unsure | prompt | judge, then as write or sensitive | run |

A session allowance (see Prompts) turns a `write` or `unsure` prompt into
`run`. Allowances never cover `sensitive`.

### The judge

`judgeShellCommand(command, directory, model, signal): Promise<'approve' | 'sensitive'>`

- Invoked only from `auto` mode for `unsure` RunShell calls.
- Vendor follows the participant's model: `claude-*` models judge with
  `claude-haiku-4.5`, `gpt-*` models judge with `gpt-5.6-luna`, each through
  whatever credential that vendor currently uses (API key or subscription).
- One tool-less request whose system prompt states the session directory and
  the definition of sensitive (destroying or overwriting data, touching paths
  outside the directory, network writes, privilege escalation, process
  control) and asks for exactly one word: `approve` or `sensitive`.
- Any answer other than those two words, an error, or a 10 second timeout
  counts as `sensitive`.
- Verdicts are cached per session by exact command string for the life of
  the process.
- Each transport exposes a `judge(prompt, model, signal)` entry point: a plain
  `messages.create` / Responses call for the API providers, and a one-shot
  tool-less run for the subscription runtimes. If a subscription entry point
  is not ready when the rest ships, `unsure` on that transport is treated as
  `sensitive`.

### Requests

- `requestApproval(request): Promise<Decision>` where `request` carries the
  requester, the tool call, its class, the session id, a human-readable detail
  block, and the turn's abort signal; `Decision` is `allow`, `allow-session`
  or `deny`.
- Pending requests are kept in a queue exposed as an external store
  (`subscribePermissions`, `getPermissionsVersion`, `pendingRequests()`) for
  `useSyncExternalStore`, matching the subagent and session stores.
- An aborted signal removes the request from the queue and rejects the
  promise with the abort reason, so a cancelled turn never leaves a prompt
  behind and the tool never runs.
- `deny` makes `runTool` return an error result: `The user declined to allow
  <tool> <detail>. Do not retry it; explain or ask.`

### Session allowances

`allow-session` records a rule on the session, in memory only:

- WriteFile / EditFile: the directory of the file.
- RunShell: the first word of the first simple command (`git`, `bun`).
- SpawnAgent: the tool name.

Rules are checked after classification and only apply to `write` and
`unsure`.

## User interface

### Prompt

A new `InputMode` variant `approval` in `InputBar.tsx`, rendered where the
menu and secret prompts already render. It shows:

- who is asking: `@sirus`, `@reviewer`, or `subagent sub-1a2b`;
- the tool and its detail: path plus first lines for WriteFile, path plus a
  compact old/new diff for EditFile, the command for RunShell, the task for
  SpawnAgent;
- for auto mode, the reason it prompted (`sensitive: git push` or
  `judge: sensitive`);
- a count of further prompts waiting.

Choices: **Allow once** (`y`), **Allow for this session** (`a`), **Deny**
(`n`), navigable with arrows and Enter. Escape keeps its existing meaning and
cancels the turn, which resolves the prompt through the abort path.

### Commands and keys

- `/permissions` opens a three-item picker (existing `commandMenu` pattern).
- `/permissions ask|auto|bypass` sets the mode directly and reports it.
- Shift+Tab cycles `ask → auto → bypass → ask` and shows feedback.

### Display

- The current mode is shown under the input bar, on the same line as and to
  the right of the active-subagent count, by its full display name.
- A denied tool call renders with a `declined by user` marker.
- A RunShell call that went to the judge renders a small `judge: approve` or
  `judge: sensitive` tag.
- A tool call waiting on a prompt or the judge renders as `waiting for
  approval` / `checking`.

## Persistence

`SessionSnapshot.permissionMode?: PermissionMode`. Saved with the session,
loaded with a fallback to `auto`. No new files.

## Error handling

- Judge failure of any kind → `sensitive`.
- Prompt while the TUI is not mounted (headless smoke runs) → the request
  store still queues it; a test harness answers via the store API. There is
  no timeout on prompts.
- A tool call arriving with no permission context is a direct programmatic
  caller (tests, tooling), not a model, and is not gated. Every model-driven
  path (the API loop and both subscription handlers) passes one.

## Verification

- `tsc` clean.
- Headless smoke run with `HOME` pointed at scratch space: one session per
  mode, a read command, an in-directory write, `git push --dry-run`, and an
  unsure command such as `bun x cowsay hi`, answering prompts through the
  store API and checking which calls ran.
- No test files unless requested; the shell classifier is the natural
  candidate if tests are wanted later.

## Files touched

- `src/agent/permissions.ts` (new): mode type, classifier, judge, request
  queue, allowances.
- `src/agent/tools.ts`: `ToolRunContext`, gate in `runTool`, SpawnAgent
  passes context.
- `src/agent/chat.ts`: `ModelContext` fields, pass context to `runTool`.
- `src/agent/providers/anthropic/subscription.ts`,
  `src/agent/providers/openai/codex-subscription.ts`,
  `src/agent/providers/anthropic/api.ts`,
  `src/agent/providers/openai/api.ts`: pass context; judge entry points.
- `src/agent/subagents.ts`: inherit mode, requester label.
- `src/runtime/session.ts`: mode state, snapshot field, allowances.
- `src/data/persistence.ts`: snapshot field round-trip.
- `src/commands/commands.ts`, `src/commands/command_register.ts`:
  `/permissions`.
- `src/frontend/chat/InputBar.tsx`, `Chat.tsx`, `ChatMessage.tsx`: approval
  mode, Shift+Tab, status line, transcript markers.
