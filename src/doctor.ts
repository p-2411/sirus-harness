import { execFile } from 'child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import manifest from '../package.json';
import { throwIfAborted } from './abort';
import { dataDirectory } from './dataDirectory';
import { VENDOR_INFO, type Vendor } from './agent_runtime/providers/catalog';
import { claudeBinaryPath } from './agent_runtime/providers/login';
import { codexBinaryPath } from './agent_runtime/providers/openai/codex-account';
import { createSourceStore } from './agent_runtime/providers/sources';

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warning' | 'error';
  detail: string;
}

type CommandResult = { code: number; stdout: string; stderr: string };
export type DoctorRunner = (command: string, args: string[], env: NodeJS.ProcessEnv, directory: string, signal?: AbortSignal) => Promise<CommandResult>;

const runCommand: DoctorRunner = (command, args, env, cwd, signal) => new Promise(resolve => {
  // Bound both the time and output of a broken installation. Login output is
  // parsed below, never copied into the report: it may contain credentials.
  execFile(command, args, { env, cwd, signal, timeout: 15_000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
    resolve({ code: error ? typeof error.code === 'number' ? error.code : -1 : 0, stdout, stderr });
  });
});

function installedAdapter(name: string): DoctorCheck {
  try {
    const require = createRequire(import.meta.url);
    const filename = require.resolve(`${name}/package.json`);
    const installed = JSON.parse(readFileSync(filename, 'utf8')) as { version: string; bin: Record<string, string> };
    const script = path.resolve(path.dirname(filename), Object.values(installed.bin)[0]!);
    accessSync(script, constants.R_OK);
    const expected = manifest.dependencies[name as keyof typeof manifest.dependencies];
    return { name, status: installed.version === expected ? 'ok' : 'warning', detail: `${installed.version}${installed.version === expected ? '' : ` (expected ${expected}; reinstall Sirus)`}` };
  } catch {
    return { name, status: 'error', detail: 'missing or unreadable; reinstall Sirus' };
  }
}

function checkDataDirectory(): DoctorCheck {
  const directory = path.resolve(dataDirectory());
  try {
    let existing = directory;
    while (!existsSync(existing)) existing = path.dirname(existing);
    if (!statSync(existing).isDirectory()) throw new Error('not a directory');
    accessSync(existing, constants.R_OK | constants.W_OK | constants.X_OK);
    return { name: 'Data directory', status: 'ok', detail: `${directory}${existing === directory ? ' (readable and writable)' : ' (can be created)'}` };
  } catch {
    return { name: 'Data directory', status: 'error', detail: `${directory} (not accessible; check SIRUS_DATA_DIR and permissions)` };
  }
}

export async function runDoctor(directory = process.cwd(), signal?: AbortSignal, run: DoctorRunner = runCommand): Promise<DoctorCheck[]> {
  throwIfAborted(signal);
  const version = async (name: string, command: string): Promise<DoctorCheck> => {
    const result = await run(command, ['--version'], process.env, directory, signal);
    const value = /\d+\.\d+\.\d+(?:[-+][\w.-]+)?/.exec(result.stdout)?.[0];
    return result.code === 0 && value
      ? { name, status: 'ok', detail: value }
      : { name, status: 'error', detail: 'could not run --version; check installation and PATH' };
  };
  const login = async (vendor: Vendor, binary: string): Promise<DoctorCheck[]> => {
    const info = VENDOR_INFO[vendor];
    const sources = createSourceStore(info).list();
    const profiles = sources.filter(source => source.kind === 'subscription');
    const checks: DoctorCheck[] = [];
    if (sources.some(source => source.kind === 'api')) checks.push({ name: `${info.displayName} API`, status: 'ok', detail: 'key configured (validity not checked)' });
    // Also diagnose a vendor login the user has not yet selected in /login.
    for (const source of profiles.length ? profiles : [{ profile: 'default' }]) {
      const env = { ...process.env };
      for (const key of info.scrubEnv) delete env[key];
      if (source.profile !== 'default') env[info.profileDirEnv] = path.resolve(dataDirectory(), 'subscriptions', vendor, source.profile);
      const args = vendor === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'];
      if (vendor === 'gpt' && source.profile !== 'default') args.push('-c', 'cli_auth_credentials_store="file"');
      const result = await run(binary, args, env, directory, signal);
      let signedIn = false;
      let readable = result.code === 0;
      if (vendor === 'claude') {
        try {
          const status = JSON.parse(result.stdout) as { loggedIn?: boolean; authMethod?: string };
          readable = typeof status.loggedIn === 'boolean';
          signedIn = status.loggedIn === true && status.authMethod === 'claude.ai';
        } catch { readable = false; }
      } else {
        signedIn = result.code === 0 && /logged in using ChatGPT/i.test(result.stderr + result.stdout);
        readable ||= /not logged in|logged in using/i.test(result.stderr + result.stdout);
      }
      checks.push({
        name: `${info.displayName} login${profiles.length > 1 || source.profile !== 'default' ? ` (${source.profile})` : ''}`,
        status: signedIn ? profiles.length ? 'ok' : 'warning' : 'warning',
        detail: signedIn ? profiles.length ? 'signed in' : `signed in; select subscription with /login ${info.command}`
          : readable ? `no subscription login; use /login ${info.command} (API keys work separately)`
            : `could not read login status; check the vendor CLI or use /login ${info.command}`,
      });
    }
    return checks;
  };
  const claude = claudeBinaryPath();
  const codex = codexBinaryPath();
  const [bun, claudeVersion, codexVersion, claudeLogin, codexLogin, git] = await Promise.all([
    version('Bun', process.execPath), version('Claude Code', claude), version('Codex', codex),
    login('claude', claude), login('gpt', codex), version('Git', 'git'),
  ]);
  throwIfAborted(signal);
  if (bun.status === 'ok' && Bun.semver.satisfies(bun.detail, manifest.engines.bun) === false) {
    bun.status = 'error';
    bun.detail += ` (requires ${manifest.engines.bun}; update Bun)`;
  }
  if (git.status === 'ok') {
    const repository = await run('git', ['rev-parse', '--is-inside-work-tree'], process.env, directory, signal);
    git.detail += repository.code === 0 && repository.stdout.trim() === 'true' ? ' (git worktree)' : ' (outside a git worktree; worker worktree isolation unavailable)';
    if (repository.code !== 0 || repository.stdout.trim() !== 'true') git.status = 'warning';
  }
  throwIfAborted(signal);
  return [bun, installedAdapter('@agentclientprotocol/claude-agent-acp'), installedAdapter('@agentclientprotocol/codex-acp'),
    claudeVersion, codexVersion, ...claudeLogin, ...codexLogin, checkDataDirectory(), git];
}

export function formatDoctor(checks: readonly DoctorCheck[]): string {
  return [`Sirus ${manifest.version} doctor`, ...checks.map(check => `${check.status.toUpperCase()}  ${check.name}: ${check.detail}`)].join('\n');
}
