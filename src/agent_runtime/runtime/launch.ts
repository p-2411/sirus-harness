import crypto from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import type { McpServer } from '@agentclientprotocol/sdk';
import { dataDirectory } from '../../dataDirectory';
import type { PermissionMode } from '../permissions/policy';
import type { Vendor } from '../providers/catalog';
import type { RuntimeOptions } from './runtime';

// A vendor is a launch spec: the adapter to run, the environment its process
// gets, and what its `session/new` carries. Everything the runtime does after
// the launch is the same for every vendor.

// Who a session on this process is opened for: the runtime's own participant
// when it is the root, the worker's when it is a fork.
export interface SessionSpec {
  systemPrompt: string;
  mcpServer: RuntimeOptions['mcpServer'];
}

// What that session's `session/new`, `session/fork` or `session/resume`
// carries beyond the directory.
export interface SessionParams {
  meta?: Record<string, unknown>;
  mcpServers: McpServer[];
}

export interface Launch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  // The mode the session starts in. A bare runtime answers one question and
  // starts read-only whatever the session's mode is.
  mode: PermissionMode;
  // Every session opened on this process goes through here — the first one
  // and every fork — so the vendor's extras are written once and each
  // session carries the participant it was opened for. Claude takes a system
  // prompt here and Codex does not, its instructions file being the whole
  // process's; on a fork only the MCP entry actually lands, since Claude
  // keeps the prompt the forked transcript was written under.
  session(spec: SessionSpec): SessionParams;
  // claude-agent-acp's `session/fork` only writes the forked transcript: it
  // looks the session being forked up under the directory the call names, so
  // that must be the parent's, and the fork is not a session in the adapter
  // until a `session/resume` opens it in the worker's directory. codex-acp
  // creates the forked session outright, in the directory the call names, and
  // answers with it already live.
  forkNeedsResume: boolean;
  // Removes what the launch wrote to disk. Idempotent.
  cleanup(): void;
}

const require = createRequire(import.meta.url);

// The adapter's bin script, run with the runtime Sirus itself runs under:
// both adapters are plain node scripts and run under bun as they are.
function adapterScript(packageName: string): string {
  const manifestPath = require.resolve(`${packageName}/package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin: Record<string, string> };
  return path.join(path.dirname(manifestPath), Object.values(manifest.bin)[0]!);
}

function mcpServersFor(spec: SessionSpec): McpServer[] {
  return spec.mcpServer ? [{ type: 'http', ...spec.mcpServer }] : [];
}

// Claude Code's built-in tools this session may run. Task, Agent,
// AskUserQuestion, TodoWrite, NotebookEdit and ExitPlanMode stay off so native
// subagents stay off and nothing arrives that Sirus cannot render.
const CLAUDE_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch', 'WebSearch'];

function claudeLaunch(options: RuntimeOptions, mode: PermissionMode): Launch {
  return {
    command: process.execPath,
    args: [adapterScript('@agentclientprotocol/claude-agent-acp')],
    // The adapter spreads its own environment into the CLI's, so the
    // credential and CLAUDE_CONFIG_DIR reach Claude Code as they are.
    env: { ...options.env },
    mode,
    session: spec => ({
      meta: {
        // A string replaces the Claude Code preset, as Sirus's prompt always has.
        systemPrompt: spec.systemPrompt,
        claudeCode: {
          options: {
            tools: options.bare ? [] : CLAUDE_TOOLS,
            // Keeps CLAUDE.md and the user's settings files out of the session.
            settingSources: [],
          },
        },
      },
      mcpServers: mcpServersFor(spec),
    }),
    forkNeedsResume: true,
    cleanup() {},
  };
}

// codex-acp's mode ids by the kind Sirus's modes map onto (`_AgentMode` in
// its source). The adapter reads the initial one from the environment.
const CODEX_MODES: Record<PermissionMode, string> = {
  ask: 'read-only',
  auto: 'agent',
  bypass: 'agent-full-access',
};

const CODEX_TARGET_TRIPLES: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'win32-x64': 'x86_64-pc-windows-msvc',
};

// The Codex binary from the pinned per-platform package, or null to let the
// adapter run the one its own dependency ships.
function codexBinaryPath(): string | null {
  const key = `${process.platform}-${process.arch}`;
  const triple = CODEX_TARGET_TRIPLES[key];
  if (!triple) return null;
  try {
    const packageJson = require.resolve(`@openai/codex-${key}/package.json`);
    const binary = path.join(
      path.dirname(packageJson), 'vendor', triple, 'bin',
      process.platform === 'win32' ? 'codex.exe' : 'codex',
    );
    return existsSync(binary) ? binary : null;
  } catch {
    return null;
  }
}

function codexLaunch(options: RuntimeOptions, mode: PermissionMode): Launch {
  // codex-acp has no prompt hook: the system prompt goes through a file named
  // in the config overrides the adapter hands to the app-server, replacing
  // Codex's built-in instructions. project_doc_max_bytes 0 keeps AGENTS.md
  // from loading twice, since Sirus's prompt already carries it.
  const directory = path.join(dataDirectory(), 'runtimes', crypto.randomUUID());
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const instructions = path.join(directory, 'instructions.md');
  writeFileSync(instructions, options.systemPrompt, { mode: 0o600 });
  const codex = codexBinaryPath();
  return {
    command: process.execPath,
    args: [adapterScript('@agentclientprotocol/codex-acp')],
    env: {
      ...options.env,
      CODEX_CONFIG: JSON.stringify({ model_instructions_file: instructions, project_doc_max_bytes: 0 }),
      INITIAL_AGENT_MODE: CODEX_MODES[mode],
      // A login page must never open from under the TUI.
      NO_BROWSER: '1',
      ...(codex ? { CODEX_PATH: codex } : {}),
    },
    mode,
    // The instructions file is the whole process's, so a forked session
    // inherits the owner's system prompt and takes only its own MCP entry.
    session: spec => ({ mcpServers: mcpServersFor(spec) }),
    forkNeedsResume: false,
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const LAUNCHES: Record<Vendor, (options: RuntimeOptions, mode: PermissionMode) => Launch> = {
  claude: claudeLaunch,
  gpt: codexLaunch,
};

export function launchFor(options: RuntimeOptions): Launch {
  return LAUNCHES[options.vendor](options, options.bare ? 'ask' : options.permissionMode);
}
