# Native vendor session recovery

Participants and background workers now reopen their Claude Code session or Codex thread after Sirus restarts or an adapter is lost. A successful resume receives only the next prompt. If recovery fails, Sirus displays the reason and uses its existing bounded conversation recap.

This change was rebased over A2's per-session storage and A3's runtime recovery, warmup, model-switch warnings and bounded recaps. Dependencies were linked from the original checkout; none were installed.

## Changes by file

| File | Change |
| --- | --- |
| `src/agent_runtime/runtime/runtime.ts` | Exposes the vendor session ID and accepts an optional ID/directory to resume. |
| `src/agent_runtime/runtime/acp.ts` | Prefers advertised `session/resume`, falls back to `session/load` when only load is supported, restores mode/model/thinking, exposes fork IDs and suppresses replayed transcript updates. Preserves configuration, usage, commands and background-task updates. |
| `src/agent_runtime/types.ts` | Defines the persisted native-session reference, including vendor, session ID, directory, credential source ID, profile home and system-prompt hash. |
| `src/agent_runtime/agent.ts` | Captures participant and fork references, prioritizes the saved credential, resumes on restart/process loss/retry, and reports recap fallback. Separates process disposal from deliberate history invalidation. Keeps restored handles through tab changes and cancelled startup. |
| `src/agent_runtime/providers/profiles.ts` | Resolves a credential's profile home without creating it, so a deleted profile is detected before ordinary startup recreates directories. |
| `src/agent_runtime/tools/subagents/index.ts` | Saves the live worker's native reference with each worker record. |
| `src/agent_runtime/tools/subagents/run.ts` | Restores that reference before SendMessage continuation; discards it when a cleaned worktree is replaced. |
| `src/agent_runtime/session/index.ts` | Clears native references from Sirus chat forks, including rewinds, to prevent appending to the original vendor session or recovering later messages. |
| `src/persistence/sessions.ts` | Validates and preserves native references for participants and workers in A2's per-session files, while accepting older snapshots without them. |
| `tests/support/runtime.ts` | Adds opt-in native IDs and resume behavior to scripted runtimes. |
| `tests/data/data.test.ts` | Covers ACP resume/load, replay timing, configuration, forks, participant/worker recovery, missing sessions/directories/profiles/credentials, cancelled startup, tab changes and credential fallback. |
| `tests/data/persistence.test.ts` | Checks participant and worker native-reference round trips through per-session storage. |
| `tests/data/session_checkpoints.test.ts` | Checks native-session independence for fork, rewind and clear, while the original conversation remains resumable. |
| `docs/ARCHITECTURE.md` | Documents native recovery and invalidation rules. |

## Decisions

- Both bundled adapters advertise resume. Claude locates its transcript using the original working directory. Codex resumes its thread log with history replay disabled. Resume responses need not contain a session ID, so Sirus retains the requested ID.
- Native history replay never becomes a second copy of the Sirus transcript. The client also drains pending SDK notification handlers before enabling new transcript output.
- Successful native recovery is warm. Owner-context worker forks are persisted as their own vendor sessions.
- The saved credential is tried first. Another credential can reuse the session when it uses the same profile home. A missing credential, changed/missing profile home, missing session directory, missing session or vendor refusal triggers a fresh runtime with a notice. Logs are not copied across credential homes.
- A compatible live model change preserves the session. An incompatible/refused model change, a change without a live session to apply it to, rewind, clear or a system-prompt change starts fresh. The prompt hash detects changes across Sirus restarts, including memory settings.
- Sirus chat forks start independent vendor sessions from the recap. They must never share the original native ID; owner-context worker forks still use ACP's real fork operation.

## Verification

`bun run typecheck` passed. `bun test tests` passed with **590 tests, 0 failures**, then passed again with `FORCE_COLOR=1`. Both runs used scratch `HOME` and `SIRUS_DATA_DIR`. Existing test files were extended; no new test files were created.

Real Ink TUI checks ran in tmux with scratch Sirus data directories and throwaway Git projects. Only `settings.json` was copied from the real Sirus data directory. The actual configured vendor homes supplied authentication and stored the vendor conversations.

| Vendor | Participant restart recall | Background worker restart recall | Missing-session fallback |
| --- | --- | --- | --- |
| Claude Code / `claude-sonnet-5` | Exact earlier tool-only label recalled; native ID unchanged | Exact earlier tool-only label recalled; fork ID unchanged | Participant and worker show `Resource not found`, then start fresh |
| Codex / `gpt-5.6-luna` | Exact earlier tool-only label recalled; native ID unchanged | Exact earlier tool-only label recalled; fork ID unchanged | Participant and worker show `no rollout found`, then start fresh |

Before each successful recall, the files were removed and Sirus exited and relaunched. The labels did not appear in earlier assistant replies. Recall used only SendMessage/WaitAgent (plus Claude's tool discovery); neither participant read files or ran shell commands, and neither worker used any tools. Both workers had originally been created as background owner-context forks.

Scratch evidence remains at `/tmp/sirus-native-live-8lh5_q3e`: `claude-facts/before.json`, `claude-facts/after.json`, `gpt-facts/before-printed.json`, `gpt-facts/after-printed.json`, their verification summaries and the Codex TUI capture. The `claude/data` and `gpt/data` scratch snapshots contain the missing-session fallback notices. Final automated logs are in `/tmp/sirus-native-verified.iICdW1`.

Two smoke-test issues were resolved before claiming proof. Initial instructions called the fixtures secrets and forbade revealing them, which caused refusals. An initial Codex read returned only a success boolean to the model, although the nested tool output appeared in the UI; the corrected check explicitly printed file contents into the model's tool result. A premature second Codex launch also demonstrated active-writer refusal and recap fallback; the successful proof confirmed the first TUI had exited before relaunching.

Live account revocation and a real adapter ignoring cancellation for 30 seconds were not induced. Credential changes, process-loss recovery, and startup cancellation were verified with scripted runtimes; the live proof covers clean process restart and actual vendor resume refusals. No push or pull request is part of this change.
