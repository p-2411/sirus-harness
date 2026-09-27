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
    if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    else if (message.method === 'session/new') send({ id: message.id, result: { sessionId: 'stand-in' } });
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

function standIn(script: { hang?: string; prompts?: Step[][] }): Launch {
  return {
    command: process.execPath,
    args: ['-e', STAND_IN_ADAPTER],
    env: { ...process.env, STAND_IN_SCRIPT: JSON.stringify(script), STAND_IN_PID_FILE: path.join(directory, 'pid') },
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

test('cancelling a turn ends an adapter that never finishes starting', async () => {
  const controller = new AbortController();
  const starting = startAcpRuntime(runtimeOptions(), controller.signal, standIn({ hang: 'initialize' }));
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
