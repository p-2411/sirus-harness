# Audit: persistence, memory, commands, misc, tests

## A. Persistence (`src/persistence.ts`, 382)

Seven jobs: data-directory lookup `:160-169`; atomic JSON `:171-198`; zod schemas for the
whole session graph `:9-101`; Session object mapping incl. legacy reconstruction `:200-267`;
settings read-modify-write + 6 accessor pairs `:269-354`; provider-source storage with a
cross-field side effect (`saveProviderSources` deletes `apiKeys[vendor]` `:346-354`);
subscription-limit cache `:356-382`.

Consumers: `dataDirectory` → 9 modules (`checkpoints`, `images`, `memory/store`,
`memory/embeddings`, `providers/profiles`, `providers/provider`, `providers/usage`, both
subscription transports). `loadSessions`/`saveSessions` → `app.tsx:65,123` only.
`load/saveSirusModelPreference` → `app.tsx`, `commands/agents/behavior.ts:100`.
`load/saveNotificationPreference` → `frontend/terminal/notifications.ts:33,38`.
`load/saveMemoryAccessPreference` → `agent_runtime/memory-access.ts`.
`load/saveSubscriptionPreferences`, `loadApiKeys`, `load/saveProviderSources` →
`providers/provider.ts`. `saveApiKeys` has no live external caller. Limit cache → `providers/usage.ts`,
`provider.ts:190,227`.

Problems: imports the `Session` class (`:6`) — storage depends on domain and domain depends
back (`provider.ts`, `memory-access.ts`), an import cycle; tests build 13-positional Sessions
(`tests/data/persistence.test.ts:35-39`). Legacy migration duplicated with `Session.fromSnapshot`.
`saveSessions` runs on every session notification (`app.tsx:123`). Settings read-modify-write
without locking; `z.object` strips unknown keys so an older build deletes newer settings;
`writeSettings` hand-lists six sections. 12 of 17 functions take an optional `directory`, three
do not — so tests use two isolation idioms (parameter vs `SIRUS_DATA_DIR` mutation, 14 files).

Preserve (test): `SIRUS_DATA_DIR` override (`tests/file_mentions.test.ts:217-231`,
`tests/checkpoints.test.ts:14,28-29,38`, `tests/commands/usage.test.ts:18-33`); atomic write
temp→rename, dir 0700, file 0600, temp cleaned, returns false never throws
(`persistence.test.ts:130-134,231-235`); corrupt/unknown-version file → empty workspace
(`:104-110`); legacy session without directory inherits launch dir (`:112-128`); legacy `model`
→ single `sirus` participant (`:126-127`); empty sessions neither saved nor restored, dangling
selection → null (`:136-149`); every section survives every other's save
(`:153-167,175-181,193-200,204-211,221-229`); invalid settings → defaults (`:183-189`);
defaults: subscriptions `{false,false}`, memory `true`, notifications `background`, sirusModel
`null`, apiKeys `{}`; full round-trip of images/checkpoints/usage/thinking/drafts
(`:32-81`, `tests/images.test.ts:106-120`); missing `updatedAt` sorts last
(`tests/data/session_recency.test.ts:79-85`); limit-cache entry shape with `remaining` 0-100.

Hazards: keep read-per-call semantics (no caching) or every `SIRUS_DATA_DIR` test breaks;
`notifications.ts:30` caches the preference in module state and is the only writer its test
relies on; add a test loading the exact legacy JSON at `persistence.test.ts:113-122` asserting
the full snapshot before deleting either migration copy.

## B. Memory

`memory/store.ts` (631): sqlite discovery `:73-85`; sqlite-vec loading `:87-97`; schema
migration v1→v3 incl. legacy rewrite `:264-372` (subtle ordering at `:311-316`: `vectorTableExists`
computed before `createVectorTable`, `countAllMemories()` consulted only when the vector table
is missing); scope CRUD `:438-470`; memory CRUD `:136-234`; vector search `:236-262,424-436`;
lazy reindex `:383-422` (serial, unbounded, no abort); validation `:526-599` (duplicated in
`tools/arguments.ts:33-76` and again in `memoryFromRow` `:601-621`); singleton `:623-631`
capturing `dataDirectory()` at first call, no reset/close.
`graph.ts` — dead (zero importers). `listMemories` `:225-234` — dead. `embeddings.ts:21`
module-scoped pipeline. `memory-access.ts` — 14-line pass-through.
Only production consumer: `tools/memories.ts` via the singleton; uses `saveMemory`, `getMemory`,
`deleteMemory`, `searchMemories`.

Preserve (test `tests/memory/store.test.ts`): scoped memories/links/embedding metadata survive
reopen (`:55-77`); project scopes keyed by resolved directory, global single row (`:79-`);
`available` = global + this project (`:220-231`); global may not link to project (`:140-145`);
duplicate names rejected (`:146-152`); embedder change → full reindex rewriting
`embedding_model` (`:154-176`); legacy v2 table migrates into global preserving ids, string
links → `{scope:'global',name}` (`:178-232`); results ordered by distance then id, sliced to
limit across scopes, `similarity = 1 - distance` (`:87`); limit integer 1..50; memory tools
vanish and refuse when access off (`tests/agent/tools.test.ts:31-34,72-`,
`tests/agent/prompt.test.ts:52`); `/memory on|off` resets runtimes only on change
(`tests/commands/command_register.test.ts:243-271`).

