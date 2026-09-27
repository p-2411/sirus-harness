// Brings Claude Code and Codex up to date the way Sirus runs them: through
// their ACP adapters, each pinned to an exact release because Sirus depends
// on how they behave. Bumps both adapters to their latest releases, keeps
// the Claude Agent SDK Sirus imports (which carries the Claude Code binary)
// and Sirus's own ACP client on the releases the Claude adapter pins, updates
// both lockfiles, then runs the typecheck and the tests.
// `bun run update-harnesses`.
import { $ } from 'bun';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

const CLAUDE_ADAPTER = '@agentclientprotocol/claude-agent-acp';
const CODEX_ADAPTER = '@agentclientprotocol/codex-acp';
const CLAUDE_SDK = '@anthropic-ai/claude-agent-sdk';
const ACP_SDK = '@agentclientprotocol/sdk';

async function npmView(spec: string, field: string): Promise<unknown> {
  return JSON.parse(await $`npm view ${spec} ${field} --json`.quiet().text());
}

const manifest = JSON.parse(await Bun.file('package.json').text()) as { dependencies: Record<string, string> };
const claudeAdapter = await npmView(CLAUDE_ADAPTER, 'version') as string;
const codexAdapter = await npmView(CODEX_ADAPTER, 'version') as string;
const adapterDependencies = await npmView(`${CLAUDE_ADAPTER}@${claudeAdapter}`, 'dependencies') as Record<string, string>;
const pinnedBy = (name: string): string => {
  const version = adapterDependencies[name]?.replace(/^[\^~]/, '');
  if (!version) throw new Error(`${CLAUDE_ADAPTER}@${claudeAdapter} no longer depends on ${name}`);
  return version;
};

const wanted: Record<string, string> = {
  [CLAUDE_ADAPTER]: claudeAdapter,
  [CODEX_ADAPTER]: codexAdapter,
  [CLAUDE_SDK]: pinnedBy(CLAUDE_SDK),
  [ACP_SDK]: pinnedBy(ACP_SDK),
};
const changes = Object.entries(wanted).filter(([name, version]) => manifest.dependencies[name] !== version);
if (changes.length === 0) {
  console.log('Already up to date:', Object.entries(wanted).map(([name, version]) => `${name}@${version}`).join(', '));
  process.exit(0);
}
for (const [name, version] of changes) console.log(`${name}: ${manifest.dependencies[name] ?? 'none'} → ${version}`);

await $`bun add --exact ${changes.map(([name, version]) => `${name}@${version}`)}`;
// The published package installs through npm, so its lockfile follows.
await $`npm install --package-lock-only --ignore-scripts --no-audit --no-fund`.quiet();
await $`bun run typecheck`;
// The suite writes to the data directory and starts sessions that read the
// vendors' homes, so it runs in a scratch home of its own, never the user's.
const scratch = mkdtempSync(path.join(os.tmpdir(), 'sirus-update-harnesses-'));
try {
  const home = path.join(scratch, 'home');
  const data = path.join(scratch, 'data');
  mkdirSync(home);
  mkdirSync(data);
  await $`bun test tests`.env({ ...process.env, HOME: home, SIRUS_DATA_DIR: data });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log('Updated and verified. Review the adapters\' changelogs before committing.');
