# Day 2–3: connect your accounts, try one task

Prepared 2026-09-07 from the local README, command handlers and provider routing code. This is publishable copy plus internal source notes; it is not a report of an authenticated test or an acquired user.

## X how-to post

271 weighted characters, counting the HTTPS URL as 23 characters. All other characters are ASCII. Publish only the text inside the block.

```text
Your Claude + ChatGPT accounts, one terminal.

In your project:
npm install -g sirus-harness
sirus
/login: pick a provider, then Subscription.
Repeat for each account. /model: pick a model.

First task: Explain this project without editing files.

https://trysirus.com/?utm_source=x&utm_medium=social&utm_campaign=first10&utm_content=day23_setup
```

## Fuller reply / account setup guide

Sirus brings your existing Claude and ChatGPT subscriptions into one terminal, including multiple accounts from the same provider. Here's a small first session to try.

You need Node.js 18 or later, Git for file checkpoints, and access to a supported provider. Install and open a familiar project:

```sh
npm install -g sirus-harness
sirus /path/to/your/project
```

Replace the path with your project directory. The npm package includes the Bun runtime.

1. Inside Sirus, type `/login`. Choose **Claude** or **ChatGPT**, then **Subscription**. Complete the provider's sign-in flow. Check the account shown in the success message. The first connection may recognize a provider account already signed in on your machine.
2. Repeat `/login` for your other provider or another account with the same provider. Select the intended account when the browser asks you to sign in. Each connection stays saved in Sirus.
3. Type `/usage` to check the connected account rows and any allowance information the providers report.
4. Type `/model` and choose a model for a provider you've connected. The menu lists models supported by Sirus; access still depends on your provider account.
5. Send one small task:

```text
Explain how this project starts up. Read the relevant files, name the main entry point, and show me the next two files to read. Do not change files or run commands that modify the project.
```

For approval prompts before writes or shell commands, first use `/permissions ask`. The task above requests a read-only explanation; it is not a separate sandbox mode.

When the answer finishes, you can use `/model` again to choose a model from your other connected provider and continue in the same Sirus conversation:

```text
Using the conversation above, trace one example request through those files. Do not edit anything.
```

`/model` selects the model; it does not choose a specific saved account. Sirus routes requests among configured sources for that provider and can fall back when a source fails. `/logout` lets you choose a saved account or key to remove.

Your provider subscriptions and usage limits stay separate. If you also configure API keys, fallback to an API source can incur that provider's API charges. Sirus keeps the conversation you create here together; this setup does not import your old Claude or ChatGPT website chats.

Did you connect the accounts you intended and get a useful explanation? Reply with the step that worked or where you got stuck. An error message, operating system, terminal and Sirus version help; leave out credentials and private code. There's no survey or meeting to book.

Install and examples: https://trysirus.com/

## Internal evidence and publishing limits

| Claim / behavior | Source reviewed |
| --- | --- |
| Node 18+, install command, current/project directory launch, bundled Bun, Git checkpoints | [README.md](../README.md), lines 13–25; [package.json](../package.json), `engines` and `bin` |
| `/login` opens provider choice, then Subscription or masked API key input | [authentication/behavior.ts](../src/commands/authentication/behavior.ts), lines 17–67 |
| Repeated sign-in creates another provider profile; first login can reuse existing provider-runtime authentication | [providers/login.ts](../src/agent_runtime/providers/login.ts), lines 15–16, 116–134 and 171–205 |
| Additional subscription profiles use separate provider runtime directories | [providers/profiles.ts](../src/agent_runtime/providers/profiles.ts), `subscriptionEnvironment` |
| Saved subscriptions are added to the provider's source list | [providers/provider.ts](../src/agent_runtime/providers/provider.ts), lines 221–228 |
| `/usage` renders a row for each configured source and calls provider allowance reporting for subscriptions | [authentication/behavior.ts](../src/commands/authentication/behavior.ts), lines 108–118 and `usageCommand` |
| `/model` menu lists supported models; selection updates a participant's model, not an account | [agents/behavior.ts](../src/commands/agents/behavior.ts), lines 70–109; [agents/commands.ts](../src/commands/agents/commands.ts), `modelCommand` |
| No explicit account-selection command exists in the command registry | [registry.ts](../src/commands/registry.ts), lines 34–52 |
| Account routing prioritizes configured source type, remembers a successful source for the participant runtime, and tries remaining sources after failure | [providers/provider.ts](../src/agent_runtime/providers/provider.ts), lines 239–301 |
| `/logout` opens a saved-source picker and removes the selected source | [authentication/behavior.ts](../src/commands/authentication/behavior.ts), lines 76–105 |
| Same-conversation model changes are supported; named participants and delegated subagents have different context scopes | [README.md](../README.md), “Claude and GPT, in one conversation” and “Delegate work, follow the results” |
| Provider charges and source fallback are documented; provider limits are not overridden | [README.md](../README.md), lines 124–132 |

### Usability findings for the founder

- **Manual account choice is a gap.** Do not say “switch accounts with `/model`” or promise a named account picker. The code provides account addition, usage rows, source removal and automatic routing. A manual account selector would need product work.
- **Model visibility is broader than entitlement.** `/model` lists supported models without filtering to a connected account's access. A beginner can select a provider they have not connected. The guide explicitly tells them to choose a connected provider.
- **Adding the same browser account twice is possible in the reviewed code.** New logins are deduplicated by profile, not email. Checking the success message and `/usage` matters when adding several accounts. This is a code observation, not a reproduced live failure.
- **The first provider connection can silently reuse an existing runtime login.** The sign-in function checks provider account status first. The guide tells readers to inspect the success message rather than assuming every `/login` opens a fresh browser sign-in.
- **“Read-only” is a task instruction.** `/permissions ask` adds approval prompts; it is not an operating-system sandbox. Do not call this a guaranteed isolated demo.

Keep “all subscriptions” scoped to the supported Claude and ChatGPT subscription accounts. Do not promise Gemini support, pooled quotas, combined billing, imported past web chats, provider endorsement, or unlimited usage. No authenticated model calls, credentials, provider stores, or live account data were accessed to prepare this guide.
