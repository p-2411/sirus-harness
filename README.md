# Sirus

**Your terminal. Your models. A team that can get the work done.**

Sirus is a local-first terminal harness for AI coding agents. Bring Claude and GPT into the same conversation, give them access to your project, and move from a question to an inspected, implemented, and tested change without leaving your terminal.

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

1. Type `/login` and choose Claude or ChatGPT, then sign in with an existing subscription or enter an API key through the masked input. Repeat `/login` to connect more accounts—as many as you want.
2. Type `/model` and select a model from the provider you connected.
3. Give Sirus a task:

```text
Explore this project, explain how it fits together, and show me where to start.
```

Or go straight to a change:

```text
Find why the tests are failing, fix the underlying issue, and run the relevant tests.
```

Type `/` to browse commands, or `/help` for the full command and keyboard reference. Provider access and model availability depend on the account you connect.

## What you can do with it

| When you need to… | Try asking Sirus… |
| --- | --- |
| Understand an unfamiliar codebase | “Trace a request from the entry point to the database. Explain the main components and where changes usually belong.” |
| Ship a feature | “Add pagination to this endpoint, follow the existing conventions, and test the edge cases.” |
| Debug a stubborn problem | “Reproduce this failure, find the root cause, and make the smallest fix that addresses it.” |
| Get another perspective | “Review the changes above for correctness and regressions. Point to concrete issues in the code.” |
| Divide up a larger task | “Delegate an inspection of the API and an inspection of its tests to separate subagents, then combine their findings into a plan.” |
| Work from visual context | Attach a screenshot and ask: “Find the component responsible for this layout and fix the spacing.” |
| Carry decisions into future sessions | “Remember for this project: database changes need a migration and a rollback plan.” |

Agents can read, search, create, and edit files, run shell commands and tests, and use provider-supported web search and page access. Your prompts set the scope: ask for an explanation, a review, or an implementation.

## What makes Sirus different

### Claude and GPT, in one conversation

Choose the model for each participant and adjust its reasoning depth. Bring in a second model to review an implementation or challenge a design while keeping the conversation in one place.

Create a named participant by mentioning a new name followed by a supported model and a prompt:

```text
@reviewer claude-sonnet-5 Review the changes above for bugs and missing tests.
```

Then address that participant by name:

```text
@reviewer Check whether the latest fix resolves the issues you found.
```

Participants share the session history and can mention each other to request input. Set a participant's model with `/model @reviewer <model>` and reasoning depth with `/thinking @reviewer high`. Use `/model` to see the model names supported by your installation.

### Delegate work, follow the results

For work that can be split into independent tasks, Sirus can spawn autonomous subagents and collect their findings. Each receives a focused assignment and returns a final report with a summary of its changes. You can follow their activity in the interface while the parent agent coordinates the work.

Named participants are collaborators in the shared conversation; subagents receive only their delegated task. Subagents work in the same project directory, so assignments should avoid overlapping edits.

### Explore with an undo button

Sirus captures a checkpoint before each turn. Use `/undo` for the last turn or `/rewind` to choose an earlier checkpoint, then restore files, chat, or both.

```text
/undo files
```

This restores the files while keeping the conversation, letting you discuss what happened and try another approach. Checkpoints live in a separate Git repository in Sirus's local data directory, leaving your project's Git history and staging area untouched.

File restoration covers the checkpointed directory, including your own edits since the snapshot. It respects Git's tracked and ignored file rules; it does not undo external effects such as deployments or database changes.

### Memory that survives a new chat

Sirus can remember durable preferences and project decisions, then retrieve them by meaning in later sessions. Global memories carry preferences across projects; project memories stay scoped to the session's directory.

Memory is enabled by default. Ask Sirus to remember, update, or forget something, or use `/memory off` to disable agent access. Memories are stored locally.

### Keep several tasks moving

Create sessions, name them, and switch between them from the sidebar. Each session retains its working directory, conversation, participants, model choices, and permission mode. Existing sessions keep their model settings when you change models elsewhere.

Send a follow-up while an agent is busy to queue it. Session history is saved automatically, including partial responses when you quit. Reopen Sirus to return to your conversations, and enable desktop notifications with `/notify background` to hear when attention is needed while you're away from the terminal.

### Put the right context in the prompt

Type `@` to find agents and files in one menu. The menu opens at the bottom, with the closest matches nearest the input. Agent names and the new-name option sit below file results; use ↑/↓ and Tab or Enter to select either. File search also accepts relative paths such as `@../proj/file.tsx`. Sirus includes the selected text files in your message, making it easy to point at the code you want to discuss.

Attach an image with `Ctrl+V` or `/image /path/to/screenshot.png` to work from a screenshot, mockup, or visual bug report. Clipboard and notification support depend on your operating system and terminal.

### Choose how much approval you want

Permission settings apply to the session's participants and subagents:

| Mode | Behavior |
| --- | --- |
| `auto` — default | Allows ordinary work, checks shell commands, and prompts for operations classified as sensitive or requiring review. |
| `ask` | Prompts before file writes, shell commands, and spawning agents. |
| `bypass` | Runs tool calls without approval prompts. |

Use `/permissions` to choose a mode, or `Shift+Tab` to cycle through them. At an approval prompt, allow once, allow eligible operations for the session, or deny. These are tool approval controls, not an operating-system sandbox.

### Your subscriptions, as many as you want—or an API key

Put your existing Claude and ChatGPT subscriptions to work in Sirus. Connect as many subscription accounts as you want, use an Anthropic or OpenAI API key, or mix subscriptions and keys. Add each account through `/login`; Sirus keeps them available together.

Sirus can fall back to another configured source for the same provider when a request fails. If that source is an API key, its API usage is billed by that provider.

Use `/usage` to see reported subscription allowance, session token usage, and context usage. `/logout` lets you choose a saved account or key to remove.

GPT-6 Astra requests a 1,050,000-token Codex window with automatic compaction at 900,000 tokens. Codex reserves headroom, so its usable window can be smaller; the context gauge always prefers the runtime's reported limit. Other models retain their existing settings. Restart Sirus after upgrading to apply the new thread configuration. Local configuration does not override provider-side availability or limits.

## Everyday controls

| Control | What it does |
| --- | --- |
| `Ctrl+N` | Start a new session. |
| `Option+↑` / `Option+↓` | Switch sessions. |
| `Ctrl+K` | Collapse or expand the sidebar. |
| `Enter` | Send a message, or queue it while agents are busy. |
| `Shift+Enter` or `\` then `Enter` | Insert a new line. |
| `Esc` | Close a menu or cancel the current session's turn. |
| `/rename <name>` | Give the current session a useful name. |
| `/thinking` | Show or change reasoning depth. |
| `/undo` / `/rewind` | Choose what to restore from a checkpoint. |
| `/notify` | Configure desktop notifications. |
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
