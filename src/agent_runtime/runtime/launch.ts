import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import type { McpServer } from '@agentclientprotocol/sdk';
import { dataDirectory } from '../../dataDirectory';
import { VENDOR_INFO, type Vendor } from '../providers/catalog';
import { codexBinaryPath } from '../providers/openai/codex-account';
import type { PermissionMode } from '../types';
import type { RuntimeOptions } from './runtime';

// A vendor is a launch spec: the adapter to run, the environment its process
// gets, and what its `session/new` carries. Everything the runtime does after
// the launch is the same for every vendor.
//
// Each vendor runs as it would in its own terminal: its own system prompt,
// instruction files, settings, skills, plugins, hooks and commands. Sirus
// adds its part of the prompt on top (`../prompt`) and switches off only what
// it has to: the tools that hand work to the vendor's own agents, since
// delegation here goes through SpawnAgent and can land on any vendor's model,
// and the ones that start turns Sirus never asked for and so cannot show.

// Who a session on this process is opened for: the runtime's own participant
// when it is the root, the worker's when it is a fork.
export interface SessionSpec {
  // Where the session runs: the participant's directory, or the worker's.
  directory: string;
  // Sirus's addendum to the vendor's prompt, or a bare runtime's whole prompt.
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
  // session carries the participant it was opened for. Claude takes its
  // prompt here and Codex does not, its developer instructions being the
  // whole process's; on a fork only the MCP entry actually lands, since
  // Claude keeps the prompt the forked transcript was written under.
  session(spec: SessionSpec): SessionParams;
  // claude-agent-acp's `session/fork` only writes the forked transcript: it
  // looks the session being forked up under the directory the call names, so
  // that must be the parent's, and the fork is not a session in the adapter
  // until a `session/resume` opens it in the worker's directory. codex-acp
  // creates the forked session outright, in the directory the call names, and
  // answers with it already live.
  forkNeedsResume: boolean;
  // An `authenticate` to send after `initialize`, when the credential in the
  // environment is one the harness must be logged in with rather than read.
  authenticate?: { methodId: string };
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

// The directory and each parent up to the git root, root first, the way both
// vendors walk for instruction files. Outside a repository only the
// directory itself.
function projectDirectories(directory: string): string[] {
  const directories: string[] = [];
  let current = path.resolve(directory);
  for (;;) {
    directories.unshift(current);
    // A worktree's .git is a file; either way it marks the root.
    if (existsSync(path.join(current, '.git'))) return directories;
    const parent = path.dirname(current);
    if (parent === current) return [path.resolve(directory)];
    current = parent;
  }
}

// ── Claude ──────────────────────────────────────────────────────────────

// Claude Code's tools that delegate to Claude's own agents (Agent, which
// Task names too, Workflow, RemoteTrigger) or that start turns on their own
// (the cron tools, ScheduleWakeup, Monitor).
const CLAUDE_TOOLS_OFF = ['Agent', 'Workflow', 'RemoteTrigger', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'Monitor'];

// Claude Code's bundled skills built on those tools, so the `/` menu does
// not offer what cannot run.
const CLAUDE_SKILLS_OFF = ['batch', 'code-review', 'loop', 'deep-research', 'workflow-authoring'];

// Claude Code reads CLAUDE.md, not AGENTS.md, and its own fallback to
// AGENTS.md is not switched on yet. Codex reads AGENTS.md. A project that
// keeps its instructions only there is pointed out to Claude, so both
// vendors in one session follow the same file.
function agentsPointer(directory: string): string {
  const directories = projectDirectories(directory);
  const claudeFiles = directories.flatMap(dir => [
    path.join(dir, 'CLAUDE.md'),
    path.join(dir, '.claude', 'CLAUDE.md'),
    path.join(dir, 'CLAUDE.local.md'),
  ]);
  if (claudeFiles.some(file => existsSync(file))) return '';
  const agentsFiles = directories.map(dir => path.join(dir, 'AGENTS.md')).filter(file => existsSync(file));
  if (agentsFiles.length === 0) return '';
  const files = agentsFiles.map(file => JSON.stringify(file)).join(', ');
  return `\n\n# Project instructions\nThis project keeps its agent instructions in ${files}, not in CLAUDE.md. Read ${agentsFiles.length === 1 ? 'that file' : 'those files'} before you start work here and follow ${agentsFiles.length === 1 ? 'it' : 'them'} as you would CLAUDE.md.`;
}

function claudeLaunch(options: RuntimeOptions, mode: PermissionMode): Launch {
  return {
    command: process.execPath,
    args: [adapterScript('@agentclientprotocol/claude-agent-acp')],
    // The adapter spreads its own environment into the CLI's, so the
    // credential and CLAUDE_CONFIG_DIR reach Claude Code as they are.
    env: { ...options.env },
    mode,
    session: spec => ({
      meta: options.bare
        // A bare runtime answers one question: its prompt is the whole
        // prompt, and it takes no tools and none of the user's settings.
        ? { systemPrompt: spec.systemPrompt, claudeCode: { options: { tools: [], settingSources: [] } } }
        : {
          // An object keeps the Claude Code preset and appends to it.
          systemPrompt: { append: spec.systemPrompt + agentsPointer(spec.directory) },
          claudeCode: {
            options: {
              disallowedTools: CLAUDE_TOOLS_OFF,
              settings: { skillOverrides: Object.fromEntries(CLAUDE_SKILLS_OFF.map(name => [name, 'off'])) },
            },
          },
        },
      mcpServers: mcpServersFor(spec),
    }),
    forkNeedsResume: true,
  };
}

// ── Codex ───────────────────────────────────────────────────────────────

// codex-acp's mode ids by the kind Sirus's modes map onto (`_AgentMode` in
// its source). The adapter reads the initial one from the environment.
const CODEX_MODES: Record<PermissionMode, string> = {
  ask: 'read-only',
  auto: 'agent',
  bypass: 'agent-full-access',
};

const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

// The skills in one folder by name: its subfolders that hold a SKILL.md.
function skillsIn(folder: string): Map<string, string> {
  const found = new Map<string, string>();
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return found;
  }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const skill = path.join(folder, name);
    if (existsSync(path.join(skill, 'SKILL.md'))) found.set(name, skill);
  }
  return found;
}

