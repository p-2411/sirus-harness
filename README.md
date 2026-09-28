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

You or an agent can create a named participant by mentioning a new name followed by a supported model and a prompt:

```text
@reviewer claude-sonnet-5 Read the uncommitted changes in this project and review them for bugs and missing tests.
```

For an agent, put the introduction in a normal prose paragraph of its reply. The new participant appears in the header and receives that reply after the sender finishes, with the sender's name attached. It starts with that message rather than the sender's history, and the user's selected conversation stays in place. Mentions inside code, quotes, lists, or other Markdown examples do not create or invoke agents.

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

Subagents work in the project directory itself by default, so assignments should avoid overlapping edits. An agent can ask for a Git worktree instead: the subagent then works on a branch named after the run and cut from your project's HEAD, so its edits meet neither yours nor another subagent's. Uncommitted changes and ignored files are not carried over. The report names the branch, and merging or inspecting it is yours or the spawning agent's to do. A worktree the subagent left unchanged is removed when it ends, with its branch; one it changed stays in Sirus's data directory, deleting the session included, and its branch stays in your repository. A project that is not a Git repository gets no worktree, and its subagents work in the project directory. A repository must have a commit before a worktree can be created. If Git cannot inspect the repository or create the worktree, the subagent is not started.

Named participants are collaborators you can address and follow in the chat; subagents receive only their delegated task and report back to the agent that spawned them, though an agent can also start one from its own conversation so far when the task depends on what you have already established. While a subagent runs, its owner can ask it for its status, send it further instructions, or stop it. `Esc` cancels the session's turn and any subagent setup still in progress; subagents already running keep working. A subagent whose agent has reported nothing for 15 minutes, not counting time spent waiting on your approval or inside a tool call that is still running, such as a long build, is taken as hung and stopped, and its report says so.

You can follow them yourself. A subagent goes by the name its agent gave it, or by its id when it was given none, on the strip, in `/agents`, on its row and on its approval prompts. The strip above the status row shows one line, for the selected agent's subagent that changed last: its name, its model, how long it has been running, its latest tool call, its task, and its branch, with a counter such as `1/3` when others are behind it. Press `↓` from the input bar to step onto the strip; the order is fixed as you arrive, `↑`/`↓` walk it, `enter` opens that subagent's actions, and `↑` past the first line or `Esc` hands the keyboard back to your draft. A subagent that ends keeps its line for a second, dimmed, saying how it ended, and is then off the strip. `/agents` lists the session's subagents and offers to show one's record, send it a message, cancel it, or dismiss its line. Runs are saved with the session: one still working when you quit comes back marked interrupted, with its record, and its report reaches its owner on your next prompt. Nothing restarts on its own.

A subagent inherits its owner's model and reasoning depth unless the spawning agent selects another. Use `/model subagent <model>` to fix the subagent model for the session, `/model subagent` to see it, and `/model subagent default` to restore the default behavior.

### Explore with an undo button

Sirus captures a checkpoint before each turn. Use `/undo` for the last turn or `/rewind` to choose an earlier checkpoint, then restore files, chat, or both.

```text
/undo files
```

This restores the files while keeping the conversation, letting you discuss what happened and try another approach. Checkpoints live in a separate Git repository in Sirus's local data directory, leaving your project's Git history and staging area untouched.

File restoration puts back only the files the agents changed since the checkpoint, and leaves any file you changed as it is; `/undo` and `/rewind` list what they would restore before you confirm. Restoring the chat continues in a new conversation from that point, and the original stays as it was. Neither undoes external effects such as deployments or database changes.

Restoring the chat is refused while any of the session's subagents is still starting or working, and the conversation it continues in starts with none of them. Restoring files is refused only while a subagent is working in the project directory itself, or another session is busy there; a subagent in its own worktree is out of the way. Wait for the subagents to end, or cancel them with `/agents`, then try again.

### Memory that survives a new chat

Sirus can remember durable preferences and project decisions, then retrieve them by meaning in later sessions. Global memories carry preferences across projects; project memories stay scoped to the session's directory.

Memory is enabled by default. Ask Sirus to remember, update, or forget something, use `/memory list` to see what is remembered and `/memory forget <name>` to remove one, or `/memory off` to disable agent access. Memories are stored locally.

### Context that compacts itself

Long sessions fill the model's window. Each participant's runtime folds its own conversation when its window fills, the way Claude Code and Codex do on their own, including in the middle of a very long turn. Sirus records where that happened: a `context compacted` rule appears in that participant's part of the chat, with the summary the runtime reported.

Use `/compact` to ask for it now, optionally followed by what the summary should keep. Claude Code uses those instructions; Codex compacts without them, and Sirus says when it ignores them. There is nothing to turn on or off: compaction belongs to the runtime. `/undo` and `/rewind` treat the rule like any other entry, and rewinding the chat to before one puts the whole conversation back.

### Keep several tasks moving

Create sessions, name them, and switch between them from the sidebar. Each session retains its working directory, conversation, participants, model choices, and permission mode. Existing sessions keep their model settings when you change models elsewhere.

