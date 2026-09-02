import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { abortReason, throwIfAborted } from '../../../abort';

// Minimal JSON-RPC client for `codex app-server` over stdio: newline-delimited
// JSON, client requests with ids, server notifications without ids, and
// server-initiated requests (tool calls, approvals) that we must answer.

type Json = Record<string, unknown>;

interface RpcError {
  code: number;
  message: string;
}

type NotificationHandler = (method: string, params: Json) => void;
type RequestHandler = (params: Json) => Promise<unknown>;

const TARGET_TRIPLES: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'win32-x64': 'x86_64-pc-windows-msvc',
};

// The pinned @openai/codex package ships the binary in a per-platform
// package; fall back to whatever `codex` is on PATH.
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

function toToml(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export class CodexRpc {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private notificationHandlers = new Set<NotificationHandler>();
  private requestHandlers = new Map<string, RequestHandler>();
  private stderrTail: string[] = [];
  private exited: Error | null = null;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;

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
      this.exited = new Error(
        `codex app-server exited (${signal ?? code})${this.stderrTail.length ? `: ${this.stderrTail.join(' | ')}` : ''}`,
      );
      for (const { reject } of this.pending.values()) reject(this.exited);
      this.pending.clear();
    });
    child.on('error', error => {
      this.exited = new Error(`codex app-server failed to start: ${error.message}`);
      for (const { reject } of this.pending.values()) reject(this.exited);
      this.pending.clear();
    });
  }

  // Process-wide config overrides (`-c key=value`), for settings Codex reads
  // once at startup rather than per thread.
  static async start(
    clientInfo: { name: string; title: string; version: string },
    configOverrides: Record<string, unknown> = {},
  ): Promise<CodexRpc> {
    const overrideArgs = Object.entries(configOverrides).flatMap(([key, value]) => ['-c', `${key}=${toToml(value)}`]);
    const child = spawn(codexBinaryPath(), ['app-server', '--listen', 'stdio://', ...overrideArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    const rpc = new CodexRpc(child);
    process.once('exit', () => rpc.close());

    await rpc.request('initialize', {
      clientInfo,
      capabilities: {
        // dynamicTools on thread/start is gated behind experimentalApi
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [
          'item/reasoning/summaryTextDelta',
          'item/reasoning/summaryPartAdded',
          'item/reasoning/textDelta',
          'thread/tokenUsage/updated',
        ],
      },
    });
    rpc.notify('initialized', {});
    return rpc;
  }

  get isAlive(): boolean {
    return this.exited === null;
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

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
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
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        unsubscribe();
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        unsubscribe();
        reject(abortReason(signal!));
      };
      const unsubscribe = this.onNotification((incoming, params) => {
        if (incoming === method && predicate(params)) {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          unsubscribe();
          resolve(params);
        }
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  close(): void {
    if (!this.exited) this.child.kill();
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
      const handler = this.requestHandlers.get(method);
      if (!handler) {
        this.write({ id, error: { code: -32601, message: `Unsupported request: ${method}` } });
        return;
      }
      handler(params).then(
        result => this.write({ id, result }),
        (error: unknown) => this.write({
          id,
          error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
        }),
      );
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
      const error = message.error as RpcError | undefined;
      if (error) {
        pending.reject(new Error(error.message));
      } else {
        pending.resolve(message.result);
      }
    }
  }
}