Hazards: move `migrate()` lines verbatim; `defaultMemoryDatabasePath()` `:99-103` does
`mkdirSync` as a side effect of computing a path; `tools.test.ts:81,240` asserts tool-result
error text when thinning `arguments.ts`.

## C. Commands

`types.ts:27-35` `CommandExecution` five-field bag: `session` used by 9 commands, `signal` 3,
`notify` 2, `attachImage` 1, `exit` 1. Session methods used across all commands:
`changeParticipantModel`, `isEmpty`, `setThinkingLevel`, `getThinkingLevel`, `clear`, `setName`,
`getName`, `getPermissionMode`, `setPermissionMode`, `getDirectory`, `getCheckpoints`, `rewind`,
`getTotalUsage`, `getContextUsage`, `getId`.
Menus: `commandMenu` is called before `executeCommand` (`Chat.tsx:355-366`); picking an item
re-enters `send()` with the item's command string (`:333`); secrets are appended to the string
(`:336-344`) and re-split on spaces (`:352-353`) — a key containing a space breaks.
`Chat.tsx:30,257` imports `permissionsCommand` directly for shift+tab, bypassing the registry.
`registry.ts:23` re-exports `loginMenuItems` for one test. `commandRegistry` is a mutable array.
`help/` and `images/` ignore the `behavior.ts` convention; `memory/`, `notifications/`,
`update/` behaviors are trivial. Seven hand-written `if (args.length > 0) throw`.

Preserve (test `tests/commands/command_register.test.ts` unless noted): `/` matches all, prefix
filters, space closes, non-`/` matches nothing (`:40-67`); registry order is user-visible and
`/help` includes itself (`:40-48,192-206`); unknown command throws (`:272-276`); non-null menu
short-circuits, picking re-sends (`tests/frontend/input_bar.test.tsx`, `command_menu.test.tsx`);
`/login` vendor → method, API item carries a secret, key never echoed (`:306-350`); model
resolution exact → unique substring → latest in family → ambiguity error (`:124-147`); Sirus
model in an empty session also saves the default (`:85-110`); models grouped under provider
headings (`:148-167`); `/rewind` lists newest-first with 1-based oldest-first numbers
(`tests/commands/checkpoints.test.ts:26-36`); invalid `/undo`/`/rewind` never restore (`:48-56`);
file rewind refused while subagents active (`tests/data/session_checkpoints.test.ts:211-278`);
`/logout` lists removable sources, ambiguity errors, nothing configured → info
(`:364-376,405-431`); `/memory` resets only on change (`:243-271`); `/notify` warns when focus
never reported (`tests/frontend/notifications.test.ts:36-51`); `/help`, `/version`, `/usage`
render without the feedback icon (`:192-206,377-381`); async commands hold the input and escape
aborts silently (`tests/frontend/chat.test.ts`); `/rename` and `/image` accept spaces (`:182-191`).
Exact `Usage:` strings asserted at `:143,207,272,277`.

## D. Misc

- `config.ts` (root): dead, tracked, not shipped. Delete.
- `providers/credentials.ts`: dead; `maskApiKey`/`ApiKey`/error strings copied into `provider.ts`.
- Two exported types named `FileMention`: `fileSearch.ts:10-14` `{start,end,query}` vs
  `fileMentions.ts:6-10` `{start,end,path}`. Rename the former `ActiveMentionToken`.
- `fileSearch.ts:16-55` `protectedText` duplicates `mentions.ts:20-58` state machine (not provably
  equivalent at unterminated delimiters — differential test before unifying; guards:
  `tests/frontend/file_menu.test.tsx:26-34`, `tests/mentions.test.ts:33`).
- `matchFileSuggestions` silently returns `[]` when `directory` is omitted for absolute queries.
- `updater.ts:46-88` `runNpm` duplicates spawn/timeout/capture in `tools/shell.ts` and `codex-rpc.ts`.
- `abort.ts`, `cli.ts`, `version.ts`, `images.ts`, `fileMentions.ts`: clean; leave.
- `debug.log` tracked despite `.gitignore`.
- `Chat.tsx:32` has a commented-out import of a `../../state` module that does not exist.

## E. Tests

43 files, no shared setup. Isolation: parameter injection (`persistence`, `memory`) or
`SIRUS_DATA_DIR` save/restore longhand in 14 files. `HOME` never touched by tests (fallback is
`os.homedir()`, so a forgotten override writes to the real store). Module-level caches that
couple test order: `notifications.ts:30`, `memory/store.ts:71,623`, `embeddings.ts:21`.
`tests/data/data.test.ts` is 917 lines. Coverage gaps: `abort.ts`, `saveProviderSources` side
effect, `dataDirectory` platform branches, secret with a space, judge routing, shell classifier.
