import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import manifest from '../package.json';
import { abortReason, throwIfAborted } from './abort';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPDATE_TIMEOUT_MS = 5 * 60 * 1000;
const OUTPUT_LIMIT = 64 * 1024;

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type UpdateCommandRunner = (
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<CommandResult>;

export interface UpdateOutcome {
  updated: boolean;
  currentVersion: string;
  latestVersion: string;
}

export interface UpdateCheck {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string;
}

export interface UpdateOptions {
  currentVersion?: string;
  packageRoot?: string;
  run?: UpdateCommandRunner;
}

function appendLimited(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length > OUTPUT_LIMIT ? combined.slice(-OUTPUT_LIMIT) : combined;
}

async function runNpm(
  args: readonly string[],
  signal?: AbortSignal,
  timeoutMs: number = UPDATE_TIMEOUT_MS,
): Promise<CommandResult> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npmExecutable, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.kill();
      reject(error);
    };
    const onAbort = () => fail(abortReason(signal!));
    const timer = setTimeout(() => fail(new Error('Sirus update timed out')), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout = appendLimited(stdout, chunk); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = appendLimited(stderr, chunk); });
    child.on('error', error => fail(new Error(`Could not run npm: ${error.message}`)));
    child.on('exit', code => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code: code ?? 1, stdout, stderr });
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export function parsePublishedVersion(output: string): string {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    value = output.trim();
  }
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`npm returned an invalid Sirus version: ${output.trim() || '(empty output)'}`);
  }
  return value;
}

export function isSourceCheckout(packageRoot: string = PACKAGE_ROOT): boolean {
  return existsSync(path.join(packageRoot, '.git'));
}

function parseVersion(version: string): { core: number[]; prerelease: string[] } {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) throw new Error(`Invalid Sirus version: ${version}`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split('.') ?? [],
  };
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const installed = parseVersion(current);
  for (let index = 0; index < next.core.length; index++) {
    if (next.core[index] !== installed.core[index]) return next.core[index] > installed.core[index];
  }
  if (next.prerelease.length === 0) return installed.prerelease.length > 0;
  if (installed.prerelease.length === 0) return false;
  const identifiers = Math.max(next.prerelease.length, installed.prerelease.length);
  for (let index = 0; index < identifiers; index++) {
    const candidateIdentifier = next.prerelease[index];
    const currentIdentifier = installed.prerelease[index];
    if (candidateIdentifier === undefined) return false;
    if (currentIdentifier === undefined) return true;
    if (candidateIdentifier === currentIdentifier) continue;
    const candidateNumeric = /^\d+$/.test(candidateIdentifier);
    const currentNumeric = /^\d+$/.test(currentIdentifier);
    if (candidateNumeric && currentNumeric) return Number(candidateIdentifier) > Number(currentIdentifier);
    if (candidateNumeric !== currentNumeric) return !candidateNumeric;
    return candidateIdentifier > currentIdentifier;
  }
  return false;
}

export async function checkSirusUpdate(
  signal?: AbortSignal,
  options: Pick<UpdateOptions, 'currentVersion' | 'run'> = {},
): Promise<UpdateCheck> {
  const currentVersion = options.currentVersion ?? manifest.version;
  const run = options.run ?? ((args, runnerSignal) => runNpm(args, runnerSignal, 10_000));
  const lookup = await run(['view', manifest.name, 'version', '--json'], signal);
  if (lookup.code !== 0) {
    throw new Error(`Could not check for updates: ${lookup.stderr.trim() || lookup.stdout.trim() || `npm exited ${lookup.code}`}`);
  }
  const latestVersion = parsePublishedVersion(lookup.stdout);
  return {
    updateAvailable: isNewerVersion(latestVersion, currentVersion),
    currentVersion,
    latestVersion,
  };
}

export async function updateSirus(
  notify: (text: string) => void = () => void 0,
  signal?: AbortSignal,
  options: UpdateOptions = {},
): Promise<UpdateOutcome> {
  const currentVersion = options.currentVersion ?? manifest.version;
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT;
  const run = options.run ?? runNpm;

  if (isSourceCheckout(packageRoot)) {
    throw new Error('This Sirus instance is running from a source checkout. Update it with git pull, then npm install.');
  }

  notify('Checking npm for a newer Sirus release…');
  const check = await checkSirusUpdate(signal, { currentVersion, run });
  const { latestVersion } = check;
  if (!check.updateAvailable) {
    return { updated: false, currentVersion, latestVersion };
  }

  notify(`Updating Sirus ${currentVersion} → ${latestVersion}…`);
  const install = await run([
    'install', '--global', `${manifest.name}@${latestVersion}`, '--no-fund', '--no-audit',
  ], signal);
  if (install.code !== 0) {
    throw new Error(`Sirus update failed: ${install.stderr.trim() || install.stdout.trim() || `npm exited ${install.code}`}`);
  }
  return { updated: true, currentVersion, latestVersion };
}
