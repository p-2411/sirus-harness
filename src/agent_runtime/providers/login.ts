import { randomUUID } from 'crypto';
import { subscriptionEnvironment } from './profiles';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { providerFor, type Vendor } from './providers';
import { getCodexRpc } from './openai/codex-subscription';
import { abortReason, abortable, throwIfAborted } from '../../abort';

// Sign-in runs through each provider's own flow: Claude Code's `auth login`
// command and Codex's `account/login/start`. Sirus only learns whether the
// login succeeded; the credentials stay in the providers' stores.

function nextProfile(vendor: Vendor): string {
  return providerFor(vendor).sources().some(source => source.type === 'subscription') ? randomUUID() : 'default';
}

export type Notify = (text: string) => void;

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  subscriptionType?: string;
}

// The Agent SDK ships Claude Code in a per-platform package; the same binary
// handles login so the SDK's requests and the login share one credential.
export function claudeBinaryPath(): string {
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
  return `Signed in to Claude${status.email ? ` as ${status.email}` : ''} (${claudePlan(status)}).`;
}

export async function loginClaude(notify: Notify, signal?: AbortSignal): Promise<string> {
  const profile = nextProfile('claude');
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
  providerFor('claude').addSubscription(profile, status.email);
  return describeClaude(status);
}

type Json = Record<string, unknown>;

interface CodexAccount {
  type: string;
  email?: string | null;
  planType?: string;
}

async function codexAccount(signal?: AbortSignal, profile = 'default'): Promise<CodexAccount | null> {
  const rpc = await abortable(getCodexRpc(profile), signal);
  const response = await abortable(rpc.request<Json>('account/read', { refreshToken: false }), signal);
  return (response.account as CodexAccount | null) ?? null;
}

function gptPlan(account: CodexAccount): string {
  return account.planType ? `${account.planType} plan` : 'subscription';
}

function describeGpt(account: CodexAccount): string {
  return `Signed in to ChatGPT${account.email ? ` as ${account.email}` : ''} (${gptPlan(account)}).`;
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

export async function loginGpt(notify: Notify, signal?: AbortSignal): Promise<string> {
  const profile = nextProfile('gpt');
  let account = await codexAccount(signal, profile);
  if (account?.type !== 'chatgpt') {
    const rpc = await abortable(getCodexRpc(profile), signal);
    const start = await abortable(rpc.request<Json>('account/login/start', { type: 'chatgpt' }), signal);
    const loginId = start.loginId;
    const authUrl = String(start.authUrl);
    notify(`Sign in at ${authUrl}`);
    openInBrowser(authUrl);
    const cancelLogin = () => {
      void rpc.request('account/login/cancel', { loginId }).catch(() => void 0);
    };
    signal?.addEventListener('abort', cancelLogin, { once: true });
    let completed;
    try {
      completed = await rpc.waitForNotification(
        'account/login/completed',
        params => params.loginId === loginId,
        LOGIN_TIMEOUT_MS,
        signal,
      );
    } finally {
      signal?.removeEventListener('abort', cancelLogin);
    }
    if (!completed.success) {
      throw new Error(`ChatGPT login failed: ${String(completed.error ?? 'unknown error')}`);
    }
    account = await codexAccount(signal, profile);
    if (account?.type !== 'chatgpt') {
      throw new Error('ChatGPT login did not complete');
    }
  }
  providerFor('gpt').addSubscription(profile, account.email ?? undefined);
  return describeGpt(account);
}

export async function login(vendor: Vendor, notify: Notify, signal?: AbortSignal): Promise<string> {
  return vendor === 'claude' ? loginClaude(notify, signal) : loginGpt(notify, signal);
}

// Plan and account for a provider already in subscription mode, for /usage.
export async function subscriptionDetail(vendor: Vendor, signal?: AbortSignal, profile = 'default'): Promise<string> {
  if (vendor === 'claude') {
    const status = await claudeStatus(signal, profile);
    if (!status.loggedIn) return 'signed out of Claude Code';
    return [claudePlan(status), status.email].filter(Boolean).join(' · ');
  }
  const account = await codexAccount(signal, profile);
  if (account?.type !== 'chatgpt') return 'signed out of ChatGPT';
  return [gptPlan(account), account.email].filter(Boolean).join(' · ');
}
