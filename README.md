# Sirus

A local-first terminal harness for AI coding agents. Bring Claude and GPT into the same conversation, give them access to your project, and move from a question to an inspected, implemented, and tested change without leaving your terminal.

**Bring the subscriptions you already pay for.** Connect as many Claude and ChatGPT subscription accounts as you want, use an Anthropic or OpenAI API key, or combine both. Your existing access powers the agents in one place.

Use it as a daily coding partner or assemble a team for a larger task. Sirus combines shared conversations, autonomous subagents, persistent memory, and automatic checkpoints so you can build, review, and explore with context you can keep and changes you can rewind.

## Get started

Install with Node.js 18 or later and npm:

```sh
npm install -g sirus-harness
sirus /path/to/your/project
```

Run `sirus` on its own to open the current directory. The npm package includes the Bun runtime; Git must be available for file checkpoints.

Inside Sirus:

1. Type `/login` and choose Claude or Codex, then sign in with an existing subscription or enter an API key through the masked input. Repeat `/login` to connect more accounts—as many as you want.
2. Optionally type `/model` and pick a model. The choices come only from your connected vendors and are cached between launches; Sirus fetches missing lists automatically. Short names such as `/model opus` work with vendor aliases such as `opus[1m]`. New sessions use your saved model preference, or `gpt-5.6-luna` by default.
3. Give Sirus a task:

```text
Explore this project, explain how it fits together, and show me where to start.
```

Or go straight to a change:

```text
Find why the tests are failing, fix the underlying issue, and run the relevant tests.
```

Type `/` to browse commands, or `/help` for the full command and keyboard reference. Provider access and model availability depend on the account you connect.

**Trying Sirus for the first time?** [Bring one small task, then ask another model to review it](docs/first-session.md). The walkthrough covers setup, your first useful result, and how to share feedback.

## What you can do with it

| When you need to… | Try asking Sirus… |
| --- | --- |
| Understand an unfamiliar codebase | “Trace a request from the entry point to the database. Explain the main components and where changes usually belong.” |
| Ship a feature | “Add pagination to this endpoint, follow the existing conventions, and test the edge cases.” |
| Debug a stubborn problem | “Reproduce this failure, find the root cause, and make the smallest fix that addresses it.” |
| Get another perspective | “@reviewer claude-sonnet-5 Read the uncommitted changes in this project and review them for correctness and regressions.” |
| Divide up a larger task | “Delegate an inspection of the API and an inspection of its tests to separate subagents, then combine their findings into a plan.” |
| Work from visual context | Attach a screenshot and ask: “Find the component responsible for this layout and fix the spacing.” |
| Carry decisions into future sessions | “Remember for this project: database changes need a migration and a rollback plan.” |

Each agent runs its own vendor's tools: reading, searching, creating and editing files, running shell commands and tests, and web search and page access. Sirus adds its memory and delegation tools on top, the same ones on every vendor. Your prompts set the scope: ask for an explanation, a review, or an implementation.

## What makes Sirus different

### Claude and GPT, in one conversation

Choose the model for each participant and adjust its reasoning depth. Bring in a second model to review an implementation or challenge a design while keeping the conversation in one place.

Create a named participant by mentioning a new name followed by a supported model and a prompt:

```text
@reviewer claude-sonnet-5 Read the uncommitted changes in this project and review them for bugs and missing tests.
```

Then address that participant by name:

```text
@reviewer Check whether the latest fix resolves the issues you found.
```

Each participant keeps its own conversation. It reads the prompts you address to it, and whatever another participant says in a message that mentions it, attributed to the sender. A prompt that mentions no known participant goes to the selected agent, initially `@sirus`. An unknown `@word` stays ordinary text unless a supported model follows it. Matching files take priority in the `@` menu. Set a participant's model with `/model @reviewer <model>` and reasoning depth with `/thinking @reviewer high`. Use `/model` to see the model names supported by your installation.

