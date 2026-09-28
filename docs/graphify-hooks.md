# Remote Graphify hooks

This repository uses the `graphify` MCP connection at
`https://api.graphify.com/mcp`, with repository ID `p-2411/sirus-harness`.
Each client must have that server configured and authenticated separately.

The shared `scripts/graphify-remote-hook.mjs` script supplies advisory context:

- `SessionStart` introduces the remote tools, repository ID, and freshness rules,
  including after a session is resumed or compacted.
- `PreToolUse` reminds the agent to use Graphify when searching or reading code.
  Already-located files, literal searches, and current local changes can still be
  inspected locally. Tools are never blocked or rewritten.

The hook itself makes no network requests, reads no credentials or transcripts,
and writes no files. The agent calls Graphify through its existing MCP connection.
It does not require `graphify-out/graph.json`, install Git hooks, upload edits,
or rebuild the remote index. It requires Node.js on the client's command PATH.

## Codex

Configuration: `.codex/hooks.json`.

Open this trusted project and use `/hooks` in the Codex CLI to review and trust
the two new hook definitions. Codex skips new or changed hooks until their exact
definitions are trusted. Start or resume a session after activation; these edits
do not prove the hooks have loaded into an already-running chat.

The command resolves the script from the Git root, including when Codex starts in
a subdirectory or another checkout that contains these files.

## Claude Code

Configuration: `.claude/settings.json`. This replaces the local
`graphify hook-guard` commands. Start a fresh session and inspect `/hooks` to
confirm the `SessionStart` and `PreToolUse` entries are enabled. The command uses
`CLAUDE_PROJECT_DIR` so it can find the script from project subdirectories.

## References

- [Codex hooks and trust review](https://developers.openai.com/codex/hooks)
- [Claude Code hook configuration](https://code.claude.com/docs/en/hooks)