// Codex finds the user's skills in `~/.codex/skills`. A credential with a
// profile of its own points Codex's home elsewhere, so the user's skills are
// linked in there one by one, since Codex writes its built-in skills into the
// same folder; a link to a skill the user has since removed goes.
function linkCodexSkills(profileHome: string | undefined): void {
  const userHome = process.env[VENDOR_INFO.gpt.profileDirEnv] || path.join(os.homedir(), '.codex');
  if (!profileHome || path.resolve(profileHome) === path.resolve(userHome)) return;
  const source = path.join(userHome, 'skills');
  const target = path.join(profileHome, 'skills');
  try {
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(target)) {
      const link = path.join(target, name);
      if (!lstatSync(link).isSymbolicLink()) continue;
      if (readlinkSync(link).startsWith(source + path.sep) && !existsSync(link)) unlinkSync(link);
    }
    for (const [name, skill] of skillsIn(source)) {
      const link = path.join(target, name);
      try {
        lstatSync(link);
      } catch {
        symlinkSync(skill, link, LINK_TYPE);
      }
    }
  } catch {
    // Skills are never a reason for a session not to start.
  }
}

function codexLaunch(options: RuntimeOptions, mode: PermissionMode): Launch {
  // codex-acp has no per-session prompt hook: every thread the process opens
  // gets the config overrides in CODEX_CONFIG. Sirus's addendum goes in as
  // developer instructions, beside Codex's own prompt and the AGENTS.md files
  // Codex reads itself. A bare runtime's prompt replaces Codex's instead, and
  // it reads no project instructions.
  const codex = codexBinaryPath();
  if (!options.bare) linkCodexSkills(options.env[VENDOR_INFO.gpt.profileDirEnv]);
  const config = options.bare
    ? { instructions: options.systemPrompt, project_doc_max_bytes: 0 }
    : {
      developer_instructions: options.systemPrompt,
      features: {
        // request_user_input is Codex's AskUserQuestion; Codex offers it
        // only in plan mode unless this is on.
        default_mode_request_user_input: true,
        // Codex's own subagents (spawn_agent and the rest); delegation here
        // is SpawnAgent's.
        multi_agent: false,
      },
    };
  return {
    command: process.execPath,
    args: [adapterScript('@agentclientprotocol/codex-acp')],
    env: {
      ...options.env,
      CODEX_CONFIG: JSON.stringify(config),
      INITIAL_AGENT_MODE: CODEX_MODES[mode],
      // A login page must never open from under the TUI.
      NO_BROWSER: '1',
      // The pinned binary when it is installed; otherwise the adapter runs
      // the one its own dependency ships.
      ...(codex ? { CODEX_PATH: codex } : {}),
    },
    mode,
    // The developer instructions are the whole process's, so a forked
    // session inherits the owner's and takes only its own MCP entry.
    session: spec => ({ mcpServers: mcpServersFor(spec) }),
    forkNeedsResume: false,
    // An API key in the environment is an API-key source (a subscription's
    // environment scrubs it). Codex only honours a key it was logged in
    // with, in the home the source's environment points it at. Logging in
    // replaces whatever login that home held, so it happens only in a home
    // Sirus made for the key, never in the user's own `~/.codex`.
    ...(options.env[VENDOR_INFO.gpt.credentialEnv] && isSirusProfile(options.env[VENDOR_INFO.gpt.profileDirEnv])
      ? { authenticate: { methodId: 'api-key' } }
      : {}),
  };
}

// Whether a profile directory is one of Sirus's own, under its data
// directory, rather than the user's.
function isSirusProfile(directory: string | undefined): boolean {
  return directory !== undefined && path.resolve(directory).startsWith(path.resolve(dataDirectory()) + path.sep);
}

const LAUNCHES: Record<Vendor, (options: RuntimeOptions, mode: PermissionMode) => Launch> = {
  claude: claudeLaunch,
  gpt: codexLaunch,
};

export function launchFor(options: RuntimeOptions): Launch {
  return LAUNCHES[options.vendor](options, options.bare ? 'ask' : options.permissionMode);
}