The names at the top select which agent’s conversation you see. The selected name has a filled highlight in its own colour. Press **← / →** or click a name to switch agents; each keeps its own draft and scroll position. Other agents continue working without moving the conversation you are reading. While an agent works, a single column of dots moves across its name with constant height and density. A period after the name marks unread output (`reviewer.`); an exclamation mark (`!`) marks a request needing your attention. Requests from another agent appear with its name and destination in both conversations.

The model, reasoning depth, context usage, unfinished plan, and approval prompts belong to the selected agent. `/model`, `/thinking`, and `/compact` act on that agent; explicit agent names still work. Plain horizontal arrows switch agents when there is more than one; Alt+←/→ still moves by words in the draft. Esc and Ctrl+C retain their task-wide interruption behavior.

### Delegate work, follow the results

For work that can be split into independent tasks, Sirus can spawn subagents that work in the background. Each receives a focused assignment, and the agent that spawned it carries on at once. The row that started a subagent is titled with its name and its task, as `greet-jsdoc(Add JSDoc to greet)`, and says under it how the run stands: `Working`, then `Done (3 tool uses · 24k tokens · 16s)`, counting any call that failed or that you declined. When a subagent ends, its report appears in full under that row, saying what it did, what it changed, what did not go through, and where its work is; the row opens itself so you do not have to go looking. The agent that spawned it is told the same thing, and that report starts its next turn. If the session is busy the report waits for the turn to finish, and goes ahead of whatever you queued behind it.

An agent can also wait for a subagent's report in the call that spawned it. If you press `Esc` while it waits, or the wait passes four and a half minutes (both vendors give up on a tool call after five), the subagent carries on in the background and its report reaches the agent the same way.

Subagents work in the project directory itself by default, so assignments should avoid overlapping edits. An agent can ask for a Git worktree instead: the subagent then works on a branch named after the run and cut from your project's HEAD, so its edits meet neither yours nor another subagent's. Uncommitted changes and ignored files are not carried over. The report names the branch, and merging or inspecting it is yours or the spawning agent's to do. A worktree the subagent left unchanged is removed when it ends; the others live in Sirus's data directory and go when the session is deleted, while the branches stay. A project that is not a Git repository gets no worktree.

Named participants are collaborators you can address and follow in the chat; subagents receive only their delegated task and report back to the agent that spawned them, though an agent can also start one from its own conversation so far when the task depends on what you have already established. While a subagent runs, its owner can ask it for its status, send it further instructions, or stop it. `Esc` cancels the session's turn and leaves the subagents working. A subagent whose agent has reported nothing for 15 minutes, not counting time spent waiting on your approval or inside a tool call that is still running, such as a long build, is taken as hung and stopped, and its report says so.

You can follow them yourself. A subagent goes by the name its agent gave it, or by its id when it was given none, on the strip, in `/agents`, on its row and on its approval prompts. The strip above the status row shows one line, for the subagent that changed last: its name, its model, how long it has been running, its latest tool call, its task, and its branch, with a counter such as `1/3` when others are behind it. Press `↓` from the input bar to step onto the strip; the order is fixed as you arrive, `↑`/`↓` walk it, `enter` opens that subagent's actions, and `↑` past the first line or `Esc` hands the keyboard back to your draft. A subagent that ends keeps its line for a second, dimmed, saying how it ended, and is then off the strip. `/agents` lists the session's subagents and offers to show one's record, send it a message, cancel it, or dismiss its line. Runs are saved with the session: one still working when you quit comes back marked interrupted, with its record, and its report reaches its owner on your next prompt. Nothing restarts on its own.

A subagent inherits its owner's model and reasoning depth unless the spawning agent selects another. Use `/model subagent <model>` to fix the subagent model for the session, `/model subagent` to see it, and `/model subagent default` to restore the default behavior.

### Explore with an undo button

Sirus captures a checkpoint before each turn. Use `/undo` for the last turn or `/rewind` to choose an earlier checkpoint, then restore files, chat, or both.

