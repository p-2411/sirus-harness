import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { TurnCancelledError } from '../../src/abort';
import { startAcpRuntime } from '../../src/agent_runtime/runtime/acp';
import type { Launch } from '../../src/agent_runtime/runtime/launch';
import type { RuntimeOptions, RuntimeUpdate } from '../../src/agent_runtime/runtime/runtime';

// The ACP client against a stand-in for a vendor's adapter, run as a real
// child process: newline-delimited JSON-RPC on stdio, doing what its script
// says. `hang` names a request it never answers. Each entry of `prompts` is
// what one `session/prompt` does, step by step: stream an update, wait for
// the client's `session/cancel`, or end the turn with a stop reason
// (`end_turn` when the steps run out).
const STAND_IN_ADAPTER = `
const script = JSON.parse(process.env.STAND_IN_SCRIPT);
require('fs').writeFileSync(process.env.STAND_IN_PID_FILE, String(process.pid));
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
const cancels = [];
let prompts = 0;
async function prompt(id, sessionId) {
  let stopReason = 'end_turn';
  for (const step of script.prompts?.[prompts++] ?? []) {
    if (step === 'cancel') await new Promise(resolve => cancels.push(resolve));
    else if (step.update) send({ method: 'session/update', params: { sessionId, update: step.update } });
    else if (step.stop) stopReason = step.stop;
  }
  send({ id, result: { stopReason } });
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (let newline = buffer.indexOf('\\n'); newline !== -1; newline = buffer.indexOf('\\n')) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.method === script.hang) continue;
    if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: script.forkDelayMs === undefined ? {} : { sessionCapabilities: { fork: {} } } } });
    else if (message.method === 'session/new') send({ id: message.id, result: { sessionId: 'stand-in' } });
    else if (message.method === 'session/fork') setTimeout(() => send({ id: message.id, result: { sessionId: 'forked' } }), script.forkDelayMs);
    else if (message.method === 'session/close') {
      require('fs').writeFileSync(process.env.STAND_IN_CLOSE_FILE, message.params.sessionId);
      send({ id: message.id, result: {} });
    }
    else if (message.method === 'session/prompt') void prompt(message.id, message.params.sessionId);
    else if (message.method === 'session/cancel') cancels.splice(0).forEach(resolve => resolve());
    else if (message.id !== undefined) send({ id: message.id, result: {} });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

type Step = { update: SessionUpdate } | { stop: string } | 'cancel';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'sirus-acp-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function standIn(script: { hang?: string; prompts?: Step[][]; forkDelayMs?: number }): Launch {
  return {
    command: process.execPath,
    args: ['-e', STAND_IN_ADAPTER],
    env: { ...process.env, STAND_IN_SCRIPT: JSON.stringify(script), STAND_IN_PID_FILE: path.join(directory, 'pid'), STAND_IN_CLOSE_FILE: path.join(directory, 'closed') },
    mode: 'ask',
    session: () => ({ mcpServers: [] }),
    forkNeedsResume: false,
  };
}

function runtimeOptions(updates: RuntimeUpdate[] = []): RuntimeOptions {
  return {
    vendor: 'claude',
    model: 'stand-in',
    thinkingLevel: 'high',
    directory,
    systemPrompt: '',
    env: {},
    mcpServer: null,
    permissionMode: 'ask',
    onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    onUpdate: update => { updates.push(update); },
  };
}

async function until<T>(read: () => T | false | undefined, what: string): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function adapterPid(): Promise<number> {
  const file = path.join(directory, 'pid');
  return until(() => existsSync(file) && Number(readFileSync(file, 'utf8')), 'the adapter to start');
}

const text = (value: string): SessionUpdate => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } });

const textsIn = (updates: readonly RuntimeUpdate[]): string[] =>
  updates.flatMap(update => update.type === 'text' ? [update.text] : []);

// The next prompt waits for the cancelled one's answer, and the adapter goes
// on streaming that turn until it gives it. None of that is the next reply's.
test('what a cancelled prompt still streams stays out of the next one', async () => {
  const updates: RuntimeUpdate[] = [];
  const runtime = await startAcpRuntime(runtimeOptions(updates), standIn({
    prompts: [
      [
        { update: text('Working') },
        'cancel',
        { update: text('Stale') },
        { update: { sessionUpdate: 'tool_call', toolCallId: 'stale-call', title: 'Read notes.txt', kind: 'read', status: 'in_progress' } },
        { update: { sessionUpdate: 'usage_update', used: 1_200, size: 200_000 } },
        { stop: 'cancelled' },
      ],
      [{ update: text('Fresh') }],
    ],
  }));
  try {
    const controller = new AbortController();
    const first = runtime.prompt({ text: 'First', images: [] }, controller.signal);
    await until(() => textsIn(updates).includes('Working'), 'the first turn to stream');
    const cancelledAt = updates.length;
    controller.abort(new TurnCancelledError());
    await expect(first).rejects.toThrow('Cancelled');
    await runtime.prompt({ text: 'Second', images: [] }, new AbortController().signal);
    const since = updates.slice(cancelledAt);
    expect(textsIn(since)).toEqual(['Fresh']);
    expect(since.some(update => update.type === 'tool_call')).toBe(false);
    // What the session reports between turns still arrives.
    expect(since).toContainEqual({ type: 'context', usage: { tokens: 1_200, window: 200_000 } });
  } finally {
    runtime.dispose();
  }
});

// The transcript holds a turn's tool calls, diffs and output included; the
// client needs them only to merge the turn's own updates, so it lets them go
// with the turn. A later update for one of them starts from nothing.
test('a finished turn keeps none of its tool calls', async () => {
  const updates: RuntimeUpdate[] = [];
  const runtime = await startAcpRuntime(runtimeOptions(updates), standIn({
    prompts: [
      [
        { update: { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Read notes.txt', kind: 'read', status: 'in_progress' } },
        {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-1',
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: 'the whole file' } }],
          },
        },
      ],
      [{ update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'failed' } }],
    ],
  }));
  try {
    await runtime.prompt({ text: 'First', images: [] }, new AbortController().signal);
    expect(updates.at(-1)).toMatchObject({ type: 'tool_call', call: { title: 'Read notes.txt', status: 'completed' } });
    await runtime.prompt({ text: 'Second', images: [] }, new AbortController().signal);
    expect(updates.at(-1)).toEqual({
      type: 'tool_call',
      call: { type: 'tool_call', id: 'call-1', title: '', kind: 'other', status: 'failed', locations: [], content: [] },
    });
  } finally {
    runtime.dispose();
  }
});

test('cancelling a turn ends an adapter that never finishes starting', async () => {
  const controller = new AbortController();
  const starting = startAcpRuntime({ ...runtimeOptions(), signal: controller.signal }, standIn({ hang: 'initialize' }));
  const pid = await adapterPid();
  try {
    controller.abort(new TurnCancelledError());
    const outcome = await Promise.race([
      starting.then(() => 'started', (error: unknown) => error),
      new Promise(resolve => setTimeout(() => resolve('still starting'), 3_000)),
    ]);
    expect(outcome).toBeInstanceOf(TurnCancelledError);
    await until(() => !alive(pid), 'the adapter to exit');
  } finally {
    if (alive(pid)) process.kill(pid, 'SIGKILL');
  }
});

test('cancelling a pending fork closes its late session and leaves the owner usable', async () => {
  const runtime = await startAcpRuntime(runtimeOptions(), standIn({ forkDelayMs: 60 }));
  try {
    const controller = new AbortController();
    const fork = runtime.fork({ ...runtimeOptions(), setupSignal: controller.signal });
    controller.abort(new TurnCancelledError());
    await expect(fork).rejects.toThrow('Cancelled');
    await until(() => existsSync(path.join(directory, 'closed')), 'late fork to close');
    expect(readFileSync(path.join(directory, 'closed'), 'utf8')).toBe('forked');
    await expect(runtime.prompt({ text: 'Still here', images: [] }, new AbortController().signal)).resolves.toBeDefined();
  } finally {
    runtime.dispose();
  }
});
