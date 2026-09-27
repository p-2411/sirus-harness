# Wave C parity audit

## Landing status

- C1 input editor and mentions: landed on local `main` as `7431a60`.
- C3 doctor and update notice: landed on local `main` as `2796037`.
- C1 slash-menu findings 4.6–4.8 await B2 on local `main`.
- C2 findings 6.1–6.8 await B1 on local `main`; its worktree has not been started.
- C3 vim mode and status-line customization remain pending their C1/B2 dependencies.

The completed changes use separate `c1-input` and `c3-tools` worktrees cut from local
`main`, with symlinked `node_modules`. Nothing was pushed and no PR was created.

## C1: input editor and mentions

Findings 4.1–4.5 and 4.9–4.11 are implemented. None was already fully fixed. Wave A
already provided steering/queue behavior and a busy-state hint, but the placeholder,
border and cursor still made the editor appear disabled.

Reproduction used the current implementation and existing tests before changes. A real
150-column tmux session showed `@read` selecting participant creation ahead of
`README.md`. Tests explicitly expected unknown `@words` to reject the message.

Changes by file:

| File | Change |
| --- | --- |
| `src/frontend/chat/InputBar.tsx` | Collapse pastes over 1,000 characters or 10 lines; cap visible draft rows; visual-row navigation; directory history/search; pasted image paths; shortcuts; external editing; live input styling. Full pasted text remains in the session draft and is expanded on send. |
| `src/frontend/chat/editor.ts` | Shared grapheme/display-width row layout for rendering and vertical movement. |
| `src/frontend/chat/DraftText.tsx` | Render rows with a highlighted character cursor and image/paste chips. |
| `src/frontend/chat/externalEditor.ts` | Private temporary draft, `$VISUAL`/`$EDITOR` arguments, terminal suspension, readback, cleanup and error handling. Defaults to `vi`. |
| `src/persistence/promptHistory.ts` | Append prompt history under Sirus data, keyed by canonical directory; retain the latest 1,000 entries on read. |
| `src/frontend/chat/Chat.tsx` | Image attachment callback and keyboard ownership while input overlays are open. |
| `src/frontend/chat/MentionMenu.tsx` | Matching files precede creation/participant choices; explicit selection remains visible as file results arrive. |
| `src/agent_runtime/session/roster.ts` | Unknown `@words` remain prose unless followed by a supported model; known participants and explicit introductions still route. |
| `src/commands/help/commands.ts` | Updated key map shared by `/help` and `?`. |
| `README.md` | Document ordinary unknown mentions and file priority. |

Existing tests were updated in `tests/frontend/{input_bar,draft,mention_menu,
file_mentions_integration,chat_attachments}.test.tsx` and
`tests/data/{data,persistence,session_naming,session_recency}.test.ts`. No new test files
were created. Invalid-route fixtures now use an explicitly invalid reserved participant
name rather than an ordinary unknown word.

Sirus-only slash commands are excluded from persistent prompt history so configuration
commands containing credentials are not recorded. Image attachments remain separate
from textual history. The collapse threshold combines the vendors' character and line
conventions; the input shows at most eight text rows and scrolls to its cursor.

Final verification after rebasing onto native resume and doctor: typecheck passed;
**611 tests passed, 0 failed** both normally and with `FORCE_COLOR=1` (4,709 assertions
per run), with scratch HOME/data. Real tmux at 150×48 and 80×48 reproduced the original
60-line overflow, then verified paste collapse, eight-row cursor-following scroll,
`vi` Ctrl+G edit/save, a successful prompt/reply, history search after app restart into
a new session in the same directory, image-path attachment/removal, and wrapped
shortcuts. File-first selection and inverse-cell cursor styling were separately checked
at both widths. Narrow status-row problems remain part of C2.

## C3: doctor and update notice

Neither 9.9 finding was already fixed. The real TUI initially reported an unknown
`/doctor` command, and the update was a sidebar-only boolean `/update` indicator.