```text
/undo files
```

This restores the files while keeping the conversation, letting you discuss what happened and try another approach. Checkpoints live in a separate Git repository in Sirus's local data directory, leaving your project's Git history and staging area untouched.

File restoration covers the checkpointed directory, including your own edits since the snapshot. It respects Git's tracked and ignored file rules; it does not undo external effects such as deployments or database changes.

Restoring the chat waits for the session's subagents to finish, and the conversation it continues in starts with none of them. Restoring files waits only for a subagent working in the project directory itself; one in its own worktree is out of the way.

### Memory that survives a new chat

Sirus can remember durable preferences and project decisions, then retrieve them by meaning in later sessions. Global memories carry preferences across projects; project memories stay scoped to the session's directory.

Memory is enabled by default. Ask Sirus to remember, update, or forget something, use `/memory list` to see what is remembered and `/memory forget <name>` to remove one, or `/memory off` to disable agent access. Memories are stored locally.

### Context that compacts itself

Long sessions fill the model's window. Each participant's runtime folds its own conversation when its window fills, the way Claude Code and Codex do on their own, including in the middle of a very long turn. Sirus records where that happened: a `context compacted` rule appears in that participant's part of the chat, with the summary the runtime reported.

Use `/compact` to ask for it now, optionally followed by what the summary should keep. There is nothing to turn on or off: compaction belongs to the runtime. `/undo` and `/rewind` treat the rule like any other entry, and rewinding the chat to before one puts the whole conversation back.

### Keep several tasks moving

Create sessions, name them, and switch between them from the sidebar. Each session retains its working directory, conversation, participants, model choices, and permission mode. Existing sessions keep their model settings when you change models elsewhere.

Press Enter while an agent is busy to queue a follow-up. Text reaches the agent after its tool calls finish, or starts the next turn if it is only writing. Commands and images wait until the turn ends; model, thinking, permission, status, and worker controls run immediately. Ctrl+Enter (or Ctrl+X Ctrl+S) sends waiting messages and your draft now. Esc interrupts and sends what is queued. Up/Down still let you edit individual queued messages; Enter saves and Esc restores the original.

Session history is saved automatically, including partial responses when you quit. Reopen Sirus to return to your conversations, and enable desktop notifications with `/notify background` to hear when attention is needed while you're away from the terminal.

### Put the right context in the prompt

Type `@` to find agents and files in one menu. The menu opens at the bottom, with the closest matches nearest the input. Agent names and the new-name option sit below file results; use ↑/↓ and Tab or Enter to select either. File search also accepts relative paths such as `@../proj/file.tsx`. Sirus includes the selected text files in your message, making it easy to point at the code you want to discuss.

Paste text and images into the same input. Pasted image paths attach directly; forwarded paste shortcuts read text or images from the clipboard. `/image /path/to/screenshot.png` also attaches a file. Clipboard and notification support depend on your operating system and terminal.

### Repository instructions

Put project guidance in `SIRUS.md` or `AGENTS.md` in the session's working directory. Sirus automatically includes it for session participants, but not spawned subagents. Subagents receive project guidance only through their parent's task instructions, except when one is started from its owner's conversation: the vendor keeps the instructions that conversation was written under, so that subagent inherits them. If both exist, `SIRUS.md` **replaces** `AGENTS.md`; they are not merged, even when `SIRUS.md` is empty or unreadable.

Guidance is read when a participant's runtime starts and stays fixed for as long as that runtime lives, so edits take effect the next time it is built, such as after `/clear`, a chat rewind, or `/memory on` or `off`. Only regular files are read, up to 32 KiB; symbolic links are rejected, including dangling links. Truncation and read errors are reported in the model's prompt. Repository guidance is subordinate to Sirus's operating contract and your request, cannot grant tool permissions, and is never included in Sirus's own internal prompts, such as the one that names a session.

Automatic discovery is limited to the session directory. Ancestor/git-root lookup, nested rules, `CLAUDE.md`, and global instruction files are not loaded automatically; agents can still inspect relevant files using tools.

