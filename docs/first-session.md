# Your first useful session with Sirus

Bring one small bug, change, or code question from a project you know. The first task is to reach a result you can inspect, then ask another model to review it in the same conversation.

## Start Sirus

You need Node.js 18 or later, Git for checkpoints, and access to a supported provider. Sirus is MIT licensed; your chosen provider's access requirements and usage charges still apply.

```sh
npm install -g sirus-harness
sirus /path/to/your/project
```

Replace the project path with your own. Use a project where you are comfortable allowing file edits, or start with a read-only review.

Inside Sirus, type `/login` to connect a provider. Repeat for your other provider if you want Claude and GPT in the same session. Enter keys only through the masked login input. Use `/model` to see available models and pick your starting model.

## Give it one task

Replace the bracketed description before sending:

```text
Investigate [the bug or failing test]. First reproduce it and explain the cause. Then make the smallest fix and run the relevant checks. Tell me what changed and what you could not verify.
```

For a read-only start:

```text
Review this project's most recent commit for a concrete regression. Read the relevant code and tests without changing files. If you find an issue, explain a reproducible failure; otherwise say what you checked and what remains uncertain.
```

## Add another perspective

Type `/model` to find the exact model identifier for the other provider. In the following prompt, replace `MODEL_ID` with that identifier. Do not send the placeholder literally.

```text
@reviewer MODEL_ID Review the work above against the original task. Read the changed code and relevant tests. Focus on concrete correctness problems and missing edge cases. Do not edit files. If you find no issue, say so and explain what you checked.
```

Sirus creates a named participant in the same conversation. The read-only request is a task instruction; use `/permissions ask` if you also want approval prompts before writes and shell commands. Review the findings yourself and give the original participant any follow-up. Ask one participant at a time to edit overlapping files.

With only one connected provider, you can still complete the first task and request a review using an available model. A cross-provider review requires both providers to be connected.

## Decide whether it helped

A useful result is a change with relevant checks that you accept, or an explanation/review that helps you take a concrete next step. Two models agreeing is not proof of correctness. Read the diff and test output.

If you want to restore the checkpoint before the latest turn, `/undo files` restores checkpointed files while keeping the chat. It can also overwrite your own edits made after that snapshot. It does not reverse external effects.

## Tell us what happened

[Open feedback or an installation issue](https://github.com/p-2411/sirus-harness/issues/new/choose). Include:

- Your operating system, terminal, and Sirus version (`npm list -g sirus-harness --depth=0`).
- What you tried and what happened, including a short error if relevant.
- Whether you reached a useful result and would try a second task.

Remove keys, tokens, private code, and personal information before sharing. GitHub issues are public. If you arrived through an invitation, replying to that conversation is also useful.

If you see a Bun runtime error, the bundled runtime may not have installed; follow the [installation notes](../README.md#install--run). For unavailable models or login issues, record the provider and error without credentials. On macOS, SQLite memory setup may require the [configuration steps](../README.md#local-data-and-configuration).
