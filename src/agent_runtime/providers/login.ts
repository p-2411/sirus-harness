import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { abortReason, throwIfAborted } from '../../abort';
import { VENDOR_INFO, type Vendor } from './catalog';
import { loginCodex, readCodexAccount, type CodexAccount } from './openai/codex-account';
import { subscriptionEnvironment } from './profiles';
import type { SourceStore } from './sources';

// Sign-in runs through each vendor's own flow: Claude Code's `auth login`
// command and Codex's `account/login/start`. Sirus only learns whether the
// login succeeded; the credentials stay in the vendors' stores.

// The first sign-in owns the vendor's default profile directory; every later
// one gets an isolated profile of its own, so accounts never share a store.
function nextProfile(sources: SourceStore): string {
  return sources.list().some(source => source.kind === 'subscription') ? randomUUID() : 'default';
}

export type Notify = (text: string) => void;

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  subscriptionType?: string;
}

// The Agent SDK's platform package ships the Claude Code binary. Logging in
// through it lands in the store the ACP adapter's Claude Code reads, so the
// login and the runtimes share one credential.
function claudeBinaryPath(): string {
  try {
    const require = createRequire(import.meta.url);
    const packageJson = require.resolve(
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`,
    );
    const binary = path.join(path.dirname(packageJson), process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (existsSync(binary)) return binary;
  } catch {
    // no platform package; use PATH below
  }
  return 'claude';
}

function runClaude(
  args: string[],
  onOutput?: (line: string) => void,
  signal?: AbortSignal,
  profile = 'default',
): Promise<{ code: number; stdout: string; stderr: string }> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBinaryPath(), args, { stdio: ['pipe', 'pipe', 'pipe'], env: subscriptionEnvironment('claude', profile) });
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
    const timer = setTimeout(() => {
      fail(new Error('Claude login timed out'));
    }, LOGIN_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (onOutput) {
        for (const line of chunk.split('\n')) {
          const trimmed = line.trim();
          if (trimmed) onOutput(trimmed);
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', error => {
      fail(new Error(`Could not run Claude: ${error.message}`));
    });
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

async function claudeStatus(signal?: AbortSignal, profile = 'default'): Promise<ClaudeAuthStatus> {
  const { code, stdout, stderr } = await runClaude(['auth', 'status', '--json'], undefined, signal, profile);
  try {
    return JSON.parse(stdout) as ClaudeAuthStatus;
  } catch {
    throw new Error(`Could not read Claude login status${code ? ` (exit ${code})` : ''}: ${stderr.trim() || stdout.trim()}`);
  }
}

function claudePlan(status: ClaudeAuthStatus): string {
  return status.subscriptionType ? `${status.subscriptionType} plan` : 'subscription';
}

function describeClaude(status: ClaudeAuthStatus): string {
  return `Signed in to ${VENDOR_INFO.claude.accountName}${status.email ? ` as ${status.email}` : ''} (${claudePlan(status)}).`;
}

async function loginClaude(sources: SourceStore, notify: Notify, signal?: AbortSignal): Promise<string> {
  const profile = nextProfile(sources);
  let status = await claudeStatus(signal, profile);
  if (!(status.loggedIn && status.authMethod === 'claude.ai')) {
    notify('Opening the browser…');
    const { code, stderr } = await runClaude(['auth', 'login', '--claudeai'], line => {
      // surface the login URL for terminals where the browser can't open
      if (line.includes('http')) notify(line);
    }, signal, profile);
    if (code !== 0) {
      throw new Error(`Claude login failed: ${stderr.trim() || `exit ${code}`}`);
    }
    status = await claudeStatus(signal, profile);
    if (!(status.loggedIn && status.authMethod === 'claude.ai')) {
      throw new Error('Claude login did not complete with a Claude subscription account');
    }
  }
  sources.addSubscription(profile, status.email);
  return describeClaude(status);
}

function gptPlan(account: CodexAccount): string {
  return account.planType ? `${account.planType} plan` : 'subscription';
}

function describeGpt(account: CodexAccount): string {
  return `Signed in to ${VENDOR_INFO.gpt.accountName}${account.email ? ` as ${account.email}` : ''} (${gptPlan(account)}).`;
}

function openInBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
    : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => void 0).unref();
  } catch {
    // the URL is shown to the user anyway
  }
}

async function loginGpt(sources: SourceStore, notify: Notify, signal?: AbortSignal): Promise<string> {
  const profile = nextProfile(sources);
  const account = await loginCodex(profile, url => {
    notify(`Sign in at ${url}`);
    openInBrowser(url);
  }, LOGIN_TIMEOUT_MS, signal);
  sources.addSubscription(profile, account.email ?? undefined);
  return describeGpt(account);
}

export async function login(
  vendor: Vendor,
  sources: SourceStore,
  notify: Notify,
  signal?: AbortSignal,
): Promise<string> {
  switch (vendor) {
    case 'claude':
      return loginClaude(sources, notify, signal);
    case 'gpt':
      return loginGpt(sources, notify, signal);
    default: {
      const exhaustive: never = vendor;
      throw new Error(`No login flow for vendor "${String(exhaustive)}"`);
    }
  }
}

// Plan and account for a subscription profile, for /usage.
export async function subscriptionDetail(vendor: Vendor, profile = 'default', signal?: AbortSignal): Promise<string> {
  switch (vendor) {
    case 'claude': {
      const status = await claudeStatus(signal, profile);
      if (!status.loggedIn) return `signed out of ${VENDOR_INFO.claude.accountName} Code`;
      return [claudePlan(status), status.email].filter(Boolean).join(' · ');
    }
    case 'gpt': {
      const account = await readCodexAccount(profile, signal);
      if (account?.type !== 'chatgpt') return `signed out of ${VENDOR_INFO.gpt.accountName}`;
      return [gptPlan(account), account.email].filter(Boolean).join(' · ');
    }
    default: {
      const exhaustive: never = vendor;
      throw new Error(`No subscription detail for vendor "${String(exhaustive)}"`);
    }
  }
}