### Skills

Each agent uses its own vendor's skills: Claude through Claude Code's Skill tool, GPT through Codex's skill list. A skill is a folder holding a `SKILL.md`, and the agent loads it when the task fits or when you name it.

Type `/` to find a skill: the menu lists the selected agent's skills after Sirus's own commands, with what each takes and where it comes from. `Tab` completes the name so you can add arguments, including `@file` mentions, and `Enter` sends it. Sirus hands it to the agent in its vendor's own form, `/project:deploy prod` for Claude or `$deploy prod` for Codex, so the skill runs as it would in Claude Code or Codex. A skill marked `user-invocable: false` stays out of the menu, and a Sirus command of the same name takes precedence.

| Put a skill in… | Claude sees it | GPT sees it |
| --- | --- | --- |
| `.agents/skills/` in the project, or `~/.agents/skills/` | yes | yes |
| `.claude/skills/` in the project, or `~/.claude/skills/` | yes | no |
| `.codex/skills/` in the project, or `~/.codex/skills/` | no | yes |

Project folders are read from the session's directory up to the Git root. Claude also takes your commands in `~/.claude/commands/` and the project's `.claude/commands/`, and lists your skills and commands as `user:<name>` and the project's as `project:<name>`.

Claude also loads the plugins you installed and enabled in Claude Code, as Claude Code does: their skills and commands (in the menu as `/<plugin>:<name>`), their MCP servers, and their hooks. A plugin's hooks run in every Claude session Sirus starts, and each participant, subagent, and rebuilt runtime is a session of its own, so a session-start hook runs for each. Plugin agents need Claude Code's own Agent tool, which Sirus replaces with its subagents, so they go unused.

Claude Code's bundled skills are on, except `batch`, `code-review`, `loop`, `deep-research`, and `workflow-authoring`, which are built on Claude's own agent and scheduling tools that Sirus switches off in favour of its subagents. Codex keeps its built-in skills. Claude reads its skills when its runtime starts, so a skill you add reaches a Claude participant after `/clear`, a chat rewind, or the next time Sirus opens. Codex rereads the project's folders and `~/.agents/skills` on every prompt.

### Choose how much approval you want

The mode applies to the session's participants and subagents. It is the vendor's own mode: Sirus asks each runtime to switch, and the agent decides what to ask about.

| Mode | Behavior |
| --- | --- |
| `auto` (the default) | The agent's own reviewer decides, and asks only about what it judges unsafe. |
| `ask` | The agent asks before every action that is not a read. |
| `bypass` | Nothing is asked. |

Use `/permissions` to choose a mode, or `Shift+Tab` to cycle through them. At a prompt, allow once, allow for this session, deny, or deny for this session.

Two things differ by vendor. In `ask` and `auto`, Codex runs edits and commands inside the working directory in a sandbox that can write there and reach no network, so those run without asking and only what leaves the sandbox reaches you. Claude's `auto` mode depends on the model: where the model does not support it the session falls back to asking, and the status row says so. These are tool approval controls, not an operating-system sandbox.

### Questions from the agent

When an agent needs a decision from you, it can ask instead of guessing: Claude through Claude Code's AskUserQuestion, GPT through Codex's question tool, and MCP servers through the forms they raise. The question takes the input bar's place as a card, one question at a time: pick with `↑`/`↓` and `Enter` (or a number key), toggle a multiple choice with `Space`, choose `Other…` to type your own answer, and `←` to go back. `Esc` cancels the turn, as it does for an approval. Subagents cannot ask; nobody is watching them.

### Your subscriptions, as many as you want—or an API key

Put your existing Claude and ChatGPT subscriptions to work in Sirus. Connect as many subscription accounts as you want, use an Anthropic or OpenAI API key, or mix subscriptions and keys. Add each account through `/login`; Sirus keeps them available together.

Sirus can fall back to another configured source for the same provider when a request fails. If that source is an API key, its API usage is billed by that provider.