Press Enter while an agent is busy to queue a follow-up. Text reaches the agent after its tool calls finish, or starts the next turn if it is only writing. Commands and images wait until the turn ends; queued commands also need their session open with the input ready. Model, thinking, permission, status, and worker controls run immediately. Ctrl+Enter (or Ctrl+X Ctrl+S) sends waiting messages and your draft now. Esc interrupts and sends what is queued. `↑` takes the messages waiting for the selected agent back into your draft, preserving their text and image order, to edit and send again. A queued prompt that fails before it is accepted stays queued for you to edit or retry with Send now.

Session history is saved automatically, including partial responses when you quit. Sirus opens on a fresh draft by default; choose a saved conversation in the sidebar or with `/resume`. Start it with `--continue` to reopen the latest conversation in this directory, or `--resume <query>` to match a name or id. Desktop notifications tell you when attention is needed while the terminal is not focused; that is the default, and `/notify always` or `/notify off` changes it.

### Put the right context in the prompt

Type `@` to find agents, files and folders in one menu. The menu opens at the bottom, with the closest matches nearest the input. File results sit below the agent names and the new-name option, and take the selection once they arrive; use ↑/↓ and Tab or Enter to select either. File search also accepts relative paths such as `@../proj/file.tsx`. Sirus includes the selected text files in your message, and for a folder what it holds, one level deep, making it easy to point at the code you want to discuss: up to 10 files and folders, 256 KiB each and 512 KiB together.

A mention counts, and the menu opens, only in ordinary prose, not in a list item, heading, block quote, table, code or quoted text. A path ends at the first whitespace, quote, backtick, or any of `< > ( ) [ ] { } , ;`; the menu writes a path that needs it in double quotes, such as `@"my notes.txt"`.

Paste text and images into the same input. Pasted image paths attach directly; forwarded paste shortcuts read text or images from the clipboard. `/image /path/to/screenshot.png` also attaches a file. Clipboard and notification support depend on your operating system and terminal.

### Repository instructions

Each agent loads its own vendor's instruction files, as it would in Claude Code or Codex: Claude its `CLAUDE.md` files, GPT its `AGENTS.md` files. Sirus does not read them or add them to the prompt itself.

It adds one note for Claude. When a project keeps its instructions only in `AGENTS.md`, with an `AGENTS.md` in the session's directory or a parent up to the Git root and no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` in any of them, Sirus tells Claude where those files are and to follow them as it would `CLAUDE.md`, so Claude and GPT in one session work from the same instructions. Subagents on Claude get the note too. A subagent in a worktree sees the project's instruction files as they are committed at your HEAD, since uncommitted changes are not carried over.

The runtime Sirus uses to name a session reads no project instructions.

### Skills

