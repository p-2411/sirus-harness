import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { abortReason, abortable, throwIfAborted } from '../../../abort';
import { SIRUS_VERSION } from '../../../version';
import { subscriptionEnvironment } from '../profiles';

// The ChatGPT account behind a Codex subscription: signing in, who is signed
// in, and what allowance is left. Conversations run over ACP, which carries
// none of that, so this file talks to `codex app-server` itself: a JSON-RPC
// client over stdio reduced to the account requests, started for one call
// and closed after it. The login lives in Codex's own store; Sirus never
// sees the credential.

type Json = Record<string, unknown>;

type NotificationHandler = (method: string, params: Json) => void;

const TARGET_TRIPLES: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'win32-x64': 'x86_64-pc-windows-msvc',
};

// The Codex binary arrives through the ACP adapter's dependency on
// @openai/codex, which ships it in a per-platform package; fall back to
// whatever `codex` is on PATH.
export function codexBinaryPath(): string {
  const key = `${process.platform}-${process.arch}`;
  const triple = TARGET_TRIPLES[key];
  if (triple) {
    try {
      const require = createRequire(import.meta.url);
      const packageJson = require.resolve(`@openai/codex-${key}/package.json`);
      const binary = path.join(
        path.dirname(packageJson), 'vendor', triple, 'bin',
        process.platform === 'win32' ? 'codex.exe' : 'codex',
      );
      if (existsSync(binary)) return binary;
    } catch {
      // not installed for this platform; use PATH below
    }
  }
  return 'codex';
}

// Newline-delimited JSON-RPC: client requests with ids, server notifications
// without, and the odd server-initiated request, which nothing here can
// answer and is declined.
export class CodexRpc {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private notificationHandlers = new Set<NotificationHandler>();
  private stderrTail: string[] = [];
  private exited: Error | null = null;
  private readonly onProcessExit = () => this.close();

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    // A Sirus process that dies mid-call must not leave an app-server behind.
    process.once('exit', this.onProcessExit);

    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) this.dispatch(line);
        newline = buffer.indexOf('\n');
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail.push(...chunk.split('\n').filter(Boolean));
      this.stderrTail = this.stderrTail.slice(-20);
    });
    child.on('exit', (code, signal) => {
      this.fail(new Error(
        `codex app-server exited (${signal ?? code})${this.stderrTail.length ? `: ${this.stderrTail.join(' | ')}` : ''}`,
      ));
    });
    child.on('error', error => {
      this.fail(new Error(`codex app-server failed to start: ${error.message}`));
    });
  }

  // An app-server on the profile's store, initialized. A profile other than
  // the default keeps its login in a file: the keychain entry belongs to
  // the default profile.
  static async start(profile = 'default'): Promise<CodexRpc> {
    const args = ['app-server', '--listen', 'stdio://'];
    if (profile !== 'default') args.push('-c', 'cli_auth_credentials_store="file"');
    const child = spawn(codexBinaryPath(), args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: subscriptionEnvironment('gpt', profile),
    });
    const rpc = new CodexRpc(child);
    await rpc.request('initialize', {
      clientInfo: { name: 'sirus', title: 'Sirus', version: SIRUS_VERSION },
    });
    rpc.notify('initialized');
    return rpc;
  }

  request<T = unknown>(method: string, params: Json = {}): Promise<T> {
    if (this.exited) return Promise.reject(this.exited);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: Json = {}): void {
    this.write({ method, params });
  }

  // Resolves when a notification satisfying the predicate arrives.
  waitForNotification(
    method: string,
    predicate: (params: Json) => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Json> {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const settle = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.notificationHandlers.delete(handler);
      };
      const timer = setTimeout(() => {
        settle();
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      // A wait must not keep the CLI alive after the app-server is gone.
      timer.unref();
      const onAbort = () => {
        settle();
        reject(abortReason(signal!));
      };
      const handler: NotificationHandler = (incoming, params) => {
        if (incoming !== method || !predicate(params)) return;
        settle();
        resolve(params);
      };
      this.notificationHandlers.add(handler);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  close(): void {
    process.off('exit', this.onProcessExit);
    if (!this.exited) this.child.kill();
  }

  private fail(error: Error): void {
    this.exited = error;
    process.off('exit', this.onProcessExit);
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  private write(message: Json): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private dispatch(line: string): void {
    let message: Json;
    try {
      message = JSON.parse(line) as Json;
    } catch {
      return; // not protocol traffic
    }
    const id = message.id;
    const method = message.method;
    const params = (message.params ?? {}) as Json;

    if (typeof method === 'string' && id !== undefined) {
      this.write({ id, error: { code: -32601, message: `Unsupported request: ${method}` } });
      return;
    }
    if (typeof method === 'string') {
      for (const handler of this.notificationHandlers) handler(method, params);
      return;
    }
    if (typeof id === 'number') {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      const error = message.error as { message: string } | undefined;
      if (error) pending.reject(new Error(error.message));
      else pending.resolve(message.result);
    }
  }
}

// One call, one app-server: started, used, closed. Starting one takes a
// fifth of a second, so nothing is kept between calls.
async function withCodex<T>(
  profile: string,
  signal: AbortSignal | undefined,
  work: (rpc: CodexRpc) => Promise<T>,
): Promise<T> {
  throwIfAborted(signal);
  const rpc = await abortable(CodexRpc.start(profile), signal);
  try {
    return await abortable(work(rpc), signal);
  } finally {
    rpc.close();
  }
}

export interface CodexAccount {
  type: string;
  email?: string | null;
  planType?: string;
}

async function readAccount(rpc: CodexRpc): Promise<CodexAccount | null> {
  const response = await rpc.request<Json>('account/read', { refreshToken: false });
  return (response.account as CodexAccount | null) ?? null;
}

export function readCodexAccount(profile = 'default', signal?: AbortSignal): Promise<CodexAccount | null> {
  return withCodex(profile, signal, readAccount);
}

// The raw `account/rateLimits/read` response; `../usage.ts` normalises it.
export function readCodexRateLimits(profile = 'default', signal?: AbortSignal): Promise<unknown> {
  return withCodex(profile, signal, rpc => rpc.request('account/rateLimits/read'));
}

// Signs the profile in to ChatGPT in the browser, or reports the account
// already there. `onAuthUrl` gets the sign-in link as soon as Codex has one.
export function loginCodex(
  profile: string,
  onAuthUrl: (url: string) => void,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CodexAccount> {
  return withCodex(profile, signal, async rpc => {
    const existing = await readAccount(rpc);
    if (existing?.type === 'chatgpt') return existing;
    const start = await rpc.request<Json>('account/login/start', { type: 'chatgpt' });
    const loginId = start.loginId;
    onAuthUrl(String(start.authUrl));
    // Told before the process goes, so Codex ends the browser flow cleanly.
    const cancelLogin = () => { void rpc.request('account/login/cancel', { loginId }).catch(() => void 0); };
    signal?.addEventListener('abort', cancelLogin, { once: true });
    let completed: Json;
    try {
      completed = await rpc.waitForNotification(
        'account/login/completed',
        params => params.loginId === loginId,
        timeoutMs,
        signal,
      );
    } finally {
      signal?.removeEventListener('abort', cancelLogin);
    }
    if (!completed.success) {
      throw new Error(`ChatGPT login failed: ${String(completed.error ?? 'unknown error')}`);
    }
    const account = await readAccount(rpc);
    if (account?.type !== 'chatgpt') throw new Error('ChatGPT login did not complete');
    return account;
  });
}