Use `/usage` to see reported subscription allowance and how full each participant's context window is. `/logout` lets you choose a saved account or key to remove.

## Everyday controls

| Control | What it does |
| --- | --- |
| `Ctrl+N` | Start a new session. |
| `Option+↑` / `Option+↓` | Switch sessions. |
| `←` / `→` | Switch agents within the current task. |
| `Ctrl+K` | Collapse or expand the sidebar. |
| `Enter` | Send a message, or queue it while agents are busy. |
| `Ctrl+Enter` / `Ctrl+X Ctrl+S` | Send waiting messages and the draft now. |
| `Tab` | Complete the highlighted `/` command or skill. |
| `Shift+Enter` or `\` then `Enter` | Insert a new line. |
| `Esc` | Close a menu, or interrupt the turn and send queued messages. |
| `/rename <name>` | Give the current session a useful name. |
| `/thinking` | Show or change reasoning depth. |
| `/agents` | Watch, message, cancel, or clear the session's subagents. |
| `/undo` / `/rewind` | Choose what to restore from a checkpoint. |
| `/notify` | Configure desktop notifications. |
| `/doctor` | Check Bun, adapter and vendor versions, logins, data directory and git. Also available as `sirus doctor`. API key validity is not checked. |
| `/update` | Install the latest release. |
| `/help` | Show all commands and shortcuts. |
| `/exit` | Quit Sirus. |

## Local data and configuration

Sessions, settings, checkpoints, and memories are stored on your machine. Model requests still go to your chosen provider, including conversation content, attachments, tool results, and any memories used as context.

| Platform | Default data directory |
| --- | --- |
| macOS | `~/Library/Application Support/Sirus` |
| Linux | `$XDG_STATE_HOME/sirus`, or `~/.local/state/sirus` |
| Windows | `%APPDATA%\Sirus` |

Set `SIRUS_DATA_DIR` to use another location. API keys entered through Sirus are saved in local settings with restricted file permissions. For environment-based API setup, Sirus reads `ANTHROPIC_API` for Anthropic and `OPENAI_SECRET` for OpenAI.

### Optional installation statistics

The repository includes a privacy-conscious Cloudflare Worker/D1 implementation in [`cloudflare/`](cloudflare/) and a dependency-free GitHub Pages dashboard in [`stats-dashboard/`](stats-dashboard/). Released builds use the deployed Worker by default. Set `SIRUS_HEARTBEAT_URL` to override it, or set it to an empty value to disable heartbeats:

```sh
export SIRUS_HEARTBEAT_URL=https://your-worker.your-subdomain.workers.dev/heartbeat
# Disable the optional heartbeat:
export SIRUS_HEARTBEAT_URL=
```

Sirus then creates a random per-installation ID in its local data directory and sends at most one heartbeat every 24 hours. The payload contains only that ID and the Sirus version. The Worker HMAC-hashes the ID before storage, derives timestamps from its server clock, and retains records for 35 days. Network failures never block startup. Counts are estimates because the public endpoint can be submitted by arbitrary clients.

On macOS, if memory reports that it cannot load `sqlite-vec`, install SQLite with `brew install sqlite`, or set `SIRUS_SQLITE_LIBRARY` to your SQLite dynamic library path.

## Install & run

Choose npm or Bun to install Sirus. Node.js 18 or later is required by the `sirus` launcher with either option.

**With npm:**

```sh
npm install -g sirus-harness
```

The npm package includes the Bun runtime, so a separate Bun installation is not required.

**With Bun 1.3.12 or later:**

```sh
bun install -g sirus-harness
```

**Run in your current directory:**

```sh
sirus
```

**Or open a specific project:**

```sh
sirus /path/to/your/project
```

Keep Git available for automatic file checkpoints. Once Sirus opens, use `/login` to connect your subscriptions or API keys, then `/model` to choose a model.

Sirus is open source under the [MIT license](LICENSE).