| File | Change |
| --- | --- |
| `src/doctor.ts` | Check Bun, adapter versions and entry points, bundled vendor versions, subscription logins, configured API keys, data-directory access and git. Subprocess time/output are bounded; raw login output is not displayed. |
| `src/cli.ts` | `sirus doctor` output and nonzero exit status for errors. |
| `src/commands/doctor/commands.ts` | `/doctor` diagnostics panel with cancellation. |
| `src/commands/registry.ts` | Register `/doctor`, including its `/help` entry. |
| `src/agent_runtime/providers/login.ts` | Share the bundled Claude binary resolver. |
| `src/frontend/app.tsx` | Versioned update notice above chat, visible when the sidebar is collapsed. |
| `src/frontend/Sidebar.tsx` | Remove the sidebar-only update indicator. |
| `README.md` | Document doctor. |

Updated existing CLI, command registry, app and sidebar tests. After rebasing onto native
resume, typecheck passed and **592 tests passed** both normally and with `FORCE_COLOR=1`,
using scratch `HOME` and `SIRUS_DATA_DIR`. Real CLI and tmux doctor checks passed. A
synthetic new version tested the notice at 150 and 80 columns, including Ctrl+B collapse.

API-key validity is not checked remotely and the report says so. Doctor reports the
bundled binaries Sirus actually uses: Claude 2.1.280 and Codex 0.156.1 in this checkout,
which differ from the global CLIs used for comparison.

## Vendor comparison and verification limits

Real tmux comparison used Claude Code **2.1.283** and Codex CLI **0.157.1** in a throwaway
git directory. Both collapsed a 60-line, 2,450-character bracketed paste, moved Up by
visual row at 80 columns, opened shortcuts on an empty-input `?`, and round-tripped a
draft with Ctrl+G. Claude also accepted Ctrl+X Ctrl+E. Both provided Ctrl+R history
search; Claude's Ctrl+S changes search scope, whereas Sirus uses it to move toward newer
matches. Vendor history persistence/directory isolation and their running-turn input
styling were not independently verified. No model turns were needed for these input
comparisons. Claude's `/doctor` comparison was cancelled when it began a model diagnostic;
Codex's `/status` rendered.

Sirus smoke runs used scratch git projects and scratch data containing only a copy of
settings; credentials were not printed. All test suites use scratch HOME/data. The
required package binaries were reused through symlinks. Test and smoke results for the
pending B1/B2-dependent findings are not claimed here.

## C1 key map

| Keys | Action |
| --- | --- |
| enter / tab | send or steer / queue for after the turn |
| shift+enter · alt+enter · \ + enter | new line |
| ↑ / ↓ | visual rows, then queue and directory history |
| enter / esc in queue edit | save / restore the original |
| option+↑ / ↓ | switch session |
| ctrl+n | focus the empty draft |
| sidebar: type · ctrl+r / a / d | filter · rename / archive / delete |
| resume: tab | toggle this project / all projects |
| ctrl+b | collapse the sidebar |
| ctrl+t | show / hide tasks |
| ? on empty input | shortcuts · ↑/↓ scroll · esc closes |
| ctrl+r | search directory history · ctrl+r/s older/newer |
| enter / esc in history search | select match / restore draft |
| ctrl+g · ctrl+x ctrl+e | edit draft in $VISUAL or $EDITOR |
| ctrl+v | attach a clipboard image |
| @ · ↑ / ↓ · tab / enter | find and mention a project file |
| backspace over an image | remove it |
| shift+tab | switch ask / auto; choose bypass through /permissions |
| esc | close menu · restore queue edit · decline card · cancel turn |
| esc twice | clear draft (↑ recalls) · empty draft opens /rewind |
| ctrl+c | interrupt · clear draft · press again within 1s to exit |
| pgup / pgdn · ctrl+home / end | scroll the history |
| y / a / n / d | answer approval options · tab adds rejection feedback |
| home / end · ctrl+a / e | move to start / end of line |
| alt+b / f · alt+← / → | move one word |
| delete · ctrl+d | delete the next character |
| ctrl+k / u | kill to end / start of line |
| ctrl+w · alt+backspace / d | kill previous / next word |
| ctrl+y · ctrl+_ | yank killed text / undo an edit |
