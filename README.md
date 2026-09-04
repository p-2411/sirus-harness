coming soon...

<!--# Sirus

A desktop/terminal client for running AI coding agents. Connects to external
agents over the Agent Client Protocol (Claude Code, Gemini CLI, custom agents)
or runs its own agent loop against API providers directly. Persistent
local-first memory (SQLite + vector search) shared across sessions and agents,
with a graph view for browsing it. Tool chaining: multi-step tool sequences
authored by the LLM or by hand.

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer with npm (used only to install and launch)
- macOS or Linux
- A Claude or ChatGPT subscription, or an Anthropic or OpenAI API key
- On macOS, Homebrew SQLite (`brew install sqlite`) for persistent vector memory

## Install

Install the public npm package globally:

```sh
npm install -g sirus-harness
```

Then launch Sirus in the current directory:

```sh
sirus
```

To try a release without installing it globally:

```sh
npx sirus-harness
```

Sirus runs on [Bun](https://bun.sh/). You do not need to install Bun yourself:
the package depends on the `bun` npm package, so npm downloads a matching Bun
binary during install and the `sirus` command uses that copy. If you already
use Bun, `bun add --global sirus-harness` and `bunx sirus-harness` work too;
the launcher falls back to whichever `bun` is on your PATH when the bundled
copy is unavailable (for example after an install with `--ignore-scripts`).

## Launching Sirus

The Sirus package installs a `sirus` executable automatically. It is part of
the package manifest, so users do not need to create a shell alias or configure
a path specific to their machine. Open Sirus in the current directory or name
a directory explicitly:

```sh
sirus
sirus /path/to/project
```

Contributors running directly from a source checkout can expose that same
packaged command with `bun link`; this is only a development convenience, not
a step required by a distributed Sirus installation.

The launch directory owns every new session created while that Sirus process
is open. Quitting and launching `sirus` from another directory assigns new
sessions to the new launch directory. Existing sessions keep their original
directory.

## Signing in: subscription or API key

Sirus can drive Claude models through your Claude Pro/Max login and GPT
models through your ChatGPT login, or through an API key you paste in.
Nothing else changes: Sirus keeps its own prompt, tools, and history; the
provider runtime only carries the model.

- `/login` — opens a picker in the input bar: first Claude or ChatGPT, then
  Subscription or API key. Choosing Subscription runs the provider's browser
  flow (or detects an existing login for the first source). Repeat to add another
  subscription account. Choosing API key adds a key and asks for it
  with its characters hidden.
- `/login claude` / `/login gpt` — skips straight to the second step.
- `/login claude subscription` / `/login claude api <key>` (likewise for
  `gpt`) — add a source directly. Repeat to save multiple keys or subscriptions.
- `/info` — lists saved sources and their IDs, with API keys masked. Each
  subscription shows only `5 hour: <percent>%` and `7-day: <percent>%`, both
  remaining allowance. Unreported limits show `unavailable`. Session token
  totals and context usage appear below the provider sources.
- `/update` — checks npm for the latest published release and installs it
  globally. When one is available, green `/update` replaces the sidebar clock.
  Restart Sirus after it finishes. Source checkouts use `git pull`.
- `/logout claude|gpt [source-id]` — removes one source. Copy an ID from `/info`
  to select it; omit the ID to remove the first source of the preferred type.
  Other saved sources stay available. Environment keys are managed in your shell.
- `/memory [on|off]` — shows or toggles agent access to persistent memory.
- `/thinking [participant] [low|medium|high|xhigh|max]` — opens a picker or
  sets one participant's reasoning depth. The default is `high`.
- `/permissions [ask|auto|bypass]` — shows or sets how the session approves
  tool calls (see below).
- `/clear` — clears the current session's message history.
- `/rename <name>` — renames the current session. A session is named after
  its first prompt until it is renamed.
- `/help` — lists every command and keyboard shortcut.

Newly added sources are tried first within their type. The latest login chooses
whether subscriptions or API keys are preferred; other types remain available
as fallbacks. Requests try each remaining source when one fails, including tool
continuations. Successful fallback sources stay preferred for that agent runtime.
Cancellation stops immediately. A subscription tool with an unknown outcome
stops the turn to avoid repeating work. If all sources fail, Sirus reports the
failures with credentials masked.

The `ANTHROPIC_API` and `OPENAI_SECRET` environment keys remain final API
fallbacks, with duplicates skipped. Existing saved keys and subscription logins
are retained. Additional subscription accounts use separate provider-managed
credential stores under Sirus's `subscriptions` directory, following
[Claude's account configuration](https://code.claude.com/docs/en/env-vars) and
[Codex's credential storage](https://developers.openai.com/codex/auth/).
Sirus does not read subscription tokens.

Under the sidebar header, each provider shows only its currently used
subscription's remaining allowance: seven-day for Codex and five-hour for
Claude, such as `codex: 75%` and `claude: 40%`. Before the first request,
this is the preferred source; with
concurrent sessions, it follows the most recently started request. Fallback
switches the displayed account immediately. Providers using an API key have
no subscription row. Limits refresh every minute and when sources change,
without sending model prompts. The last known limits are cached per account
across restarts and shown while fresh limits load. Cached values expire at
the reported reset (or after one limit window when no reset is reported).

Sessions, their complete message history, the selected session, each
provider's subscription choice, and any pasted API keys are saved locally and
restored on startup. The data lives in the platform application-state
directory (on macOS, `~/Library/Application Support/Sirus`), in files
readable only by your user. Set `SIRUS_DATA_DIR` to override it.

The sidebar lists sessions most recently active first, each with the name of
its directory and how long ago it was last active.

## Typing and keys

- Enter sends. While an agent is working, Enter queues the message instead;
  the row under the input box counts what is waiting, and queued messages go
  out one at a time as soon as the turn ends, even after switching sessions.
  Queued slash commands wait until that session is visible because they may
  open a picker; prompts behind them wait too. Escape cancels the current
  session's turn and subagents and drops its queue.
- Shift+Enter starts a new line (Option+Enter on terminals that do not report
  Shift+Enter, or end the line with `\` and press Enter). Pasted text keeps
  its line breaks.
- ↑ and ↓ bring back earlier prompts of the session; inside a multi-line
  prompt they move between its lines first. Option+↑/↓ switches sessions,
  and Ctrl+N starts a new one.
- Ctrl+K collapses the sidebar to clickable session status dots, or expands
  it again. The dots stay in place, and chat fills the remaining width.
- Shift+Tab cycles the permission mode. Page Up/Down and Home/End scroll the
  history.
- While a turn runs, the line at the foot of the history says what the agents
  are doing (thinking, writing, running a tool, or waiting for your approval)
  and how long the turn has taken. The row under the input box shows the
  context gauge, `ctx <tokens> · <percent>`, for the last response that
  reported usage; it turns amber at 70% and red at 90%. The direct APIs
  report tokens but not the window, so the percentage there assumes 200k for
  Claude models and 400k for GPT models; subscription runtimes report their
  own window.
- Each tool call in the transcript shows what it acted on: the path, the
  command, the query. A file change shows the lines it added and removed and
  opens on click to show them.

## Permissions

Each session has a permission mode, shown under the input bar and cycled
with Shift+Tab or set with `/permissions`:

- **ask for approval**: reads, memory, and web activity run;
  every file write, shell command, and spawned agent waits for you. The
  decision is deterministic; no model is consulted.
- **auto approve** (the default): reads run, and so do file edits inside the
  session directory. Sensitive shell operations (`rm`, `chmod`, `kill`,
  `sudo`, writes outside the directory, `git push`, discarding changes,
  reading secret stores such as `~/.ssh`) wait for you. Other commands run
  automatically unless an internal safety check flags them for approval.
- **bypass permissions**: everything runs.

A prompt names the participant or subagent asking and shows the path and
content, the diff (removed lines in red, added lines in green), or the
command. Answer with `y` (allow once), `a` (allow
this kind of operation for the rest of the session), or `n` (deny, which the
agent is told about). Escape cancels the whole turn. Subagents follow the
mode of the session that spawned them and prompt through the same queue.
The mode is saved with the session; session allowances are forgotten when
Sirus quits.

## Multi-participant sessions

Every session starts with one participant, `@sirus`. A message without a
mention is sent to `@sirus`. Create and address another participant by putting
its name and model in a message:

```text
@reviewer claude-sonnet-5 review the authentication changes
```

The model is routing metadata used only while creating the participant. It is
removed from the stored and provider-facing message, so the new agent receives
`@reviewer review the authentication changes`.

After creation, mention only the name to address it. Mention several names in
one message to run those agents in parallel:

```text
@sirus @reviewer compare your approaches and identify any security gaps
```

Participant names are case-insensitive and each participant responds at most
once per message. All participants receive the same shared session history,
and their names, model choices, and thinking levels are persisted with the
session. Use `/model [participant] <model>` to change one participant's model.
Changing Sirus's model in an empty session also saves it as the default for
future sessions. Once the session has messages, model changes apply only to
that session. Other sessions keep their own models, including after a restart.

Only mentions in top-level prose invoke agents. Mentions shown as quoted
examples, inline code, blockquotes/callouts, lists, tables, headings, fenced or
indented code, and other Markdown blocks remain inert.

Agents can also mention existing participants in their responses. Those
participants run in the next parallel round and may delegate to other existing
participants in turn. An agent cannot create a participant; only the user's
`@name <model> <prompt>` syntax can do that. Agents may mention one another
repeatedly for a back-and-forth exchange; delegation ends when a round produces
no further mentions. Self-mentions are ignored.

## Subagents

An agent can delegate a self-contained task with the `SpawnAgent` tool,
giving it a prompt and a model. The subagent runs in the background in the
session's directory with the same file, shell, and memory tools, sees only its
prompt, cannot ask questions, and cannot spawn agents of its own. `SpawnAgent`
returns at once with the subagent's id and the path of a temporary file where
its transcript streams while it works, so the calling agent can keep going and
look in on progress by reading that file or calling `CheckAgent`. Calling
`CheckAgent` with `wait` set blocks until the subagent finishes (up to a minute
per call) and returns its final message together with a summary of the files
it created or edited, the commands it ran, and the memories it changed. The
temporary file is deleted as soon as the subagent finishes.

`ListAgents` lists every subagent spawned in the running Sirus process with
its status, and `CancelAgent` stops a working one, waits for it to wind down,
and reports the changes it had already made. Pressing Escape to cancel a turn
also cancels the subagents that turn started, and quitting Sirus cancels them
all.

In the chat, the `SpawnAgent` call shows an amber dot while the subagent is
working, green once it has finished, red if it failed, and a muted dot if it
was cancelled. The row under the input box counts the subagents still working.

## Web access

Agents can search the web and read pages. Sirus does not run searches or
fetches itself: every runtime brings its own web capability and executes it,
and Sirus translates what the runtime reports into two tools that appear in
the transcript under one shape regardless of runtime.

- `WebSearch` records a query and the pages it found.
- `FetchURL` records a page the agent read, with its content when the runtime
  provides it (kept to the first 100,000 characters in the transcript).

What each runtime provides:

| Runtime | Native capability | Normalized output |
| --- | --- | --- |
| Anthropic API | `web_search` and `web_fetch` server tools | Search hits with titles, URLs, and page age; full page text for fetches |
| Claude subscription (Claude Code) | Built-in `WebSearch` and `WebFetch` | Search hits plus Claude Code's summary; for fetches, Claude Code's answer to the prompt it gave the page |
| OpenAI API | `web_search` tool | The query and the URLs consulted; pages the model opened appear as `FetchURL` without content |
| GPT subscription (Codex) | Codex's live web search | The query, or the page opened; results stay inside the provider |

The Anthropic and OpenAI APIs and Codex read search results inside the model
request, so the model always sees more than the transcript records. Web use is
part of every model's tool set; no key or setting is needed beyond the
runtime's own access.

## Persistent memory

Sirus stores named memories in `sirus.db` inside the same application-state
directory and keeps their vector embeddings in that database. Global memories
are shared by every session and project. Project memories are tied to the
owning session's canonical directory and are visible only to sessions owned by
that same directory. Agents can select global, current-project, or both
available scopes, but cannot name or access another project's directory.
Existing memories created before scopes were introduced migrate to global.
The agent can save, fetch, delete, and semantically search memories through its
memory tools. Memory text remains the source of truth; the vector index is
rebuilt whenever a memory is updated.

Embeddings run locally with the quantized `all-MiniLM-L6-v2` model and produce
384-dimensional vectors. No embedding API or API key is required. The model is
downloaded from Hugging Face the first time an embedding is needed, cached in
the application-state directory, and reused offline afterward. When the
configured embedding model changes, Sirus preserves the memory text and
rebuilds the vector index automatically.

`sqlite-vec` requires a SQLite build that supports loadable extensions. On
macOS, install it with `brew install sqlite`; Sirus automatically checks the
standard Homebrew paths. Set `SIRUS_SQLITE_LIBRARY` to the full path of another
compatible SQLite dynamic library when needed.

## Testing

Tests live under `tests/`, mirroring the structure of `src/`. Run the suite with:

```sh
bun test
```

Run the complete pre-release validation with:

```sh
bun run release:check
```

## License

[MIT](LICENSE)-->