Each agent uses its own vendor's skills and slash commands, found where Claude Code or Codex would find them: Claude its skills, commands and enabled plugins, GPT its Codex skills and built-in commands. Each also gets the other vendor's skills it lacks: a Claude participant those in `.agents/skills` and `.codex/skills` (the project's, up to the Git root, and yours) and in third-party Codex plugins you enabled, and a GPT participant those in `.claude/skills` and in third-party Claude plugins you enabled that have a description and that the model may invoke; none that shares a name with one it has already. Sirus links them from a folder under its data directory, and neither vendor's own folders change.

Type `/` to find one: after Sirus's own commands, the menu lists what each vendor represented in the session last reported, tagged `claude` or `codex`, with what each takes. The list is the one last reported for that vendor in the session's directory, kept on disk, so once a runtime has run there the menu has it before the first prompt; a skill you add appears once the runtime reports its list again. `Tab` completes the name so you can add arguments, including `@file` mentions, and `Enter` sends it. Sirus hands it to the agent as the vendor's own terminal would, `/deploy prod` for Claude or `$deploy prod` for a Codex skill, so it runs as it would in Claude Code or Codex. A Sirus command of the same name takes precedence; use `/claude:name` or `/codex:name` to reach a vendor command with that name. Reporting commands with no arguments run aside and leave no turn in the transcript. A few vendor commands stay out of the menu, including `/effort`, which would change the reasoning depth behind `/thinking`'s back, and Claude's internal session commands.

Codex on an OpenAI key, or on any ChatGPT account after the first you signed in with, runs in a profile of its own under Sirus's data directory. Sirus links the skills in your `~/.codex/skills` (or `$CODEX_HOME/skills`) into that profile, so Codex finds them there too.

Claude loads your settings, plugins and hooks as Claude Code does. Each participant, subagent and rebuilt runtime is a Claude session of its own, so a session-start hook runs for each. Plugin agents need Claude Code's own Agent tool, which Sirus switches off in favour of its subagents, so they go unused.

Claude Code's bundled skills are on, except `batch`, `code-review`, `loop`, `deep-research` and `workflow-authoring`, which are built on tools Sirus switches off: Claude Code's own agents, workflows and remote triggers, since delegation here goes through Sirus's subagents, and its scheduling and monitoring tools, which start turns Sirus never asked for. Codex keeps its built-in skills, with its own subagents switched off. Claude reads its skills when its runtime starts, so a skill you add reaches a Claude participant after `/clear`, a chat rewind, or the next time Sirus opens. Codex rereads the project's folders and `~/.agents/skills` on every prompt.

### Choose how much approval you want

The mode applies to the session's participants and its subagents, including those already running. It is the vendor's own mode: Sirus asks each runtime to switch, and the agent decides what to ask about.

| Mode | Behaviour |
| --- | --- |
| `auto` (the default) | The agent's own reviewer decides, and asks only about what it judges unsafe. |
| `ask` | The agent asks before every action that is not a read, except what Codex runs in its sandbox (below). |
| `bypass` | Nothing is asked. |

Use `/permissions` to choose a mode, or `Shift+Tab` to cycle through them. At a prompt, choose one of the options the agent offers, in its own words, such as allowing once, allowing without asking again, or denying.

Two things differ by vendor. In `ask` and `auto`, Codex runs edits and commands inside the working directory in a sandbox that can write there and reach no network, so those run without asking and only what leaves the sandbox reaches you. Claude's `auto` mode depends on the model: where the model does not support it the session falls back to asking, and the status row says so. Codex's sandbox aside, these are tool approval controls, not an operating-system sandbox.

### Questions from the agent

When an agent needs a decision from you, it can ask instead of guessing: Claude through Claude Code's AskUserQuestion, GPT through Codex's question tool, and MCP servers through the forms they raise. The question takes the input bar's place as a card, one question at a time: pick with `↑`/`↓` and `Enter` (or a number key), toggle a multiple choice with `Space`, choose `Other…` to type your own answer, and `←` (`Shift+Tab` while typing) to go back. `Esc` declines the question, as it declines an approval, and the turn goes on. Subagents cannot ask; nobody is watching them.

### Your subscriptions, as many as you want—or an API key

Put your existing Claude and ChatGPT subscriptions to work in Sirus. Connect as many subscription accounts as you want, use an Anthropic or OpenAI API key, or mix subscriptions and keys. Add each account through `/login`; Sirus keeps them available together.

Sirus can fall back to another configured source for the same provider when a request fails. If that source is an API key, its API usage is billed by that provider.

Use `/usage` to see reported subscription allowance and how full each participant's context window is. `/logout` lets you choose a saved account or key to remove.

## Everyday controls

| Control | What it does |
| --- | --- |
| `Ctrl+N` | Focus the draft session. |
| `Option+↑` / `Option+↓` | Switch sessions. |
| `←` / `→` | Switch agents within the current task. |
| `Ctrl+B` | Collapse or expand the sidebar. |
| `Enter` | Send a message, or queue it while agents are busy. |
| `Ctrl+Enter` / `Ctrl+X Ctrl+S` | Send waiting messages and the draft now. |
| `Tab` | Complete the highlighted `/` command or skill. |
| `Shift+Enter` or `\` then `Enter` | Insert a new line. |
| `Esc` | Close a menu, or interrupt the turn and send queued messages. |
| `/rename <name>` | Give the current session a useful name. |
| `/thinking` | Show or change reasoning depth; `default` leaves it to the model. |
| `/agents` | Watch, message, cancel, or clear the session's subagents. |
| `/tasks` | Inspect background commands started by the vendors. |
| `/undo` / `/rewind` | Choose what to restore from a checkpoint. |
| `/notify` | Configure desktop notifications. |
| `/doctor` | Check Bun, adapter and vendor versions, logins, data directory and git. Also available as `sirus doctor`. API key validity is not checked. |
| `/update` | Install the latest release with `npm install --global`. |
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

The repository includes a privacy-conscious Cloudflare Worker/D1 implementation in [`cloudflare/`](cloudflare/) and a dependency-free GitHub Pages dashboard in [`stats-dashboard/`](stats-dashboard/). Every build, released or run from source, sends its heartbeat to the deployed Worker by default. Set `SIRUS_HEARTBEAT_URL` to send it elsewhere, or set it to an empty value to disable heartbeats; a URL that is not HTTPS, other than plain HTTP to localhost, disables them too:

```sh
export SIRUS_HEARTBEAT_URL=https://your-worker.your-subdomain.workers.dev/heartbeat
# Disable the optional heartbeat:
export SIRUS_HEARTBEAT_URL=
```

When heartbeats are on, Sirus creates a random per-installation ID in its local data directory and sends at most one heartbeat every 24 hours, when it starts. The payload contains only that ID and the Sirus version. The Worker HMAC-hashes the ID before storage, derives timestamps from its server clock, and retains records for 35 days. Network failures never block startup. Counts are estimates because the public endpoint can be submitted by arbitrary clients.

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

`/update` installs a newer release with `npm install --global` whichever way you installed Sirus, so a copy installed with Bun is left in place and the new release is installed through npm beside it.

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
