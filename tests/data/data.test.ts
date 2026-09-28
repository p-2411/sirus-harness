import { afterEach, describe, expect, jest, setSystemTime, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import * as checkpoints from '../../src/checkpoints';
import * as naming from '../../src/agent_runtime/session/naming';
import * as launch from '../../src/agent_runtime/runtime/launch';
import * as acp from '../../src/agent_runtime/runtime/acp';
import { startAcpRuntime } from '../../src/agent_runtime/runtime/acp';
import { pendingQuestions, questionFields, requestAnswers, resolveQuestion } from '../../src/agent_runtime/permissions/questions';
import { invalidateAllRuntimes, type Runtime, type RuntimeOptions, type RuntimeUpdate } from '../../src/agent_runtime/runtime/runtime';
import type { Draft } from '../../src/agent_runtime/session/timeline';
import { Session } from '../../src/agent_runtime/session';
import { sirusMcpServerEntry } from '../../src/agent_runtime/tools/server';
import { findSubagent } from '../../src/agent_runtime/tools/subagents';
import { subagentDone, TOOL_WAIT_LIMIT_MS } from '../../src/agent_runtime/tools/subagents/run';
import * as worktree from '../../src/agent_runtime/tools/subagents/worktree';
import { textOf } from '../../src/agent_runtime/types';
import { bindScriptedRuntime, textTurn, unbindRuntime, type ScriptedTurn } from '../support/runtime';

const testModel = 'test-session-model';
const secondTestModel = 'test-second-session-model';
const thirdTestModel = 'test-third-session-model';

// A worker's runtime starts with the subagent contract; that is how a
// scripted turn shared by an owner and its workers tells them apart.
const isWorker = (options: RuntimeOptions) => options.systemPrompt.includes('You are a Sirus subagent');

// Workers finish on their own and the report they set off is a turn nobody
// awaits, so what follows one is waited for rather than assumed.
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

afterEach(() => {
  unbindRuntime(testModel);
  unbindRuntime(secondTestModel);
  unbindRuntime(thirdTestModel);
});

test('ACP opts into notices and routes early notices to the session being opened', async () => {
  const adapter = `
    import { createInterface } from 'node:readline';
    const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
    const update = (sessionId, update) => send({ method: 'session/update', params: { sessionId, update } });
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      const reply = result => send({ id: request.id, result });
      if (request.method === 'initialize') {
        if (!request.params.clientCapabilities.session.notices) throw new Error('Notices were not advertised');
        reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { fork: {} } } });
      } else if (request.method === 'session/new' || request.method === 'session/fork') {
        const sessionId = request.method === 'session/new' ? 'owner' : 'worker';
        update(sessionId, { sessionUpdate: 'notice', severity: 'info', title: sessionId + ' opening' });
        reply({ sessionId });
      } else if (request.method === 'session/prompt') {
        const sessionId = request.params.sessionId;
        update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Before' } });
        update(sessionId, { sessionUpdate: 'notice', severity: 'warning', title: 'Warning', description: null });
        update(sessionId, { sessionUpdate: 'notice', severity: 'vendor-hint', title: 'Hint', description: 'Details' });
        update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'After' } });
        reply({ stopReason: 'end_turn' });
      } else if (request.id !== undefined) reply({});
    }
  `;
  const spec = spyOn(launch, 'launchFor').mockImplementation(options => ({
    command: process.execPath,
    args: ['-e', adapter],
    env: options.env,
    mode: options.permissionMode,
    session: () => ({ mcpServers: [] }),
    forkNeedsResume: false,
  }));
  const updates: RuntimeUpdate[] = [];
  const workerUpdates: RuntimeUpdate[] = [];
  const options: RuntimeOptions = {
    vendor: 'gpt', model: 'gpt-5.6-luna', thinkingLevel: 'high', directory: process.cwd(),
    systemPrompt: '', env: { ...process.env }, mcpServer: null, permissionMode: 'auto',
    onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    onUpdate: update => { updates.push(update); },
  };
  let runtime: Runtime | undefined;
  try {
    runtime = await startAcpRuntime(options);
    expect(runtime.sessionId).toBe('owner');
    expect(updates).toEqual([{ type: 'notice', severity: 'info', title: 'owner opening' }]);
    const worker = await runtime.fork({ ...options, onUpdate: update => { workerUpdates.push(update); } });
    expect(worker.sessionId).toBe('worker');
    expect(workerUpdates).toEqual([{ type: 'notice', severity: 'info', title: 'worker opening' }]);
    expect(updates).toHaveLength(1);
    await worker.prompt({ text: 'Inspect', images: [] }, new AbortController().signal);
    expect(workerUpdates.slice(1)).toEqual([
      { type: 'text', text: 'Before' },
      { type: 'notice', severity: 'warning', title: 'Warning' },
      { type: 'notice', severity: 'vendor-hint', title: 'Hint', description: 'Details' },
      { type: 'text', text: 'After' },
    ]);
    expect(updates).toHaveLength(1);
  } finally {
    runtime?.dispose();
    spec.mockRestore();
  }
});

test.each([
  ['response', 2], ['usage_updates', 2], ['usage_updates', 1],
] as const)('ACP reports a turn’s usage from the %s after %d model calls, its cost, its model’s efforts and Claude’s MCP servers', async (turnTokens, calls) => {
  const adapter = `
    import { createInterface } from 'node:readline';
    const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
    const update = update => send({ method: 'session/update', params: { sessionId: 's', update } });
    const configOptions = [
      { id: 'model', name: 'Model', type: 'select', currentValue: 'chosen', options: [{ value: 'chosen', name: 'Chosen' }] },
      { id: 'effort', name: 'Effort', type: 'select', currentValue: 'high', options: ['low', 'medium', 'high'].map(value => ({ value, name: value })) },
    ];
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      const reply = result => send({ id: request.id, result });
      if (request.method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: {} });
      else if (request.method === 'session/new') reply({ sessionId: 's', configOptions });
      else if (request.method === 'session/prompt') {
        send({ method: '_claude/sdkMessage', params: { sessionId: 's', message: { type: 'system', subtype: 'init',
          mcp_servers: [{ name: 'sirus', status: 'connected' }, { name: 'github', status: 'failed' }] } } });
        update({ sessionUpdate: 'usage_update', used: 100, size: 1000, cost: { amount: 0.5, currency: 'USD' } });
        // Codex repeats a call's count when only its rate limits changed.
        update({ sessionUpdate: 'usage_update', used: 100, size: 1000 });
        if (process.env.CALLS === '2') update({ sessionUpdate: 'usage_update', used: 150, size: 1000, cost: { amount: 0.75, currency: 'USD' } });
        reply({ stopReason: 'end_turn', usage: process.env.CALLS === '2'
          ? { totalTokens: 900, inputTokens: 400, outputTokens: 500, cachedReadTokens: 0 }
          : { totalTokens: 100, inputTokens: 60, outputTokens: 40 } });
      } else if (request.id !== undefined) reply({});
    }
  `;
  const spec = spyOn(launch, 'launchFor').mockImplementation(options => ({
    command: process.execPath, args: ['-e', adapter], env: { ...options.env, CALLS: String(calls) }, mode: options.permissionMode,
    session: () => ({ mcpServers: [] }), forkNeedsResume: false, turnTokens,
  }));
  const updates: RuntimeUpdate[] = [];
  let runtime: Runtime | undefined;
  try {
    runtime = await startAcpRuntime({
      vendor: 'claude', model: 'chosen', thinkingLevel: 'xhigh', directory: process.cwd(),
      systemPrompt: '', env: { ...process.env }, mcpServer: null, permissionMode: 'auto',
      onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      onUpdate: update => { updates.push(update); },
    });
    expect(updates.find(update => update.type === 'efforts')).toEqual({ type: 'efforts', efforts: ['low', 'medium', 'high'], default: 'high' });
    await runtime.prompt({ text: 'Go', images: [] }, new AbortController().signal);
    expect(updates.find(update => update.type === 'mcp_servers')).toEqual({ type: 'mcp_servers', servers: [
      { name: 'sirus', status: 'connected' }, { name: 'github', status: 'failed' },
    ] });
    // Claude's prompt response is the turn's tally. Codex's is its last
    // call's, so a turn of several calls is what their usage updates added
    // up to, without a breakdown; a turn of one call is that call. The cost
    // is what the session's running figure grew by.
    expect(updates.filter(update => update.type === 'usage')).toEqual([{ type: 'usage', usage: turnTokens === 'response'
      ? { inputTokens: 400, outputTokens: 500, cachedReadTokens: 0, totalTokens: 900, costUsd: 0.75 }
      : calls === 2 ? { totalTokens: 250, costUsd: 0.75 }
        : { inputTokens: 60, outputTokens: 40, totalTokens: 100, costUsd: 0.5 } }]);
  } finally {
    runtime?.dispose();
    spec.mockRestore();
  }
});

test('ACP leaves a session with no thinking level at its model’s default, and returns to it', async () => {
  const adapter = `
    import { createInterface } from 'node:readline';
    const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
    const configOptions = [
      { id: 'model', name: 'Model', type: 'select', currentValue: 'chosen', options: [{ value: 'chosen', name: 'Chosen' }] },
      { id: 'reasoning_effort', name: 'Effort', type: 'select', currentValue: 'medium', options: ['low', 'medium', 'high'].map(value => ({ value, name: value })) },
    ];
    const efforts = [];
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      const reply = result => send({ id: request.id, result });
      if (request.method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: {} });
      else if (request.method === 'session/new') reply({ sessionId: 's', configOptions });
      else if (request.method === 'session/set_config_option') {
        if (request.params.configId === 'reasoning_effort') efforts.push(request.params.value);
        configOptions.find(option => option.id === request.params.configId).currentValue = request.params.value;
        reply({ configOptions });
      } else if (request.method === 'session/prompt') {
        send({ method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(efforts) } } } });
        reply({ stopReason: 'end_turn' });
      } else if (request.id !== undefined) reply({});
    }
  `;
  const spec = spyOn(launch, 'launchFor').mockImplementation(options => ({
    command: process.execPath, args: ['-e', adapter], env: { ...options.env }, mode: options.permissionMode,
    session: () => ({ mcpServers: [] }), forkNeedsResume: false,
  }));
  const updates: RuntimeUpdate[] = [];
  let runtime: Runtime | undefined;
  const effortsSent = async () => {
    const before = updates.length;
    await runtime!.prompt({ text: 'Go', images: [] }, new AbortController().signal);
    const text = updates.slice(before).find(update => update.type === 'text');
    return JSON.parse(text?.type === 'text' ? text.text : 'null');
  };
  try {
    runtime = await startAcpRuntime({
      vendor: 'gpt', model: 'chosen', directory: process.cwd(),
      systemPrompt: '', env: { ...process.env }, mcpServer: null, permissionMode: 'auto',
      onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      onUpdate: update => { updates.push(update); },
    });
    // Nothing chosen: the effort is never set, and the vendor's pick is the model's default.
    expect(updates.find(update => update.type === 'efforts')).toEqual({ type: 'efforts', efforts: ['low', 'medium', 'high'], default: 'medium' });
    expect(await effortsSent()).toEqual([]);
    await runtime.setThinkingLevel('high');
    await runtime.setThinkingLevel(undefined);
    expect(await effortsSent()).toEqual(['high', 'medium']);
  } finally {
    runtime?.dispose();
    spec.mockRestore();
  }
});

test.each([
  ['claude', 'resume'], ['claude', 'load'], ['gpt', 'resume'], ['gpt', 'load'],
] as const)('ACP %s %s reopens the recorded session without replaying its transcript', async (vendor, method) => {
  const adapter = `
    import { createInterface } from 'node:readline';
    const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
    const update = update => send({ method: 'session/update', params: { sessionId: 'saved-session', update } });
    const requests = [];
    const configOptions = [
      { id: 'model', name: 'Model', type: 'select', currentValue: 'old', options: [{ value: 'chosen', name: 'Chosen' }] },
      { id: '${vendor === 'claude' ? 'effort' : 'reasoning_effort'}', name: 'Thinking', type: 'select', currentValue: 'low', options: [{ value: 'high', name: 'High' }] },
    ];
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      const reply = result => send({ id: request.id, result });
      if (request.method === 'initialize') {
        reply({ protocolVersion: 1, agentCapabilities: {
          loadSession: true, sessionCapabilities: ${method === 'resume' ? '{ resume: {} }' : '{}'},
        } });
      } else if (request.method === 'session/${method}') {
        requests.push(request);
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Old answer' } });
        update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Old reasoning' } });
        update({ sessionUpdate: 'tool_call', toolCallId: 'old-tool', title: 'Old tool', status: 'completed' });
        update({ sessionUpdate: 'plan', entries: [{ content: 'Old plan', priority: 'medium', status: 'completed' }] });
        update({ sessionUpdate: 'compaction_update', compactionId: 'old-compact', status: 'completed' });
        update({ sessionUpdate: 'usage_update', used: 99, size: 1000 });
        update({ sessionUpdate: 'async_task_spawned', asyncTaskId: 'restored-task', name: 'Restored task', state: 'running', canStop: true });
        update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compact history' }] });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Last replayed answer' } });
        reply({ configOptions, modes: {
          currentModeId: 'manual', availableModes: [{ id: 'auto', name: 'Auto', _meta: { kind: 'auto_review' } }],
        } });
      } else if (request.method === 'session/set_mode') {
        requests.push(request);
        reply({});
      } else if (request.method === 'session/set_config_option') {
        requests.push(request);
        configOptions.find(option => option.id === request.params.configId).currentValue = request.params.value;
        reply({ configOptions });
      } else if (request.method === 'session/prompt') {
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(requests) } });
        reply({ stopReason: 'end_turn' });
      } else if (request.id !== undefined) {
        send({ id: request.id, error: { code: -32601, message: 'Unexpected ' + request.method } });
      }
    }
  `;
  const spec = spyOn(launch, 'launchFor').mockImplementation(options => {
    expect(options.directory).toBe('/recorded/project');
    return {
      command: process.execPath, args: ['-e', adapter], env: options.env,
      mode: options.permissionMode, forkNeedsResume: true,
      session: session => {
        expect(session.directory).toBe('/recorded/project');
        return { mcpServers: [], meta: { refreshed: true }, additionalDirectories: ['/skills'] };
      },
    };
  });
  const updates: RuntimeUpdate[] = [];
  let runtime: Runtime | undefined;
  try {
    runtime = await startAcpRuntime({
      vendor, model: 'chosen', thinkingLevel: 'high', directory: '/different/project',
      resume: { sessionId: 'saved-session', directory: '/recorded/project' },
      systemPrompt: '', env: { ...process.env }, mcpServer: null, permissionMode: 'auto',
      onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      onUpdate: update => { updates.push(update); },
    });
    expect(runtime.sessionId).toBe('saved-session');
    expect(runtime.context).toEqual({ tokens: 99, window: 1000 });
    expect(updates.map(update => update.type).sort()).toEqual(['async_task', 'commands', 'context', 'efforts', 'models']);
    await runtime.prompt({ text: 'Continue', images: [] }, new AbortController().signal);
    const answer = updates.at(-1);
    expect(answer?.type).toBe('text');
    const requests = JSON.parse(answer?.type === 'text' ? answer.text : '[]');
    expect(requests.map((request: { method: string }) => request.method)).toEqual([
      `session/${method}`, 'session/set_mode', 'session/set_config_option', 'session/set_config_option',
    ]);
    expect(requests[0].params).toEqual({
      sessionId: 'saved-session', cwd: '/recorded/project', mcpServers: [],
      _meta: { refreshed: true }, additionalDirectories: ['/skills'],
    });
    expect(requests.slice(1).map((request: { params: unknown }) => request.params)).toEqual([
      { sessionId: 'saved-session', modeId: 'auto' },
      { sessionId: 'saved-session', configId: 'model', value: 'chosen' },
      { sessionId: 'saved-session', configId: vendor === 'claude' ? 'effort' : 'reasoning_effort', value: 'high' },
    ]);
  } finally {
    runtime?.dispose();
    spec.mockRestore();
  }
});

test('ACP keeps messages apart, marks a declined call, and reports what the turn used', async () => {
  const adapter = `
    import { createInterface } from 'node:readline';
    const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
    const update = update => send({ method: 'session/update', params: { sessionId: 'owner', update } });
    let promptId;
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      const reply = result => send({ id: request.id, result });
      if (request.id === 'approval') {
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'write-1', status: 'failed', content: [
          { type: 'content', content: { type: 'text', text: 'The user declined.' } },
        ] });
        update({ sessionUpdate: 'usage_update', used: 500, size: 1000, cost: { amount: 0.25, currency: 'USD' } });
        send({ id: promptId, result: { stopReason: 'end_turn', usage: {
          inputTokens: 100, outputTokens: 40, cachedReadTokens: 900, totalTokens: 1040,
        } } });
      } else if (request.method === 'initialize') reply({ protocolVersion: 1 });
      else if (request.method === 'session/new') reply({ sessionId: 'owner' });
      else if (request.method === 'session/prompt') {
        promptId = request.id;
        update({ sessionUpdate: 'agent_message_chunk', messageId: 'first', content: { type: 'text', text: 'task details.' } });
        update({ sessionUpdate: 'agent_message_chunk', messageId: 'second', content: { type: 'text', text: 'What next?' } });
        update({ sessionUpdate: 'tool_call', toolCallId: 'write-1', title: 'Write a.txt', kind: 'edit', status: 'pending',
          locations: [{ path: 'a.txt' }], content: [{ type: 'diff', path: 'a.txt', oldText: null, newText: 'a' }] });
        send({ id: 'approval', method: 'session/request_permission', params: {
          sessionId: 'owner', toolCall: { toolCallId: 'write-1', title: 'Write a.txt', kind: 'edit' },
          options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }, { optionId: 'no', name: 'No', kind: 'reject_once' }],
        } });
      } else if (request.id !== undefined) reply({});
    }
  `;
  const spec = spyOn(launch, 'launchFor').mockImplementation(options => ({
    command: process.execPath, args: ['-e', adapter], env: options.env,
    mode: options.permissionMode, session: () => ({ mcpServers: [] }), forkNeedsResume: false,
  }));
  const updates: RuntimeUpdate[] = [];
  let runtime: Runtime | undefined;
  try {
    runtime = await startAcpRuntime({
      vendor: 'claude', model: 'claude-sonnet-5', thinkingLevel: 'high', directory: process.cwd(),
      systemPrompt: '', env: { ...process.env }, mcpServer: null, permissionMode: 'ask',
      onPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'no' } }),
      onUpdate: update => { updates.push(update); },
    });
    await runtime.prompt({ text: 'Write it', images: [] }, new AbortController().signal);
    expect(updates.filter(update => update.type === 'text')).toEqual([
      { type: 'text', text: 'task details.', messageId: 'first' },
      { type: 'text', text: 'What next?', messageId: 'second' },
    ]);
    // Declined as soon as the user answered, and still declined when the
    // vendor reports the call failed.
    const calls = updates.flatMap(update => update.type === 'tool_call' ? [update.call] : []);
    expect(calls.map(call => [call.status, call.outcome])).toEqual([
      ['pending', undefined], ['pending', 'declined'], ['failed', 'declined'],
    ]);
    // A new file's diff starts at its first line.
    expect(calls[0]?.content[0]).toEqual({ type: 'diff', path: 'a.txt', oldText: null, newText: 'a', line: 1 });
    expect(updates.at(-1)).toEqual({ type: 'usage', usage: {
      inputTokens: 100, outputTokens: 40, cachedReadTokens: 900, totalTokens: 1040, costUsd: 0.25,
    } });
  } finally {
    runtime?.dispose();
    spec.mockRestore();
  }
});

test('ACP resume failure rejects creation so the caller can seed a fresh runtime', async () => {
  const adapter = `
    import { createInterface } from 'node:readline';
    const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      if (request.method === 'initialize') send({ id: request.id, result: {
        protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } },
      } });
      else send({ id: request.id, error: { code: -32603, message: 'Internal error', data: { message: 'Session missing' } } });
    }
  `;
  const spec = spyOn(launch, 'launchFor').mockImplementation(options => ({
    command: process.execPath, args: ['-e', adapter], env: options.env,
    mode: options.permissionMode, session: () => ({ mcpServers: [] }), forkNeedsResume: true,
  }));
  try {
    await expect(startAcpRuntime({
      vendor: 'gpt', model: 'chosen', thinkingLevel: 'high', directory: process.cwd(),
      resume: { sessionId: 'missing', directory: process.cwd() },
      systemPrompt: '', env: { ...process.env }, mcpServer: null, permissionMode: 'auto',
      onPermission: async () => ({ outcome: { outcome: 'cancelled' } }), onUpdate: () => {},
    })).rejects.toThrow('Session missing');
  } finally {
    spec.mockRestore();
  }
});

test.each(['answer', 'withdraw', 'turn-cancel', 'disconnect'] as const)('ACP questions settle and leave the queue after %s', async ending => {
  const adapter = `
    import { createInterface } from 'node:readline';
    const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
    let promptId;
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      const reply = result => send({ id: request.id, result });
      if (request.id === 'question') {
        send({ method: 'session/update', params: { sessionId: 'owner', update: {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(request.result ?? request.error) }
        } } });
        send({ id: promptId, result: { stopReason: 'end_turn' } });
      } else if (request.method === 'initialize') {
        if (!request.params.clientCapabilities.elicitation.form) throw new Error('Forms were not advertised');
        reply({ protocolVersion: 1 });
      } else if (request.method === 'session/new') reply({ sessionId: 'owner' });
      else if (request.method === 'session/prompt') {
        promptId = request.id;
        send({ id: 'question', method: 'elicitation/create', params: {
          sessionId: 'owner', mode: 'form', message: 'Codex needs your input to continue.',
          requestedSchema: { type: 'object', required: ['color'], properties: {
            color: { type: 'string', title: 'Which color?', oneOf: [{ const: 'Blue', title: 'Blue' }, { const: 'None of the above', title: 'None of the above' }] },
            color_note: { type: 'string', _meta: { codex: { role: 'user_note', questionId: 'color' } } }
          } }
        } });
        if ('${ending}' === 'withdraw') setTimeout(() => send({ method: '$/cancel_request', params: { requestId: 'question' } }), 100);
        if ('${ending}' === 'disconnect') setTimeout(() => process.exit(0), 100);
      } else if (request.method === 'session/cancel') send({ id: promptId, result: { stopReason: 'cancelled' } });
      else if (request.id !== undefined) reply({});
    }
  `;
  const spec = spyOn(launch, 'launchFor').mockImplementation(options => ({
    command: process.execPath, args: ['-e', adapter], env: options.env,
    mode: options.permissionMode, session: () => ({ mcpServers: [] }), forkNeedsResume: false,
  }));
  const context = { sessionId: `question-${ending}`, requester: { participant: 'sirus' } };
  const updates: RuntimeUpdate[] = [];
  const controller = new AbortController();
  let runtime: Runtime | undefined;
  let turn: Promise<unknown> | undefined;
  try {
    runtime = await startAcpRuntime({
      vendor: 'gpt', model: 'gpt-5.6-luna', thinkingLevel: 'high', directory: process.cwd(),
      systemPrompt: '', env: { ...process.env }, mcpServer: null, permissionMode: 'auto',
      onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      onElicitation: (request, signal) => requestAnswers(context, request, signal),
      onUpdate: update => { updates.push(update); },
    });
    turn = runtime.prompt({ text: 'Ask', images: [] }, controller.signal).catch(error => error);
    await until(() => pendingQuestions(context.sessionId).length === 1, 'question card');
    const [question] = pendingQuestions(context.sessionId);
    expect(question.fields[0]).toMatchObject({ kind: 'choice', required: true, other: { key: 'color_note', value: 'None of the above' } });
    if (ending === 'answer') {
      expect(resolveQuestion(question.id, { action: 'accept', content: { color: 'None of the above', color_note: 'Purple' } })).toBe(true);
    } else if (ending === 'turn-cancel') controller.abort(new Error('Turn stopped'));
    const result = await turn;
    if (ending === 'disconnect' || ending === 'turn-cancel') expect(result).toBeInstanceOf(Error);
    else expect(result).toEqual({ stopReason: 'end_turn' });
    await until(() => pendingQuestions(context.sessionId).length === 0, 'question withdrawal');
    expect(resolveQuestion(question.id, { action: 'decline' })).toBe(false);
    if (ending === 'answer') expect(updates).toContainEqual({ type: 'text', text: JSON.stringify({ action: 'accept', content: { color: 'None of the above', color_note: 'Purple' } }) });
  } finally {
    controller.abort();
    runtime?.dispose();
    await turn;
    spec.mockRestore();
  }
});

test('question schemas retain choice requirements and fold custom answers', () => {
  const fields = questionFields({
    sessionId: 'owner', mode: 'form', message: 'Choose preferences',
    requestedSchema: { type: 'object', required: ['features'], properties: {
      features: { type: 'array', title: 'Features', minItems: 1, maxItems: 2, items: { type: 'string', enum: ['Search', 'Export'] } },
      custom: { type: 'string', _meta: { _askUserQuestionCustomAnswer: { isCustomAnswer: true, questionId: 'features' } } },
      theme: { type: 'string', title: 'Theme', enum: ['Dark', 'Light'] },
    } },
  });
  expect(fields).toEqual([
    { kind: 'choice', key: 'features', title: 'Features', multiple: true, required: true, minimum: 1, maximum: 2,
      options: [{ value: 'Search', label: 'Search' }, { value: 'Export', label: 'Export' }], other: { key: 'custom' } },
    { kind: 'choice', key: 'theme', title: 'Theme', multiple: false, required: false,
      options: [{ value: 'Dark', label: 'Dark' }, { value: 'Light', label: 'Light' }] },
  ]);
});

describe('Session model', () => {
  test('has a default model', () => {
    const session = new Session();
    expect(session.getModel()).toBe('gpt-5.6-luna');
    // No level until one is chosen: the model runs at its own default.
    expect(session.getThinkingLevel()).toBeUndefined();
  });

  test('tracks thinking levels independently for each participant', () => {
    const session = new Session();
    session.addParticipant('reviewer', 'claude-sonnet-5');

    session.setThinkingLevel('low');
    session.setThinkingLevel('max', '@reviewer');

    expect(session.getThinkingLevel()).toBe('low');
    expect(session.getThinkingLevel('reviewer')).toBe('max');
    expect(session.getParticipants()).toEqual([
      { name: 'sirus', model: 'gpt-5.6-luna', thinkingLevel: 'low' },
      { name: 'reviewer', model: 'claude-sonnet-5', thinkingLevel: 'max' },
    ]);
  });

  test('is owned by the directory where it was created', () => {
    expect(new Session().getDirectory()).toBe(process.cwd());
    expect(new Session({ name: 'Owned', directory: '/projects/owned', autoNamePending: true }).getDirectory()).toBe('/projects/owned');
  });

  test('auto-names a default session from its first prompt but preserves a custom name', async () => {
    bindScriptedRuntime(testModel, textTurn('Done'));
    const generate = spyOn(naming, 'generateSessionName').mockResolvedValue('Queued message workflow');
    try {
      const automatic = new Session({ name: 'Session 3', directory: process.cwd(), model: testModel, autoNamePending: true });
      await automatic.sendMessage({
        role: 'user',
        content: [{ type: 'text', text: '\n  Implement the queued message workflow with tests  \nDo not use this line' }],
      });
      expect(automatic.getName()).toBe('Queued message workflow');

      const custom = new Session({ id: 'custom-name', name: 'Session 9', model: testModel });
      await custom.sendMessage({
        role: 'user',
        content: [{ type: 'text', text: 'This must not replace the name' }],
      });
      expect(custom.getName()).toBe('Session 9');

      const explicitlyNamed = new Session({ name: 'Session 10', directory: process.cwd(), model: testModel, autoNamePending: true });
      explicitlyNamed.setName('Session 10');
      const restored = Session.fromSnapshot(explicitlyNamed.toSnapshot());
      await restored.sendMessage({
        role: 'user',
        content: [{ type: 'text', text: 'Keep the explicit numeric name' }],
      });
      expect(restored.getName()).toBe('Session 10');
      expect(generate).toHaveBeenCalledTimes(1);
    } finally {
      generate.mockRestore();
    }
  });

  test('reports the context the runtime last reported, per participant', async () => {
    bindScriptedRuntime(testModel, (_input, emit) => {
      emit({ type: 'context', usage: { tokens: 120, window: 200_000 } });
      emit({ type: 'text', text: 'First' });
      emit({ type: 'context', usage: { tokens: 300, window: 200_000 } });
    });
    bindScriptedRuntime(secondTestModel, (_input, emit) => {
      emit({ type: 'context', usage: { tokens: 50, window: 400_000 } });
      emit({ type: 'text', text: 'Second' });
    });
    const session = new Session({ id: 'usage', name: 'Usage', model: testModel });
    session.addParticipant('reviewer', secondTestModel);
    expect(session.getContextUsage()).toBeNull();

    await session.sendMessage({ role: 'user', content: [{ type: 'text', text: '@reviewer look' }] });
    expect(session.getContextUsage('reviewer')).toEqual({ tokens: 50, window: 400_000 });
    expect(session.getContextUsage('sirus')).toBeNull();
    // Unnamed, the window is the selected agent's, which the status row shows.
    expect(session.getContextUsage()).toBeNull();
    session.selectParticipant('reviewer');
    expect(session.getContextUsage()).toEqual({ tokens: 50, window: 400_000 });

    session.selectParticipant('sirus');
    await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Now you' }] });
    expect(session.getContextUsage()).toEqual({ tokens: 300, window: 200_000 });
    // Nothing of it survives a restore: the gauge waits for the runtime.
    expect(Session.fromSnapshot(session.toSnapshot()).getContextUsage()).toBeNull();
  });

  test('a window smaller than one already seen for the model is the adapter’s placeholder', async () => {
    // Claude's adapter says 200k until its first reply names the real window.
    // A model of its own: what is learned about a model's window is kept.
    const model = 'test-window-model';
    let window = 200_000;
    bindScriptedRuntime(model, (_input, emit) => {
      emit({ type: 'context', usage: { tokens: 40_000, window } });
      emit({ type: 'text', text: 'Done' });
      window = 1_000_000;
      emit({ type: 'context', usage: { tokens: 40_000, window } });
    });
    try {
      const session = new Session({ model });
      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'First' }] });
      expect(session.getContextUsage()).toEqual({ tokens: 40_000, window: 1_000_000 });
      session.clear();
      window = 200_000;
      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Again' }] });
      expect(session.getContextUsage()).toEqual({ tokens: 40_000, window: 1_000_000 });
    } finally {
      unbindRuntime(model);
    }
  });

  test('a reporting command runs on a throwaway runtime and leaves no turn, checkpoint or record', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'sirus-aside-'));
    const binding = bindScriptedRuntime(testModel, (input, emit) => {
      emit({ type: 'text', text: input.text === '/context' ? 'Context: 12k of 200k' : 'Answer' });
    });
    try {
      // Before any turn there is no conversation to fork: a fresh runtime of
      // its own answers, and the participant's is left alone.
      const session = new Session({ model: testModel, directory });
      const cold = await session.runCommandAside('sirus', '/context', new AbortController().signal);
      expect(cold.text).toBe('Context: 12k of 200k');
      expect(binding.starts).toHaveLength(1);
      expect(binding.runtimes[0].disposed).toBe(true);
      expect(session.isEmpty()).toBe(true);

      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Hello' }] });
      const messages = session.getMessages().length;
      const checkpoints = session.getCheckpoints().length;
      const output = await session.runCommandAside('sirus', '/context', new AbortController().signal);
      expect(output.text).toBe('Context: 12k of 200k');
      // A fork of the participant's runtime, closed once it has answered.
      expect(binding.forks).toHaveLength(1);
      expect(binding.runtimes.at(-1)!.prompts.map(prompt => prompt.text)).toEqual(['/context']);
      expect(binding.runtimes.at(-1)!.disposed).toBe(true);
      expect(binding.runtimes[1].disposed).toBe(false);
      expect(session.getMessages()).toHaveLength(messages);
      expect(session.getCheckpoints()).toHaveLength(checkpoints);
      expect(binding.runtimes[1].prompts.map(prompt => prompt.text)).toEqual(['Hello']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('changing a participant model changes it for that session only', () => {
    const a = new Session({ name: 'A' });
    const b = new Session({ name: 'B' });
    a.changeParticipantModel('sirus', 'claude-fable-5-1');
    expect(a.getModel()).toBe('claude-fable-5-1');
    expect(b.getModel()).toBe('gpt-5.6-luna');
  });

  test('keeps the subagent model as a session setting', () => {
    const session = new Session({ name: 'Delegation' });
    expect(session.getSubagentModel()).toBeNull();
    session.setSubagentModel('claude-sonnet-5');
    expect(session.getSubagentModel()).toBe('claude-sonnet-5');
    expect(Session.fromSnapshot(session.toSnapshot()).getSubagentModel()).toBe('claude-sonnet-5');
    expect(() => session.setSubagentModel('no-such-model')).toThrow(/Unknown model/);
    session.setSubagentModel(null);
    expect(session.toSnapshot().subagentModel).toBeUndefined();
    expect(() => session.addParticipant('subagent', 'claude-sonnet-5')).toThrow(/Invalid participant name/);
  });

  test('is empty until its first message and becomes empty again when cleared', () => {
    const session = new Session();
    expect(session.isEmpty()).toBe(true);
    session.append({ role: 'user', content: [{ type: 'text', text: 'hello' }] });
    expect(session.isEmpty()).toBe(false);
    session.clear();
    expect(session.isEmpty()).toBe(true);
  });

  test('round-trips its persisted fields through a snapshot', () => {
    const original = new Session({ id: 'session-123', name: 'Saved session', directory: '/projects/sirus', model: 'claude-fable-5-1' });
    original.append({ role: 'user', content: [{ type: 'text', text: 'remember me' }] });

    const restored = Session.fromSnapshot(original.toSnapshot());

    expect(restored.getId()).toBe('session-123');
    expect(restored.getName()).toBe('Saved session');
    expect(restored.getDirectory()).toBe('/projects/sirus');
    expect(restored.getModel()).toBe('claude-fable-5-1');
    expect(restored.getMessages()).toEqual(original.getMessages());
  });

  test('prompts the participant runtime with the session wiring and returns the timeline', async () => {
    const session = new Session({ id: 'session-id', name: 'Test', directory: '/projects/test', model: testModel });
    session.setThinkingLevel('medium');
    const binding = bindScriptedRuntime(testModel, textTurn('Hello back'));

    const messages = await session.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'Hello' }],
    });

    expect(binding.starts).toHaveLength(1);
    const options = binding.starts[0];
    expect(options.model).toBe(testModel);
    expect(options.directory).toBe('/projects/test');
    expect(options.thinkingLevel).toBe('medium');
    expect(options.permissionMode).toBe('auto');
    expect(options.systemPrompt).toContain('You are running inside Sirus');
    expect(options.mcpServer).toMatchObject({ name: 'sirus', url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\//) });
    expect(options.mcpServer?.headers.map(header => header.name)).toEqual(['Authorization', 'X-Sirus-Requester']);
    expect(options.mcpServer?.headers[1].value).toBe('sirus');
    expect(binding.runtimes[0].prompts).toEqual([{ text: 'Hello', images: [] }]);
    expect(messages).toEqual([
      { seq: 0, role: 'user', to: ['sirus'], content: [{ type: 'text', text: 'Hello' }] },
      {
        seq: 1,
        role: 'assistant',
        participant: 'sirus',
        model: testModel,
        content: [{ type: 'text', text: 'Hello back' }],
        startedAt: expect.any(Number),
        finishedAt: expect.any(Number),
      },
    ]);
    expect(session.getMessages()).toEqual(messages);
  });

  test('joins the tool server when a runtime first asks for its entry, and leaves it when deleted', async () => {
    bindScriptedRuntime(testModel, textTurn('Hello back'));
    const session = new Session({ id: 'tool-server-binding', name: 'Tools', model: testModel });
    // A draft nobody sent to is dropped without being disposed, so nothing
    // may hold on to it until then.
    await expect(sirusMcpServerEntry('tool-server-binding', 'sirus')).rejects.toThrow('not registered');
    await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Hello' }] });
    expect(await sirusMcpServerEntry('tool-server-binding', 'sirus')).toMatchObject({ name: 'sirus' });
    await session.dispose();
    await expect(sirusMcpServerEntry('tool-server-binding', 'sirus')).rejects.toThrow('not registered');
  });

  test('keeps the runtime warm between turns and reseeds a rebuilt one from the record', async () => {
    const binding = bindScriptedRuntime(testModel, textTurn('Sure'));
    const session = new Session({ id: 'warm', name: 'Warm', model: testModel });
    await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'First' }] });
    await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Second' }] });
    expect(binding.starts).toHaveLength(1);
    expect(binding.runtimes[0].prompts.map(prompt => prompt.text)).toEqual(['First', 'Second']);

    // A rewound session rebuilds the runtime and hands it what is left.
    const restored = Session.fromSnapshot(session.toSnapshot());
    await restored.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Third' }] });
    expect(binding.starts).toHaveLength(2);
    expect(binding.runtimes[1].prompts[0].text).toBe([
      'Earlier conversation, for context:',
      'User: First',
      '@sirus: Sure',
      'User: Second',
      '@sirus: Sure',
      '',
      'Third',
    ].join('\n'));
  });

  test('a thinking level change that fails late leaves a newer runtime alone', async () => {
    const binding = bindScriptedRuntime(testModel, textTurn('Sure'));
    const session = new Session({ id: 'late-level', name: 'Late level', model: testModel });
    await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'First' }] });
    let refuse!: (error: Error) => void;
    binding.runtimes[0].setThinkingLevel = () => new Promise((_, reject) => { refuse = reject; });
    session.setThinkingLevel('low');
    // The runtime is replaced before the vendor answers.
    session.clear();
    await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Second' }] });
    refuse(new Error('The vendor refused the level'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(binding.runtimes).toHaveLength(2);
    expect(binding.runtimes[1].disposed).toBe(false);
  });

  // /memory on or off changes the system prompt under every runtime. The
  // turn running then finishes on the one it has; the next turn gets a new one.
  test('an invalidated runtime finishes its turn and is rebuilt for the next', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    const binding = bindScriptedRuntime(testModel, async (_input, emit) => {
      if (first) {
        first = false;
        await gate;
      }
      emit({ type: 'text', text: 'Done' });
    });
    const session = new Session({ id: 'invalidated', name: 'Invalidated', model: testModel });
    const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'First' }] });
    await until(() => binding.runtimes[0]?.prompts.length === 1, 'the first prompt');
    invalidateAllRuntimes();
    expect(binding.runtimes[0].disposed).toBe(false);
    release();
    await turn;
    expect(session.getMessages().at(-1)).toMatchObject({ content: [{ type: 'text', text: 'Done' }] });

    await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Second' }] });
    expect(binding.starts).toHaveLength(2);
    expect(binding.runtimes[0].disposed).toBe(true);
  });

  test('makes a streaming assistant response visible before the runtime finishes', async () => {
    const session = new Session({ id: 'stream-session', name: 'Test', model: testModel });
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });

    bindScriptedRuntime(testModel, async (_input, emit) => {
      emit({ type: 'text', text: 'Working' });
      await gate;
      emit({ type: 'text', text: ' now.' });
      emit({ type: 'context', usage: { tokens: 128, window: 400_000 } });
    });

    const turn = session.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'Start' }],
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(session.getAssistantVersion()).toBeGreaterThan(0);
    // Timed from its start; the end is stamped when the turn is over.
    expect(session.getMessages().at(-1)).toEqual({
      seq: 1,
      role: 'assistant',
      participant: 'sirus',
      model: testModel,
      content: [{ type: 'text', text: 'Working' }],
      startedAt: expect.any(Number),
    });

    finish();
    await turn;
    expect(session.getMessages().at(-1)).toMatchObject({
      content: [{ type: 'text', text: 'Working now.' }],
    });
    expect(session.getContextUsage()).toEqual({ tokens: 128, window: 400_000 });
  });

  test('records tool calls, thoughts, notices and compaction in their original order', async () => {
    bindScriptedRuntime(testModel, (_input, emit) => {
      emit({ type: 'thought', text: 'Let me look.' });
      emit({ type: 'tool_call', call: { type: 'tool_call', id: 'call-1', title: 'cat file.txt', kind: 'execute', status: 'pending', locations: [], content: [] } });
      emit({ type: 'tool_call', call: { type: 'tool_call', id: 'call-1', title: 'cat file.txt', kind: 'execute', status: 'completed', locations: [], content: [{ type: 'text', text: 'hi' }], output: 'hi' } });
      emit({ type: 'compaction', status: 'in_progress' });
      emit({ type: 'compaction', status: 'completed', summary: 'Read the file.' });
      emit({ type: 'text', text: 'Read it.' });
      emit({ type: 'notice', severity: 'warning', title: 'Model fallback', description: 'Using the available model.' });
      emit({ type: 'text', text: 'It says hi.' });
    });
    const session = new Session({ id: 'tools', name: 'Tools', model: testModel });
    await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'What does file.txt say?' }] });
    expect(session.getMessages().at(-1)?.content).toEqual([
      { type: 'thought', text: 'Let me look.', startedAt: expect.any(Number), endedAt: expect.any(Number) },
      { type: 'tool_call', id: 'call-1', title: 'cat file.txt', kind: 'execute', status: 'completed', locations: [], content: [{ type: 'text', text: 'hi' }], output: 'hi' },
      { type: 'compaction', summary: 'Read the file.' },
      { type: 'text', text: 'Read it.' },
      { type: 'notice', severity: 'warning', title: 'Model fallback', description: 'Using the available model.' },
      { type: 'text', text: 'It says hi.' },
    ]);
  });

  test('keeps two messages apart, records what the turn used, and recaps a reply cut short', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let turns = 0;
    bindScriptedRuntime(testModel, async (_input, emit) => {
      if (turns++ === 0) {
        emit({ type: 'text', text: 'task details.', messageId: 'a' });
        emit({ type: 'text', text: ' More.', messageId: 'a' });
        emit({ type: 'text', text: 'What next?', messageId: 'b' });
        emit({ type: 'usage', usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } });
        return;
      }
      emit({ type: 'text', text: 'Half' });
      await gate;
    });
    const session = new Session({ id: 'messages', name: 'Messages', model: testModel });
    await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Go' }] });
    expect(session.getMessages().at(-1)).toMatchObject({
      content: [{ type: 'text', text: 'task details. More.' }, { type: 'text', text: 'What next?' }],
      usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
    });
    const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Again' }] });
    while (session.getMessages().length < 4) await new Promise(resolve => setTimeout(resolve, 0));
    session.cancel();
    await expect(turn).rejects.toMatchObject({ name: 'AbortError' });
    release();
    const restored = Session.fromSnapshot(session.toSnapshot());
    const next = bindScriptedRuntime(testModel, textTurn('Ok'));
    await restored.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Third' }] });
    expect(next.runtimes[0]!.prompts[0]!.text).toContain('@sirus: Half\n');
    expect(next.runtimes[0]!.prompts[0]!.text).not.toContain('interrupted');
  });

  test('keeps notices out of mention routing, peer prompts and rebuilt runtime history', async () => {
    const writer = bindScriptedRuntime(testModel, (_input, emit) => {
      emit({ type: 'text', text: 'Before' });
      emit({ type: 'notice', severity: 'vendor-hint', title: 'Notice for @observer', description: 'Vendor detail for @uninvited' });
      emit({ type: 'text', text: 'After @reviewer' });
    });
    const reviewer = bindScriptedRuntime(secondTestModel, textTurn('Reviewed'));
    const observer = bindScriptedRuntime(thirdTestModel, textTurn('Observed'));
    const session = new Session({ name: 'Notices', model: testModel });
    session.addParticipant('reviewer', secondTestModel);
    session.addParticipant('observer', thirdTestModel);
    let restored: Session | undefined;
    try {
      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Inspect' }] });
      expect(observer.starts).toHaveLength(0);
      expect(reviewer.runtimes[0].prompts[0].text).toBe('@sirus wrote:\nBefore\nAfter @reviewer');
      expect(session.getParticipants().map(participant => participant.name)).toEqual(['sirus', 'reviewer', 'observer']);
      restored = Session.fromSnapshot(session.toSnapshot());
      await restored.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Again' }] });
      const seed = writer.runtimes[1].prompts[0].text;
      expect(seed).toContain('@sirus: Before');
      expect(seed).toContain('@sirus: After @reviewer');
      expect(seed).not.toContain('Notice for');
      expect(seed).not.toContain('Vendor detail');
      expect(observer.starts).toHaveLength(0);
    } finally {
      await session.dispose();
      await restored?.dispose();
    }
  });

  test('surfaces notices between turns through the session without changing the transcript', async () => {
    const binding = bindScriptedRuntime(testModel, textTurn('Done'));
    const session = new Session({ name: 'Idle notice', model: testModel });
    try {
      expect(session.getNotice()).toBeNull();
      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Inspect' }] });
      const before = session.toSnapshot().messages;
      let changes = 0;
      const unsubscribe = session.subscribe(() => { changes++; });
      const notice = { type: 'notice' as const, severity: 'error', title: 'Configuration changed' };
      binding.starts[0].onUpdate(notice);
      unsubscribe();
      expect(session.getNotice()).toEqual({ participant: 'sirus', notice });
      expect(changes).toBe(1);
      expect(session.getMessages()).toEqual(before);
      expect(session.toSnapshot()).not.toHaveProperty('notice');
    } finally {
      await session.dispose();
    }
  });

  test('/compact sends the slash command to the default participant and records the boundary', async () => {
    const binding = bindScriptedRuntime(testModel, (input, emit) => {
      if (input.text === '/compact') emit({ type: 'compaction', status: 'completed' });
      else emit({ type: 'text', text: 'Done' });
    });
    const session = new Session({ id: 'compact', name: 'Compact', model: testModel });
    await expect(session.compact()).rejects.toThrow('There is no history to compact.');
    await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Work' }] });
    await session.compact();
    expect(binding.runtimes[0].prompts.map(prompt => prompt.text)).toEqual(['Work', '/compact']);
    expect(session.getMessages().map(message => message.content)).toEqual([
      [{ type: 'text', text: 'Work' }],
      [{ type: 'text', text: 'Done' }],
      [{ type: 'compaction' }],
    ]);
    expect(session.getStatus()).toBe('idle');
    expect(session.isCompacting()).toBe(false);
  });

  test('keeps queued messages on the session in FIFO order', () => {
    const session = new Session({ name: 'Queue' });
    session.queueMessage('first');
    session.queueMessage('second');

    expect(session.getQueuedMessageCount()).toBe(2);
    expect(session.shiftQueuedMessage()).toBe('first');
    expect(session.getQueuedMessageCount()).toBe(1);
    // The queue is not persisted: round-tripping a session with a message
    // still queued restores none of it.
    expect(Session.fromSnapshot(session.toSnapshot()).getQueuedMessageCount()).toBe(0);
    expect(session.getQueuedMessageCount()).toBe(1);
    expect(session.shiftQueuedMessage()).toBe('second');
    expect(session.getQueuedMessageCount()).toBe(0);
  });

  test('drains queued prompts in order without a mounted chat', async () => {
    const pending: Array<() => void> = [];
    const prompts: string[] = [];
    bindScriptedRuntime(testModel, async (input, emit) => {
      prompts.push(input.text);
      await new Promise<void>(resolve => pending.push(resolve));
      emit({ type: 'text', text: 'Done' });
    });
    const session = new Session({ id: 'background-queue', name: 'Queue', model: testModel });
    const first = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'first' }] });
    session.queueMessage('second');
    session.queueMessage('third');
    const untilPending = async () => {
      while (pending.length === 0) await new Promise(resolve => setTimeout(resolve, 0));
    };
    await untilPending();
    pending.shift()!();
    await first;
    // The next prompt is on its way to the runtime once its checkpoint is taken.
    await untilPending();
    expect(prompts).toEqual(['first', 'second']);
    expect(session.getStatus()).toBe('working');
    expect(session.getQueuedMessageCount()).toBe(1);
    pending.shift()!();
    await untilPending();
    expect(prompts).toEqual(['first', 'second', 'third']);
    expect(session.getQueuedMessageCount()).toBe(0);
    pending.shift()!();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(session.getStatus()).toBe('idle');
  });

  test('pauses the background queue at commands that may need user input', async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    bindScriptedRuntime(testModel, async (_input, emit) => {
      await gate;
      emit({ type: 'text', text: 'Done' });
    });
    const session = new Session({ id: 'command-queue', name: 'Queue', model: testModel });
    const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'first' }] });
    session.queueMessage('/login');
    session.queueMessage('after login');
    finish();
    await turn;
    expect(session.getStatus()).toBe('idle');
    expect(session.shiftQueuedMessage()).toBe('/login');
    expect(session.shiftQueuedMessage()).toBe('after login');
  });

  test('cancelling sends that session queue next and leaves other sessions running', async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    bindScriptedRuntime(testModel, async (_input, emit) => {
      await gate;
      emit({ type: 'text', text: 'Done' });
    });
    const first = new Session({ id: 'cancel-first', name: 'First', model: testModel });
    const second = new Session({ id: 'cancel-second', name: 'Second', model: testModel });
    const message: Draft = { role: 'user', content: [{ type: 'text', text: 'start' }] };
    const firstTurn = first.sendMessage(message);
    const secondTurn = second.sendMessage(message);
    first.queueMessage('after cancel');
    second.queueMessage('keep');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(first.cancel()).toBe(true);
    await expect(firstTurn).rejects.toThrow();
    // the cancelled turn is followed by what was waiting behind it
    expect(first.getQueuedMessageCount()).toBe(0);
    expect(first.getMessages().filter(message => message.role === 'user').map(message => message.content))
      .toEqual([message.content, [{ type: 'text', text: 'after cancel' }]]);
    expect(second.getStatus()).toBe('working');
    expect(second.getQueuedMessageCount()).toBe(1);
    finish();
    await secondTurn;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(second.getMessages().filter(message => message.role === 'user')).toHaveLength(2);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(first.getStatus()).toBe('idle');
  });

  test('a deleted session sends nothing it had queued and refuses new prompts', async () => {
    const prompts: string[] = [];
    bindScriptedRuntime(testModel, async (input, emit, _options, signal) => {
      prompts.push(input.text);
      await new Promise(resolve => signal.addEventListener('abort', resolve));
      emit({ type: 'text', text: 'Done' });
    });
    const session = new Session({ id: 'disposed-queue', name: 'Disposed', model: testModel });
    const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'start' }] });
    session.queueMessage('never sent');
    await until(() => prompts.length === 1, 'the turn to start');
    await session.dispose();
    await expect(turn).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(prompts).toEqual(['start']);
    expect(session.getMessages().filter(message => message.role === 'user')).toHaveLength(1);
    await expect(session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'again' }] }))
      .rejects.toThrow('This session was deleted.');
  });

  test('cancelling a turn leaves its workers running; cancelWorker and dispose stop them', async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const sessions: Session[] = [];
    let spawns = 0;
    bindScriptedRuntime(testModel, async (_input, emit, options) => {
      if (isWorker(options)) await gate;
      // One worker per session, on that session's first turn; the report
      // turns that follow spawn nothing.
      else if (spawns < sessions.length) {
        await sessions[spawns].subagentHostFor('sirus')!.spawn('background task', { context: 'fresh' }, { callId: `spawn-${spawns++}` });
      }
      emit({ type: 'text', text: 'Done' });
    });
    const first = new Session({ id: 'detached-first', name: 'First', model: testModel });
    const second = new Session({ id: 'detached-second', name: 'Second', model: testModel });
    sessions.push(first, second);
    const message: Draft = { role: 'user', content: [{ type: 'text', text: 'start' }] };
    await first.sendMessage(message);
    await second.sendMessage(message);
    const [firstWorker] = first.getWorkers();
    const [secondWorker] = second.getWorkers();
    expect(first.getStatus()).toBe('idle');
    expect([firstWorker.status, secondWorker.status]).toEqual(['working', 'working']);
    expect(first.getActiveSubagentCount()).toBe(1);

    // Escape stops the turn and nothing else: there is no turn left to stop
    // here, and the workers keep working.
    expect(first.cancel()).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect([firstWorker.status, secondWorker.status]).toEqual(['working', 'working']);

    await first.cancelWorker(firstWorker.id);
    expect(firstWorker.status).toBe('cancelled');
    expect(secondWorker.status).toBe('working');
    expect(first.getActiveSubagentCount()).toBe(0);
    await expect(first.cancelWorker(secondWorker.id)).rejects.toThrow('has no worker');

    // Deleting the session stops what is left of it.
    await second.dispose();
    expect(secondWorker.status).toBe('cancelled');
    finish();
    await until(() => first.getStatus() === 'idle', 'the report turn to finish');
    await first.dispose();
  });

  test('a finished worker reports back as a message from its id and starts its owner’s turn', async () => {
    const prompts: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let session!: Session;
    let spawned = false;
    bindScriptedRuntime(testModel, async (input, emit, options) => {
      if (isWorker(options)) {
        await gate;
        emit({ type: 'text', text: 'I rewrote the parser.' });
        return;
      }
      prompts.push(input.text);
      if (!spawned) {
        spawned = true;
        // The vendor reports the SpawnAgent call as a block of the owner's
        // entry; the run is tied to it, and the report lands on it.
        const call = { type: 'tool_call' as const, id: 'spawn', title: 'sirus - SpawnAgent', kind: 'other' as const, locations: [], content: [] };
        emit({ type: 'tool_call', call: { ...call, status: 'in_progress' } });
        await session.subagentHostFor('sirus')!.spawn('Rewrite the parser', { context: 'fresh' }, { callId: 'spawn' });
        emit({ type: 'tool_call', call: { ...call, status: 'completed' } });
      }
      emit({ type: 'text', text: 'Noted' });
    });
    session = new Session({ id: 'worker-report', name: 'Report', model: testModel });
    try {
      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Delegate it' }] });
      const [worker] = session.getWorkers();
      expect(worker.status).toBe('working');
      expect(worker.reported).toBe(false);
      expect(session.getStatus()).toBe('idle');

      release();
      await until(() => prompts.length === 2 && session.getStatus() === 'idle', 'the report turn');
      expect(worker.status).toBe('done');
      expect(worker.reported).toBe(true);
      // The owner hears it the way it hears any other participant.
      expect(prompts[1]).toStartWith(`Subagent ${worker.id} done`);
      expect(prompts[1]).toContain(`Subagent ${worker.id} done`);
      expect(prompts[1]).toContain('I rewrote the parser.');
      // How to continue a worker is the tools' to say; a report that says it
      // gets finished workers sent follow-ups.
      expect(prompts[1]).not.toContain('SendMessage');

      const report = session.getMessages().find(entry => entry.hidden && textOf(entry).includes(worker.id));
      expect(report).toMatchObject({ role: 'user', to: ['sirus'], hidden: true });
      expect(textOf(report!)).toContain('Final message:');
      // The user reads the report under the call that started the worker.
      const call = session.getMessages().flatMap(entry => entry.content)
        .find(block => block.type === 'tool_call' && block.id === worker.callId);
      expect(call).toMatchObject({ type: 'tool_call', output: textOf(report!) });
      expect(session.getMessages().at(-1)).toMatchObject({ role: 'assistant', participant: 'sirus' });
    } finally {
      release();
      await session.dispose();
    }
  });

  test('keeps parallel workers on distinct SpawnAgent rows', async () => {
    let releaseWorkers!: () => void;
    const workersGate = new Promise<void>(resolve => { releaseWorkers = resolve; });
    let session!: Session;
    let spawned = false;
    bindScriptedRuntime(testModel, async (_input, emit, options) => {
      if (isWorker(options)) {
        await workersGate;
        return;
      }
      if (!spawned) {
        spawned = true;
        const calls = [
          { id: 'spawn-one', title: 'mcp__sirus__SpawnAgent' },
          { id: 'spawn-two', title: 'mcp__sirus__SpawnAgent' },
        ] as const;
        for (const call of calls) {
          emit({ type: 'tool_call', call: {
            type: 'tool_call', ...call, kind: 'other', status: 'in_progress', locations: [], content: [],
          } });
        }
        const host = session.subagentHostFor('sirus')!;
        await Promise.all([
          host.spawn('First task', { context: 'fresh' }, { callId: 'mcp-one' }),
          host.spawn('Second task', { context: 'fresh' }, { callId: 'mcp-two' }),
        ]);
        for (const call of calls) {
          emit({ type: 'tool_call', call: {
            type: 'tool_call', ...call, kind: 'other', status: 'completed', locations: [], content: [],
          } });
        }
      }
      emit({ type: 'text', text: 'Noted' });
    });
    session = new Session({ id: 'parallel-worker-rows', name: 'Parallel rows', model: testModel });
    try {
      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Delegate both' }] });
      expect(session.getWorkers().map(run => run.callId)).toEqual(['spawn-one', 'spawn-two']);
    } finally {
      releaseWorkers();
      await session.dispose();
    }
  });

  test('a report steers a busy owner without adding a turn before queued prompts', async () => {
    const prompts: string[] = [];
    let releaseOwner!: () => void;
    let releaseWorker!: () => void;
    const ownerGate = new Promise<void>(resolve => { releaseOwner = resolve; });
    const workerGate = new Promise<void>(resolve => { releaseWorker = resolve; });
    let session!: Session;
    let spawned = false;
    bindScriptedRuntime(testModel, async (input, emit, options) => {
      if (isWorker(options)) {
        await workerGate;
        emit({ type: 'text', text: 'Worker result' });
        return;
      }
      prompts.push(input.text);
      if (!spawned) {
        spawned = true;
        await session.subagentHostFor('sirus')!.spawn('Background task', { context: 'fresh' }, { callId: 'spawn' });
      } else if (prompts.length === 2) {
        await ownerGate;
      }
      emit({ type: 'text', text: 'Noted' });
    });
    session = new Session({ id: 'worker-report-order', name: 'Order', model: testModel });
    try {
      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Delegate it' }] });
      const [worker] = session.getWorkers();

      const busy = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Meanwhile' }] });
      await until(() => prompts.length === 2, 'the second turn to start');
      session.queueMessage('Queued prompt');
      releaseWorker();
      await until(() => worker.status === 'done' && worker.reported, 'the worker report to arrive');
      expect(worker.reported).toBe(true);
      expect(session.getQueuedMessageCount()).toBe(1);

      releaseOwner();
      await busy;
      await until(() => prompts.length === 3 && session.getStatus() === 'idle', 'the queued prompt');
      expect(prompts[2]).toBe('Queued prompt');
      expect(session.getQueuedMessageCount()).toBe(0);
    } finally {
      releaseOwner();
      releaseWorker();
      await session.dispose();
    }
  });

  test('clearing waits for the session’s workers, whose reports belong to the history it drops', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let session!: Session;
    let spawned = false;
    bindScriptedRuntime(testModel, async (_input, emit, options) => {
      if (isWorker(options)) {
        await gate;
        return;
      }
      if (!spawned) {
        spawned = true;
        await session.subagentHostFor('sirus')!.spawn('Background task', { context: 'fresh' }, { callId: 'spawn' });
      }
      emit({ type: 'text', text: 'Noted' });
    });
    session = new Session({ id: 'clear-with-workers', name: 'Clear', model: testModel });
    try {
      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Delegate it' }] });
      const [worker] = session.getWorkers();
      expect(() => session.clear()).toThrow('Wait for this session’s subagents to finish before clearing it.');
      expect(session.isEmpty()).toBe(false);

      release();
      await until(() => worker.status === 'done' && session.getStatus() === 'idle', 'the report turn');
      session.clear();
      expect(session.isEmpty()).toBe(true);
    } finally {
      release();
      await session.dispose();
    }
  });

  test('a worker still being set up counts as working, and deleting the session stops it', async () => {
    bindScriptedRuntime(testModel, textTurn('Done'));
    // Never created: the worktree is stubbed out below.
    const directory = path.join(os.tmpdir(), `sirus-spawn-setup-${process.pid}`);
    let cut!: () => void;
    const create = spyOn(worktree, 'createWorktree')
      .mockImplementation(() => new Promise(resolve => {
        cut = () => resolve({ directory, branch: 'sirus/setup', startHead: 'a'.repeat(40) });
      }));
    const session = new Session({ id: 'spawn-setup', name: 'Setup', model: testModel });
    session.append({ role: 'user', to: ['sirus'], content: [{ type: 'text', text: 'Earlier' }] });
    try {
      const spawn = session.subagentHostFor('sirus')!.spawn('Background task', { isolation: 'worktree' }, { callId: 'spawn' });
      await until(() => create.mock.calls.length === 1, 'the spawn to ask for a worktree');
      // The run does not exist yet, but its worker starts from this record.
      expect(session.getActiveSubagentCount()).toBe(1);
      expect(() => session.clear()).toThrow('Wait for this session’s subagents to finish');

      const disposed = session.dispose();
      cut();
      await disposed;
      const run = await spawn;
      expect(findSubagent(run.id as string)).toBeUndefined();
    } finally {
      create.mockRestore();
    }
  });

  test('a worker that has ended is no longer held for anyone to wait on', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let session!: Session;
    let spawned = false;
    bindScriptedRuntime(testModel, async (_input, emit, options) => {
      if (isWorker(options)) {
        await gate;
        return;
      }
      if (!spawned) {
        spawned = true;
        await session.subagentHostFor('sirus')!.spawn('Background task', { context: 'fresh' }, { callId: 'spawn' });
      }
      emit({ type: 'text', text: 'Noted' });
    });
    session = new Session({ id: 'worker-completion', name: 'Completion', model: testModel });
    try {
      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Delegate it' }] });
      const [worker] = session.getWorkers();
      // What a canceller of the working run would wait on.
      const completion = new WeakRef(subagentDone(worker));
      release();
      await until(() => worker.status === 'done' && session.getStatus() === 'idle', 'the worker and its report');
      await new Promise(resolve => setTimeout(resolve, 0));
      Bun.gc(true);
      expect(completion.deref()).toBeUndefined();
    } finally {
      release();
      await session.dispose();
    }
  });

  test('messageWorker steers a running worker and resumes one that ended', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const steered: string[] = [];
    let session!: Session;
    let spawned = false;
    bindScriptedRuntime(testModel, async (_input, emit, options, _signal, runtime) => {
      if (isWorker(options)) {
        runtime.onSteer = text => steered.push(text);
        await gate;
        emit({ type: 'text', text: 'Worker done' });
        return;
      }
      if (!spawned) {
        spawned = true;
        await session.subagentHostFor('sirus')!.spawn('Background task', { context: 'fresh' }, { callId: 'spawn' });
      }
      emit({ type: 'text', text: 'Noted' });
    });
    session = new Session({ id: 'worker-steering', name: 'Steering', model: testModel });
    try {
      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Delegate it' }] });
      const [worker] = session.getWorkers();
      await until(() => worker.worker !== null && steered.length === 0, 'the worker to start its turn');

      await session.messageWorker(worker.id, 'Use the new API instead');
      expect(steered).toEqual(['Use the new API instead']);
      // What was sent is part of the worker's own record.
      expect(worker.transcript.at(-1)).toMatchObject({
        role: 'user',
        content: [{ type: 'text', text: 'Use the new API instead' }],
      });

      release();
      await until(() => worker.status === 'done', 'the worker to finish');
      await session.messageWorker(worker.id, 'Follow up');
      await until(() => worker.status === 'done', 'the resumed worker');
      expect(worker.transcript.some(entry => textOf(entry) === 'Follow up')).toBe(true);
      await expect(session.messageWorker('sub-nothing', 'Nobody')).rejects.toThrow('has no worker');
    } finally {
      release();
      await session.dispose();
    }
  });

  test('workers restore as interrupted and their report reaches the owner on its next prompt', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const prompts: string[] = [];
    let session!: Session;
    let spawned = false;
    bindScriptedRuntime(testModel, async (input, emit, options) => {
      if (isWorker(options)) {
        await gate;
        return;
      }
      prompts.push(input.text);
      if (!spawned) {
        spawned = true;
        await session.subagentHostFor('sirus')!.spawn('Background task', { context: 'fresh' }, { callId: 'spawn' });
      }
      emit({ type: 'text', text: 'Noted' });
    });
    session = new Session({ id: 'worker-restore', name: 'Restore', model: testModel });
    let restored: Session | null = null;
    try {
      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Delegate it' }] });
      const [worker] = session.getWorkers();
      expect(worker.status).toBe('working');

      // The snapshot is taken while it works, as quitting would.
      const snapshot = session.toSnapshot();
      expect(snapshot.workers).toHaveLength(1);
      expect(snapshot.workers?.[0]).toMatchObject({ id: worker.id, owner: 'sirus', status: 'working', reported: false });

      // The process that ran it is gone before the record is read back.
      release();
      await session.dispose();
      restored = Session.fromSnapshot(snapshot);
      const [restoredWorker] = restored.getWorkers();
      expect(restoredWorker).toMatchObject({
        id: worker.id,
        status: 'interrupted',
        worker: null,
        error: 'Sirus quit while it was working',
      });
      expect(restoredWorker.finishedAt).toBeNumber();
      // Nothing restarts and nothing is prompted on restore.
      expect(restored.getStatus()).toBe('idle');
      expect(prompts).toHaveLength(1);

      await restored.sendMessage({ role: 'user', content: [{ type: 'text', text: 'What happened?' }] });
      expect(restoredWorker.reported).toBe(true);
      const entries = restored.getMessages();
      const report = entries.findIndex(entry => entry.hidden && textOf(entry).includes(worker.id));
      const question = entries.findIndex(entry => entry.role === 'user' && textOf(entry) === 'What happened?');
      // The report is in the record the fresh runtime is seeded with, ahead
      // of the prompt, rather than a turn of its own.
      expect(report).toBeGreaterThan(-1);
      expect(report).toBeLessThan(question);
      expect(entries[report].hidden).toBe(true);
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain('Sirus quit while it was working');
      expect(prompts[1]).toContain('What happened?');
    } finally {
      release();
      await (restored ?? session).dispose();
    }
  });

  test('worker model and thinking follow explicit choices, then owner, with the user pin first', async () => {
    const started: { model: string; thinkingLevel?: string }[] = [];
    for (const model of [testModel, secondTestModel, thirdTestModel]) {
      bindScriptedRuntime(model, (_input, emit, options) => {
        started.push({ model: options.model, thinkingLevel: options.thinkingLevel });
        emit({ type: 'text', text: 'Done' });
      });
    }
    const session = new Session({ id: 'worker-choice', name: 'Choice', model: testModel });
    session.setThinkingLevel('xhigh');
    const host = session.subagentHostFor('sirus')!;
    try {
      await host.spawn('Explicit', { model: secondTestModel, thinkingLevel: 'low', runInBackground: false }, { callId: 'one' });
      await host.spawn('Inherited', { runInBackground: false }, { callId: 'two' });
      session.setSubagentModel(thirdTestModel);
      await host.spawn('Pinned', { model: secondTestModel, thinkingLevel: 'medium', runInBackground: false }, { callId: 'three' });
      expect(started).toEqual([
        { model: secondTestModel, thinkingLevel: 'low' },
        { model: testModel, thinkingLevel: 'xhigh' },
        { model: thirdTestModel, thinkingLevel: 'medium' },
      ]);
      expect(session.getStatus()).toBe('idle');
      expect(session.getMessages()).toHaveLength(0);
    } finally {
      await session.dispose();
    }
  });

  test('an owner-context worker forks the owner’s live runtime and is sent the task alone', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const workerPrompts: string[] = [];
    let session!: Session;
    let spawned = false;
    const binding = bindScriptedRuntime(testModel, async (input, emit, options) => {
      if (isWorker(options)) {
        workerPrompts.push(input.text);
        await gate;
        return;
      }
      if (!spawned) {
        spawned = true;
        await session.subagentHostFor('sirus')!.spawn('Carry on from here', { context: 'owner' }, { callId: 'spawn' });
      }
      emit({ type: 'text', text: 'Delegated it' });
    }, true);
    session = new Session({ id: 'worker-fork', name: 'Fork', model: testModel });
    try {
      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Delegate it' }] });
      const [worker] = session.getWorkers();
      expect(worker.context).toBe('owner');
      expect(session.toSnapshot().workers![0]!.nativeSession).toMatchObject({
        vendor: 'gpt', sessionId: binding.runtimes[1]!.sessionId, directory: worker.directory, sourceId: null,
      });
      expect(binding.runtimes[1]!.sessionId).not.toBe(binding.runtimes[0]!.sessionId);
      expect(binding.forks).toHaveLength(1);
      expect(binding.forks[0]).toMatchObject({ model: testModel, directory: session.getDirectory() });
      expect(binding.forks[0].systemPrompt).toContain('You are a Sirus subagent');
      await until(() => workerPrompts.length === 1, 'the worker’s first prompt');
      // A fork keeps the system prompt of the session it came from, so the
      // contract opens the first prompt instead.
      expect(workerPrompts[0]).toStartWith('You are now a Sirus subagent, forked from the conversation above');
      expect(workerPrompts[0]).toContain('end with a final message addressed to the agent that spawned you');
      expect(workerPrompts[0]).toEndWith('Your task:\nCarry on from here');
      // The conversation itself is already in the forked session.
      expect(workerPrompts[0]).not.toContain('Earlier conversation');
      // Keep the inherited record too, in case the fork's process is lost.
      expect(textOf(worker.transcript[0])).toContain('Earlier conversation');
      expect(textOf(worker.transcript[0])).toContain('Delegate it');
    } finally {
      release();
      await session.dispose();
    }
  });

  test('an owner-context worker with no runtime to fork starts fresh on the owner’s record', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const workerPrompts: string[] = [];
    const binding = bindScriptedRuntime(testModel, async (input, _emit, options) => {
      if (isWorker(options)) {
        workerPrompts.push(input.text);
        await gate;
      }
    });
    const session = new Session({ id: 'worker-fork-fallback', name: 'Fallback', model: testModel });
    session.append({ role: 'user', to: ['sirus'], content: [{ type: 'text', text: 'The parser is in src/parser.ts' }] });
    try {
      await session.subagentHostFor('sirus')!.spawn('Carry on from here', { context: 'owner' }, { callId: 'spawn' });
      await until(() => workerPrompts.length === 1, 'the worker’s first prompt');
      expect(binding.forks).toEqual([]);
      expect(workerPrompts[0]).toStartWith('Earlier conversation of the agent that spawned you, for context:');
      expect(workerPrompts[0]).toContain('The parser is in src/parser.ts');
      expect(workerPrompts[0]).toEndWith('Carry on from here');
      // A fresh worker has a system prompt of its own; the contract is there.
      expect(workerPrompts[0]).not.toContain('You are now a Sirus subagent');
    } finally {
      release();
      await session.dispose();
    }
  });

  test('tracks the active turn start independently of the chat view', async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    bindScriptedRuntime(testModel, async (_input, emit) => {
      await gate;
      emit({ type: 'text', text: 'Done' });
    });
    const session = new Session({ id: 'elapsed-session', name: 'Elapsed', model: testModel });

    const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Start' }] });
    expect(session.getActiveTurnStartedAt()).toBeNumber();
    finish();
    await turn;
    expect(session.getActiveTurnStartedAt()).toBeNull();
  });

  test('cancels the whole active turn and keeps what had streamed', async () => {
    const session = new Session({ id: 'cancel-session', name: 'Test', model: testModel });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let runtimeSignal: AbortSignal | undefined;
    bindScriptedRuntime(testModel, async (_input, emit, _options, signal) => {
      runtimeSignal = signal;
      emit({ type: 'text', text: 'Partial' });
      await gate;
      emit({ type: 'text', text: 'Too late' });
    });

    const turn = session.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'Start' }],
    });
    while (!runtimeSignal) await new Promise(resolve => setTimeout(resolve, 0));

    expect(session.cancel()).toBe(true);
    await expect(turn).rejects.toMatchObject({ name: 'AbortError' });
    expect(runtimeSignal?.aborted).toBe(true);
    expect(session.getStatus()).toBe('idle');
    expect(session.wasLastTurnCancelled()).toBe(true);
    // What it wrote before it was cut short stays in the record, and nothing more.
    expect(session.getMessages()).toEqual([
      { seq: 0, role: 'user', to: ['sirus'], content: [{ type: 'text', text: 'Start' }] },
      {
        seq: 1,
        role: 'assistant',
        participant: 'sirus',
        model: testModel,
        content: [
          { type: 'text', text: 'Partial' },
        ],
        startedAt: expect.any(Number),
        finishedAt: expect.any(Number),
      },
    ]);
    expect(session.cancel()).toBe(false);
    release();
  });

  test('Esc while a report turn takes its checkpoint stops it before the owner is prompted', async () => {
    const prompts: string[] = [];
    let releaseWorker!: () => void;
    const workerGate = new Promise<void>(resolve => { releaseWorker = resolve; });
    let session!: Session;
    let spawned = false;
    bindScriptedRuntime(testModel, async (input, emit, options) => {
      if (isWorker(options)) {
        await workerGate;
        return;
      }
      prompts.push(input.text);
      if (!spawned) {
        spawned = true;
        await session.subagentHostFor('sirus')!.spawn('Background task', { context: 'fresh' }, { callId: 'spawn' });
      }
      emit({ type: 'text', text: 'Noted' });
    });
    session = new Session({ id: 'cancel-report-capture', name: 'Report capture', model: testModel });
    await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Delegate it' }] });
    const [worker] = session.getWorkers();
    let releaseCapture!: () => void;
    const capture = spyOn(checkpoints, 'captureCheckpoint')
      .mockImplementation(() => new Promise(resolve => { releaseCapture = () => resolve(null); }));
    try {
      releaseWorker();
      await until(() => worker.status === 'done' && capture.mock.calls.length === 1, 'the report turn to take its checkpoint');
      expect(session.getStatus()).toBe('working');
      expect(session.cancel()).toBe(true);
      releaseCapture();
      await until(() => session.getStatus() === 'idle', 'the report turn to end');
      expect(prompts).toEqual(['Delegate it']);
      expect(session.wasLastTurnCancelled()).toBe(true);
    } finally {
      releaseWorker();
      releaseCapture?.();
      capture.mockRestore();
      await session.dispose();
    }
  });

  test('cancelling a turn stops a runtime that is still starting', async () => {
    const previousKey = process.env.OPENAI_SECRET;
    process.env.OPENAI_SECRET = 'sk-proj-starting-0000';
    const startSignals: (AbortSignal | undefined)[] = [];
    // An adapter that does not finish starting: it stops when told to, and
    // gives up by itself after a while, so a start nobody can stop still
    // ends the test.
    const start = spyOn(acp, 'startAcpRuntime').mockImplementation(options => {
      const signal = options.signal;
      startSignals.push(signal);
      return new Promise((_resolve, reject) => {
        const hung = setTimeout(() => reject(new Error('The adapter never started')), 2_000);
        signal?.addEventListener('abort', () => {
          clearTimeout(hung);
          reject(signal.reason);
        }, { once: true });
      });
    });
    const session = new Session({ id: 'starting', name: 'Starting', model: 'gpt-5.6-luna' });
    try {
      const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Start' }] });
      await until(() => startSignals.length === 1, 'the runtime to start');
      expect(session.cancel()).toBe(true);
      await expect(turn).rejects.toMatchObject({ name: 'AbortError' });
      expect(startSignals[0]?.aborted).toBe(true);
    } finally {
      start.mockRestore();
      if (previousKey === undefined) delete process.env.OPENAI_SECRET;
      else process.env.OPENAI_SECRET = previousKey;
    }
  });

  test('creates a named participant from a mention and targets it thereafter', async () => {
    const binding = bindScriptedRuntime(testModel, textTurn('reviewed'));
    const session = new Session({ id: 'session-id', name: 'Test', model: secondTestModel });

    await session.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: '@Reviewer test-session-model inspect this' }],
    });
    await session.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: '@reviewer check it again' }],
    });

    expect(session.getParticipants()).toEqual([
      { name: 'sirus', model: secondTestModel },
      { name: 'Reviewer', model: testModel },
    ]);
    expect(binding.starts).toHaveLength(1);
    expect(binding.starts[0].systemPrompt).toContain('the participant @Reviewer');
    expect(binding.starts[0].mcpServer?.headers[1].value).toBe('Reviewer');
    expect(binding.starts[0].directory).toBe(process.cwd());
    expect(binding.runtimes[0].prompts.map(prompt => prompt.text))
      .toEqual(['@Reviewer inspect this', '@reviewer check it again']);
    // The prompt stays as typed; the runtime read it without the model.
    expect(session.getMessages()[0]).toEqual({
      seq: 0,
      role: 'user',
      to: ['Reviewer'],
      content: [{ type: 'text', text: '@Reviewer test-session-model inspect this' }],
      creationModels: [{ start: 9, end: 28 }],
    });
    const timed = { startedAt: expect.any(Number), finishedAt: expect.any(Number) };
    expect(session.getMessages().filter(message => message.role === 'assistant'))
      .toEqual([
        { seq: 1, role: 'assistant', participant: 'Reviewer', model: testModel, content: [{ type: 'text', text: 'reviewed' }], ...timed },
        { seq: 3, role: 'assistant', participant: 'Reviewer', model: testModel, content: [{ type: 'text', text: 'reviewed' }], ...timed },
      ]);
    expect(Session.fromSnapshot(session.toSnapshot()).getMessages()[0]?.creationModels).toEqual([{ start: 9, end: 28 }]);
  });

  test('tells the others a prompt addresses who it added to the session', async () => {
    const sirus = bindScriptedRuntime(secondTestModel, textTurn('asked'));
    const reviewer = bindScriptedRuntime(testModel, textTurn('reviewed'));
    const session = new Session({ id: 'introductions', name: 'Introductions', model: secondTestModel });

    await session.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: '@reviewer test-session-model review the diff, then ask @sirus to fix it' }],
    });
    expect(sirus.runtimes[0].prompts[0].text).toBe([
      'This message adds @reviewer (test-session-model) to the session as a new participant, and it receives this message too.',
      '',
      '@reviewer review the diff, then ask @sirus to fix it',
    ].join('\n'));
    // The new participant knows its own name, and the record keeps the
    // prompt as the user typed it and the chat shows it.
    expect(reviewer.runtimes[0].prompts[0].text).toBe('@reviewer review the diff, then ask @sirus to fix it');
    expect(textOf(session.getMessages()[0])).toBe('@reviewer test-session-model review the diff, then ask @sirus to fix it');

    // Once it exists, a prompt naming it introduces nobody.
    await session.sendMessage({ role: 'user', content: [{ type: 'text', text: '@sirus @reviewer compare notes' }] });
    expect(sirus.runtimes[0].prompts[1].text).toBe('@sirus @reviewer compare notes');
  });

  test('runs unique mentions in parallel and orders replies by their first output', async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
    const started: string[] = [];
    bindScriptedRuntime(testModel, async (_input, emit) => {
      started.push('first');
      await firstGate;
      emit({ type: 'text', text: 'first response' });
    });
    bindScriptedRuntime(secondTestModel, async (_input, emit) => {
      started.push('second');
      await secondGate;
      emit({ type: 'text', text: 'second response' });
    });
    const session = new Session();
    const turn = session.sendMessage({
      role: 'user',
      content: [{
        type: 'text',
        text: '@first test-session-model @second test-second-session-model @FIRST compare',
      }],
    });

    while (started.length < 2) await new Promise(resolve => setTimeout(resolve, 0));
    expect(started).toEqual(['first', 'second']);
    releaseSecond();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(session.getMessages()).toHaveLength(2);
    releaseFirst();
    await turn;

    expect(session.getMessages()[0]).toEqual({
      seq: 0,
      role: 'user',
      to: ['first', 'second'],
      content: [{ type: 'text', text: '@first test-session-model @second test-second-session-model @FIRST compare' }],
      creationModels: [{ start: 6, end: 25 }, { start: 33, end: 59 }],
    });
    // The second reply began first, so a first reply that arrives later
    // takes its place below it rather than pushing it down.
    expect(session.getMessages().slice(1).map(message => [message.participant, message.content[0]]))
      .toEqual([
        ['second', { type: 'text', text: 'second response' }],
        ['first', { type: 'text', text: 'first response' }],
      ]);
  });

  test('does not strip a model name following an existing participant mention', async () => {
    const binding = bindScriptedRuntime(testModel, textTurn('done'));
    const session = new Session();
    session.addParticipant('Claude', testModel);

    await session.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: '@Claude claude-opus-5 is still relevant here' }],
    });

    expect(binding.runtimes[0].prompts[0].text).toBe('@Claude claude-opus-5 is still relevant here');
  });

  test('keeps unknown mentions without a model as ordinary prompt text', async () => {
    const binding = bindScriptedRuntime(testModel, textTurn('done'));
    const session = new Session({ model: testModel });
    await session.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'Could @reviewer inspect this @mention?' }],
    });
    expect(session.getParticipants()).toEqual([{ name: 'sirus', model: testModel }]);
    expect(binding.runtimes[0].prompts[0].text).toBe('Could @reviewer inspect this @mention?');
  });

  test('allows an explicit introduction after an ordinary occurrence of the same word', async () => {
    const binding = bindScriptedRuntime(testModel, textTurn('done'));
    const session = new Session({ model: testModel });
    await session.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'About @reviewer: @reviewer test-session-model inspect this' }],
    });
    expect(session.getParticipants().map(participant => participant.name)).toEqual(['sirus', 'reviewer']);
    expect(binding.runtimes[0].prompts[0].text).toBe('About @reviewer: @reviewer inspect this');
  });

  test('does not treat a scoped package name as a participant mention', async () => {
    const binding = bindScriptedRuntime(testModel, textTurn('done'));
    const session = new Session({ id: 'session-id', name: 'Test', model: testModel });

    await session.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'Upgrade @scope/package for me' }],
    });

    expect(binding.runtimes[0].prompts).toHaveLength(1);
    expect(session.getParticipants()).toEqual([{ name: 'sirus', model: testModel }]);
  });

  test('does not invoke or create participants from mentions inside Markdown blocks', async () => {
    const calls: string[] = [];
    bindScriptedRuntime(testModel, (_input, emit) => {
      calls.push('sirus');
      emit({ type: 'text', text: 'done' });
    });
    bindScriptedRuntime(secondTestModel, (_input, emit) => {
      calls.push('reviewer');
      emit({ type: 'text', text: 'reviewed' });
    });
    const session = new Session({ id: 'team-id', name: 'Team', model: testModel });
    session.addParticipant('reviewer', secondTestModel);
    const text = [
      'These are examples only:',
      '"@reviewer quoted inline" and `@reviewer inline code`.',
      '"@new-inline test-second-session-model do not join"',
      '',
      '> [!NOTE]',
      '> @reviewer do not run',
      '> @new-agent test-second-session-model do not join',
      '',
      '- @reviewer list example',
      '',
      '| Agent | Example |',
      '| --- | --- |',
      '| reviewer | @reviewer |',
      '',
      '```text',
      '@reviewer fenced example',
      '```',
    ].join('\n');

    await session.sendMessage({ role: 'user', content: [{ type: 'text', text }] });

    expect(calls).toEqual(['sirus']);
    expect(session.getParticipants().map(participant => participant.name)).toEqual(['sirus', 'reviewer']);
    expect(session.getMessages()[0]).toEqual({ seq: 0, role: 'user', to: ['sirus'], content: [{ type: 'text', text }] });
  });

  test('runs only top-level mentions when blocked examples appear in the same message', async () => {
    const calls: string[] = [];
    bindScriptedRuntime(testModel, (_input, emit) => {
      calls.push('reviewer');
      emit({ type: 'text', text: 'reviewed' });
    });
    bindScriptedRuntime(secondTestModel, (_input, emit) => {
      calls.push('verifier');
      emit({ type: 'text', text: 'verified' });
    });
    const session = new Session();
    session.addParticipant('reviewer', testModel);
    session.addParticipant('verifier', secondTestModel);

    await session.sendMessage({
      role: 'user',
      content: [{
        type: 'text',
        text: '@reviewer inspect this\n\n> @verifier quoted example only',
      }],
    });

    expect(calls).toEqual(['reviewer']);
  });

  test('does not delegate from an agent mention inside a Markdown block', async () => {
    let reviewerCalls = 0;
    bindScriptedRuntime(testModel, textTurn('> @reviewer this is a quoted example'));
    bindScriptedRuntime(secondTestModel, (_input, emit) => {
      reviewerCalls++;
      emit({ type: 'text', text: 'reviewed' });
    });
    const session = new Session({ id: 'team-id', name: 'Team', model: testModel });
    session.addParticipant('reviewer', secondTestModel);

    await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Start' }] });

    expect(reviewerCalls).toBe(0);
    expect(session.getMessages()).toHaveLength(2);
  });

  test('delivers whole messages to mentioned participants across delegation rounds', async () => {
    const calls: Array<{ model: string; text: string }> = [];
    let sirusCalls = 0;
    const record = (model: string): ScriptedTurn => (input, emit) => {
      calls.push({ model, text: input.text });
      if (model === testModel) {
        sirusCalls++;
        emit({ type: 'text', text: sirusCalls === 1 ? '@reviewer please review this.' : 'Thanks, review complete.' });
      } else if (model === secondTestModel) {
        // Sirus can be invoked again for a genuine back-and-forth while the
        // verifier runs alongside it in the same next round.
        emit({ type: 'text', text: '@sirus has the context. @verifier please verify.' });
      } else {
        // A peer can add another independently addressable participant.
        emit({ type: 'text', text: 'Verified. @new-agent test-session-model join us.' });
      }
    };
    bindScriptedRuntime(testModel, record(testModel));
    bindScriptedRuntime(secondTestModel, record(secondTestModel));
    bindScriptedRuntime(thirdTestModel, record(thirdTestModel));
    const session = new Session({ id: 'team-id', name: 'Team', model: testModel });
    session.addParticipant('reviewer', secondTestModel);
    session.addParticipant('verifier', thirdTestModel);

    await session.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'Start the review' }],
    });

    expect(calls.map(call => call.model))
      .toEqual([testModel, secondTestModel, testModel, thirdTestModel, testModel]);
    expect(calls[0].text).toBe('Start the review');
    // A mentioned participant gets the sender's whole message, attributed.
    expect(calls[1].text).toBe('@sirus wrote:\n@reviewer please review this.');
    expect(calls[2].text).toBe('@reviewer wrote:\n@sirus has the context. @verifier please verify.');
    expect(calls[3].text).toBe('@reviewer wrote:\n@sirus has the context. @verifier please verify.');
    expect(calls[4].text).toBe('@verifier wrote:\nVerified. @new-agent join us.');
    const responses = session.getMessages().filter(message => message.role === 'assistant');
    expect(responses.map(message => message.participant)).toEqual(['sirus', 'reviewer', 'sirus', 'verifier', 'new-agent']);
    // Delivery is recorded on the entry, so a restore puts it back where it went.
    expect(responses[0].to).toEqual(['reviewer']);
    expect(responses[1].to).toEqual(['sirus', 'verifier']);
    expect(responses[2].to).toBeUndefined();
    expect(responses[3].to).toEqual(['new-agent']);
    expect(session.getParticipants().map(participant => participant.name))
      .toEqual(['sirus', 'reviewer', 'verifier', 'new-agent']);
  });

  test('an agent-created participant receives only its handoff, replies to its creator, and survives restore', async () => {
    let turns = 0;
    const source = bindScriptedRuntime(testModel, (_input, emit) => {
      emit({ type: 'text', text: ++turns === 1
        ? `@Reviewer ${secondTestModel} Review src/example.ts. @reviewer Check the tests too.`
        : 'Review incorporated.' });
    });
    const reviewer = bindScriptedRuntime(secondTestModel, textTurn('@sirus The change passes review. Finish the task.'));
    const session = new Session({ model: testModel, permissionMode: 'ask' });
    let restored: Session | undefined;
    try {
      session.append({ role: 'user', content: [{ type: 'text', text: 'Earlier private context' }] });
      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Get a review' }] });
      expect(session.getParticipants().map(agent => [agent.name, agent.model])).toEqual([
        ['sirus', testModel], ['Reviewer', secondTestModel],
      ]);
      expect(session.getSelectedParticipant()).toBe('sirus');
      expect(source.runtimes[0].prompts).toHaveLength(2);
      expect(reviewer.starts).toHaveLength(1);
      expect(reviewer.starts[0].permissionMode).toBe('ask');
      expect(reviewer.starts[0].directory).toBe(session.getDirectory());
      expect(reviewer.runtimes[0].prompts[0].text).toBe('@sirus wrote:\n@Reviewer Review src/example.ts. @reviewer Check the tests too.');
      // Kept as the agent wrote it; only the runtime's prompt drops the model.
      expect(session.getMessages('Reviewer').map(textOf)).toEqual([
        `@Reviewer ${secondTestModel} Review src/example.ts. @reviewer Check the tests too.`,
        '@sirus The change passes review. Finish the task.',
      ]);
      restored = Session.fromSnapshot(session.toSnapshot());
      expect(restored.getParticipants()).toEqual(session.getParticipants());
      expect(restored.getMessages('Reviewer')).toEqual(session.getMessages('Reviewer'));
    } finally { await restored?.dispose(); await session.dispose(); }
  });

  test('a new participant takes a model named as /model takes it, and its model’s thinking', async () => {
    const aliased = bindScriptedRuntime('test-alias[1m]', textTurn('Looked.'));
    const session = new Session({ model: testModel });
    try {
      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: '@scout Test-Alias Look around.' }] });
      expect(session.getParticipants().find(agent => agent.name === 'scout')).toEqual({ name: 'scout', model: 'test-alias[1m]' });
      expect(session.getThinkingLevel('scout')).toBeUndefined();
      expect(aliased.starts[0].thinkingLevel).toBeUndefined();
      expect(aliased.runtimes[0].prompts[0].text).toBe('@scout Look around.');
    } finally { await session.dispose(); unbindRuntime('test-alias[1m]'); }
  });

  test('agent introduction examples, bare unknown names, invalid models, and self-mentions stay inert', async () => {
    const examples = [
      '@unknown has no model. @invalid not-a-supported-model do nothing.',
      `@sirus ${secondTestModel} cannot invoke or replace myself.`,
      `\`@inline ${secondTestModel} example\``,
      `"@quoted ${secondTestModel} example"`,
      `> @quote ${secondTestModel} example`,
      `- @listed ${secondTestModel} example`,
      `# @heading ${secondTestModel} example`,
      `| Example |\n| --- |\n| @table ${secondTestModel} example |`,
      `\`\`\`text\n@code ${secondTestModel} example\n\`\`\``,
    ].join('\n\n');
    const source = bindScriptedRuntime(testModel, textTurn(examples));
    const other = bindScriptedRuntime(secondTestModel, textTurn('Should not run'));
    const session = new Session({ model: testModel });
    try {
      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Explain the syntax' }] });
      expect(session.getParticipants()).toEqual([{ name: 'sirus', model: testModel }]);
      expect(source.runtimes[0].prompts).toHaveLength(1);
      expect(other.starts).toHaveLength(0);
      expect(textOf(session.getMessages().at(-1)!)).toBe(examples);
    } finally { await session.dispose(); }
  });

  test('an invalid introduction creates no partial roster and does not discard another peer’s handoff', async () => {
    bindScriptedRuntime(testModel, textTurn(`@unfinished ${thirdTestModel} Review this.\n\n@subagent ${thirdTestModel} Invalid reserved name.`));
    bindScriptedRuntime(secondTestModel, textTurn(`@helper ${thirdTestModel} Check the tests.`));
    const helper = bindScriptedRuntime(thirdTestModel, textTurn('Tests checked.'));
    const session = new Session({ model: testModel });
    session.addParticipant('reviewer', secondTestModel);
    try {
      await expect(session.sendMessage({ role: 'user', content: [{ type: 'text', text: '@sirus @reviewer Start' }] }))
        .rejects.toThrow('Invalid participant name: @subagent');
      expect(session.getParticipants().map(agent => agent.name)).toEqual(['sirus', 'reviewer', 'helper']);
      expect(helper.runtimes[0].prompts[0].text).toBe('@reviewer wrote:\n@helper Check the tests.');
      expect(session.getMessages('helper').map(textOf)).toEqual([`@helper ${thirdTestModel} Check the tests.`, 'Tests checked.']);
    } finally { await session.dispose(); }
  });

  test('ignores an agent mentioning itself', async () => {
    let calls = 0;
    bindScriptedRuntime(testModel, (_input, emit) => {
      calls++;
      emit({ type: 'text', text: '@sirus I should not invoke myself.' });
    });
    const session = new Session({ id: 'team-id', name: 'Team', model: testModel });

    await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Start' }] });

    expect(calls).toBe(1);
    expect(session.getMessages()).toHaveLength(2);
  });

  test('creates several participants mentioned by an agent and runs them in parallel with introduction context', async () => {
    let releaseReviewer!: () => void;
    let releaseVerifier!: () => void;
    const reviewerGate = new Promise<void>(resolve => { releaseReviewer = resolve; });
    const verifierGate = new Promise<void>(resolve => { releaseVerifier = resolve; });
    const started: string[] = [];
    bindScriptedRuntime(testModel, textTurn(`@reviewer ${secondTestModel} Review this.\n\n@verifier ${thirdTestModel} Verify this.`));
    const reviewer = bindScriptedRuntime(secondTestModel, async (_input, emit) => {
      started.push('reviewer');
      await reviewerGate;
      emit({ type: 'text', text: 'reviewed' });
    });
    const verifier = bindScriptedRuntime(thirdTestModel, async (_input, emit) => {
      started.push('verifier');
      await verifierGate;
      emit({ type: 'text', text: 'verified' });
    });
    const session = new Session({ id: 'team-id', name: 'Team', model: testModel });

    const turn = session.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'Delegate this' }],
    });
    try {
      await until(() => started.length === 2, 'both introduced participants to start');
      expect(started).toEqual(['reviewer', 'verifier']);
      expect(reviewer.runtimes[0].prompts[0].text).toBe(
        `This message adds @verifier (${thirdTestModel}) to the session as a new participant, and it receives this message too.\n\n@sirus wrote:\n@reviewer Review this.\n\n@verifier Verify this.`);
      expect(verifier.runtimes[0].prompts[0].text).toContain(`This message adds @reviewer (${secondTestModel})`);
      releaseVerifier();
      releaseReviewer();
      await turn;
      // The verifier was released first, so its reply came first.
      expect(session.getMessages().filter(message => message.role === 'assistant')
        .map(message => message.participant)).toEqual(['sirus', 'verifier', 'reviewer']);
    } finally { releaseVerifier(); releaseReviewer(); await turn; await session.dispose(); }
  });

  test('persists all participants and their model choices in snapshots', () => {
    bindScriptedRuntime(testModel, textTurn(''));
    const session = new Session({ name: 'Team' });
    session.addParticipant('reviewer', testModel);

    const restored = Session.fromSnapshot(session.toSnapshot());

    expect(restored.getParticipants()).toEqual([
      { name: 'sirus', model: 'gpt-5.6-luna' },
      { name: 'reviewer', model: testModel },
    ]);
  });

  test('restores delivered entries into every transcript they reached', async () => {
    bindScriptedRuntime(testModel, textTurn('@reviewer over to you'));
    const reviewer = bindScriptedRuntime(secondTestModel, textTurn('noted'));
    const session = new Session({ id: 'restore', name: 'Restore', model: testModel });
    session.addParticipant('reviewer', secondTestModel);
    await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Begin' }] });

    const restored = Session.fromSnapshot(session.toSnapshot());
    await restored.sendMessage({ role: 'user', content: [{ type: 'text', text: '@reviewer again' }] });
    // The reviewer's new runtime is reseeded with what reached the reviewer
    // and nothing the user said only to sirus.
    expect(reviewer.runtimes[1].prompts[0].text).toBe([
      'Earlier conversation, for context:',
      '@sirus: @reviewer over to you',
      '@reviewer: noted',
      '',
      '@reviewer again',
    ].join('\n'));
  });
});

describe('Session subscriptions', () => {
  test('tracks working, idle, and error turn states', async () => {
    let finish!: () => void;
    let shouldFail = false;
    bindScriptedRuntime(testModel, async (_input, emit) => {
      await new Promise<void>(resolve => { finish = resolve; });
      if (shouldFail) {
        emit({ type: 'text', text: 'Partial before failure' });
        throw new Error('runtime failed');
      }
      emit({ type: 'text', text: 'done' });
    });
    const session = new Session({ id: 'status-id', name: 'Status', model: testModel });

    expect(session.getStatus()).toBe('idle');
    const successfulTurn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Start' }] });
    expect(session.getStatus()).toBe('working');
    while (!finish) await new Promise(resolve => setTimeout(resolve, 0));
    finish();
    await successfulTurn;
    expect(session.getStatus()).toBe('idle');

    shouldFail = true;
    finish = undefined as unknown as () => void;
    const failedTurn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Again' }] });
    expect(session.getStatus()).toBe('working');
    while (!finish) await new Promise(resolve => setTimeout(resolve, 0));
    finish();
    await expect(failedTurn).rejects.toThrow('refused or could not complete');
    expect(session.getStatus()).toBe('error');
    expect(session.getMessages().at(-1)).toEqual({
      seq: 3,
      role: 'assistant',
      participant: 'sirus',
      model: testModel,
      content: [{ type: 'text', text: 'Partial before failure' }, { type: 'notice', severity: 'error', title: 'Codex refused or could not complete this request. Try again or revise the prompt.' }],
      startedAt: expect.any(Number),
      finishedAt: expect.any(Number),
    });
  });

  test('notifies subscribers when the model changes', () => {
    const session = new Session();
    let calls = 0;
    session.subscribe(() => calls++);
    session.changeParticipantModel('sirus', 'claude-fable-5-1');
    expect(calls).toBe(1);
  });

  test('notifies subscribers when a message is appended', () => {
    const session = new Session();
    let calls = 0;
    session.subscribe(() => calls++);
    session.append({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
    expect(calls).toBe(1);
  });

  test('clear removes history and notifies subscribers', () => {
    const session = new Session();
    session.append({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
    let calls = 0;
    session.subscribe(() => calls++);

    session.clear();

    expect(session.getMessages()).toEqual([]);
    expect(calls).toBe(1);
  });

  test('clearing an empty history is a no-op', () => {
    const session = new Session();
    let calls = 0;
    session.subscribe(() => calls++);
    session.clear();
    expect(calls).toBe(0);
  });

  test('unsubscribe stops notifications', () => {
    const session = new Session();
    let calls = 0;
    const unsubscribe = session.subscribe(() => calls++);
    unsubscribe();
    session.changeParticipantModel('sirus', 'claude-fable-5-1');
    session.append({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
    expect(calls).toBe(0);
  });

  test('version increments on each mutation (stable snapshot for useSyncExternalStore)', () => {
    const session = new Session();
    const before = session.getVersion();
    session.append({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
    session.changeParticipantModel('sirus', 'claude-fable-5-1');
    expect(session.getVersion()).toBe(before + 2);
  });

  test('switches every live runtime when the permission mode changes', async () => {
    const binding = bindScriptedRuntime(testModel, textTurn('ok'));
    const session = new Session({ id: 'modes', name: 'Modes', model: testModel });
    await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
    session.setPermissionMode('ask');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(binding.runtimes[0].permissionMode).toBe('ask');
    expect(session.getModeNotice()).toBeNull();
  });

  test('switches a working worker’s runtime with the session’s', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let session!: Session;
    let spawned = false;
    const binding = bindScriptedRuntime(testModel, async (_input, emit, options) => {
      if (isWorker(options)) {
        await gate;
        return;
      }
      if (!spawned) {
        spawned = true;
        await session.subagentHostFor('sirus')!.spawn('Background task', { context: 'fresh' }, { callId: 'spawn' });
      }
      emit({ type: 'text', text: 'Noted' });
    });
    session = new Session({ id: 'worker-modes', name: 'Worker modes', model: testModel });
    try {
      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Delegate it' }] });
      const worker = () => binding.runtimes[binding.starts.findIndex(isWorker)];
      await until(() => worker()?.prompts.length === 1, 'the worker to start its turn');
      session.setPermissionMode('ask');
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(worker().permissionMode).toBe('ask');
    } finally {
      release();
      await session.dispose();
    }
  });
});

describe('session-owned workers', () => {
  test('a session stops only its own workers, on its own subagent model', async () => {
    const { listAllSubagents } = await import('../../src/agent_runtime/tools/subagents');
    let finishWorkers!: () => void;
    const workerGate = new Promise<void>(resolve => { finishWorkers = resolve; });
    const sessions: Session[] = [];
    let spawns = 0;
    bindScriptedRuntime(secondTestModel, async (_input, emit) => {
      await workerGate;
      emit({ type: 'text', text: 'Worker done' });
    });
    bindScriptedRuntime(testModel, async (_input, emit, options) => {
      expect(options.mcpServer?.headers[1].value).toBe('sirus');
      if (spawns < sessions.length) {
        await sessions[spawns++].subagentHostFor('sirus')!.spawn('Work', { context: 'fresh' }, { callId: 'spawn' });
      }
      emit({ type: 'text', text: 'Worker started' });
    });
    const first = new Session({ id: 'owned-first', name: 'First', model: testModel, subagentModel: secondTestModel });
    const second = new Session({ id: 'owned-second', name: 'Second', model: testModel, subagentModel: secondTestModel });
    sessions.push(first, second);
    const message: Draft = { role: 'user', content: [{ type: 'text', text: 'Start' }] };
    try {
      await first.sendMessage(message);
      await second.sendMessage(message);
      const [firstWorker] = first.getWorkers();
      const [secondWorker] = second.getWorkers();
      expect(first.getStatus()).toBe('idle');
      // The session's fixed subagent model wins over the owner's model.
      expect(firstWorker).toMatchObject({ model: secondTestModel, sessionId: 'owned-first' });
      expect(first.getWorkers().map(run => run.id)).toEqual([firstWorker.id]);

      await first.cancelWorker(firstWorker.id);
      expect(firstWorker.status).toBe('cancelled');
      expect(secondWorker.status).toBe('working');
      expect(listAllSubagents()).toContain(secondWorker);

      // A deleted session takes its own worker with it and leaves the other.
      await first.dispose();
      expect(listAllSubagents()).not.toContain(firstWorker);
      expect(listAllSubagents()).toContain(secondWorker);
      expect(secondWorker.status).toBe('working');
    } finally {
      finishWorkers();
      await second.dispose();
    }
  });
});

test('named workers wait, interrupt, resume warm conversations, and recover from failure', async () => {
  let workerRuntime: import('../support/runtime').ScriptedRuntime | undefined;
  const ownerPrompts: string[] = [];
  bindScriptedRuntime(testModel, async (input, emit, options, _signal, runtime) => {
    if (!isWorker(options)) { ownerPrompts.push(input.text); return; }
    workerRuntime = runtime;
    if (input.text === 'Block') await new Promise(() => {});
    if (input.text === 'Fail now') throw new Error('Deliberate failure');
    emit({ type: 'text', text: `Result: ${input.text}` });
  });
  const session = new Session({ id: 'worker-resume-turns', name: 'Resume', model: testModel });
  const host = session.subagentHostFor('sirus')!;
  try {
    const handle = await host.spawn('Block', { name: 'helper', description: 'Check the lifecycle' }, { callId: 'spawn' });
    await until(() => workerRuntime !== undefined, 'worker runtime');
    expect(await host.wait(['helper'], 0)).toEqual([expect.objectContaining({ id: handle.id, status: 'working' })]);
    await expect(host.spawn('Duplicate', { name: 'helper' }, { callId: 'duplicate' })).rejects.toThrow('already in use');
    const originalRuntime = workerRuntime!;
    await host.message('helper', 'Second turn', true);
    expect(await host.wait(['helper'], 1000)).toEqual([expect.objectContaining({ status: 'done', finalMessage: 'Result: Second turn' })]);
    expect(ownerPrompts.join('\n')).not.toContain('Interrupted by SendMessage');
    await host.message('helper', 'Continuation');
    await host.wait(['helper'], 1000);
    expect(workerRuntime).toBe(originalRuntime);
    expect(originalRuntime.prompts.map(prompt => prompt.text)).toEqual(['Block', 'Second turn', 'Continuation']);
    await host.message('helper', 'Fail now');
    expect(await host.wait(['helper'], 1000)).toEqual([expect.objectContaining({ status: 'failed' })]);
    await host.message('helper', 'Recovered');
    await host.wait(['helper'], 1000);
    expect(host.check('helper')).toMatchObject({ status: 'done' });
    expect(workerRuntime!.prompts[0].text).toContain('Second turn');
    expect(workerRuntime!.prompts[0].text).toContain('Continuation');
    expect(workerRuntime!.prompts[0].text).toContain('Recovered');
  } finally {
    await session.dispose();
  }
});

test('a restored worker reopens its native session and snapshots its replacement after reset', async () => {
  const profileHome = mkdtempSync(path.join(os.tmpdir(), 'sirus-worker-profile-'));
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = profileHome;
  const binding = bindScriptedRuntime(testModel, textTurn('Finished'), true);
  const session = new Session({ id: 'native-worker', name: 'Worker restart', model: testModel });
  let reopened: Session | undefined;
  try {
    await session.subagentHostFor('sirus')!.spawn('Remember the tool results', { runInBackground: false }, { callId: 'spawn' });
    const snapshot = session.toSnapshot();
    const saved = snapshot.workers![0]!;
    expect(saved.nativeSession).toMatchObject({
      vendor: 'gpt', sessionId: binding.runtimes[0]!.sessionId,
      directory: session.getDirectory(), sourceId: null, profileHome,
    });
    await session.dispose();
    reopened = Session.fromSnapshot(snapshot);
    expect(reopened.getWorkers()[0]!.worker).toBeNull();
    await reopened.messageWorker(saved.id, 'Continue from the tool results');
    await reopened.subagentHostFor('sirus')!.wait([saved.id], 1000);
    const resumed = binding.runtimes[1]!;
    expect(binding.starts[1]!.resume).toEqual(saved.nativeSession);
    expect(resumed.prompts[0]!.text).toBe('Continue from the tool results');
    expect(reopened.toSnapshot().workers![0]!.nativeSession).toEqual(saved.nativeSession);

    // A reset invalidates the saved ref even though the run still holds the
    // original restored record. The next continuation must use the recap.
    const worker = reopened.getWorkers()[0]!;
    worker.worker!.resetRuntime();
    expect(reopened.toSnapshot().workers![0]!.nativeSession).toBeUndefined();
    await reopened.messageWorker(saved.id, 'Start again');
    await reopened.subagentHostFor('sirus')!.wait([saved.id], 1000);
    const fresh = binding.runtimes.find(runtime => runtime.prompts[0]?.text.endsWith('Start again'))!;
    expect(fresh.prompts[0]!.text).toContain('Earlier conversation');
    expect(reopened.toSnapshot().workers![0]!.nativeSession!.sessionId).toBe(fresh.sessionId);
    expect(fresh.sessionId).not.toBe(saved.nativeSession!.sessionId);
  } finally {
    await reopened?.dispose();
    await session.dispose();
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    rmSync(profileHome, { recursive: true, force: true });
  }
});

test('foreground workers return their report without a notification and apply agent definitions', async () => {
  const { mkdirSync, writeFileSync } = await import('fs');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sirus-agent-definition-'));
  mkdirSync(path.join(directory, '.claude', 'agents'), { recursive: true });
  writeFileSync(path.join(directory, '.claude', 'agents', 'reader.md'), `---\nname: reader\ndescription: Reads only\ntools: Read, Grep\nmodel: ${secondTestModel}\nthinkingLevel: low\n---\nFollow the READER_CONTRACT.`);
  const binding = bindScriptedRuntime(secondTestModel, (_input, emit) => { emit({ type: 'text', text: 'Definition result' }); });
  bindScriptedRuntime(testModel, textTurn('Owner'));
  const session = new Session({ id: 'foreground-definition', name: 'Definition', directory, model: testModel });
  try {
    const result = await session.subagentHostFor('sirus')!.spawn('Read', { agentType: 'reader', runInBackground: false }, { callId: 'spawn' });
    expect(result).toMatchObject({ status: 'done', model: secondTestModel, thinkingLevel: 'low', finalMessage: 'Definition result' });
    expect(binding.starts[0]).toMatchObject({ tools: ['Read', 'Grep'], readOnly: true });
    expect(binding.starts[0].systemPrompt).toContain('READER_CONTRACT');
    expect(session.getMessages()).toEqual([]);
    expect(session.getWorkers()[0]).toMatchObject({ directory, branch: null, reported: true });
    const restored = Session.fromSnapshot(session.toSnapshot());
    try {
      await restored.messageWorker(session.getWorkers()[0].id, 'Read again');
      await restored.subagentHostFor('sirus')!.wait([session.getWorkers()[0].id], 1000);
      expect(binding.starts.at(-1)?.systemPrompt).toContain('READER_CONTRACT');
      expect(binding.runtimes.at(-1)?.prompts[0].text).toContain('Definition result');
    } finally {
      await restored.dispose();
    }
  } finally {
    await session.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a foreground worker its owner stops waiting for carries on in the background and reports', async () => {
  const gates = new Map<string, () => void>();
  const ownerPrompts: string[] = [];
  let spawned: Promise<Record<string, unknown>> | null = null;
  let session!: Session;
  bindScriptedRuntime(testModel, async (input, emit, options) => {
    if (isWorker(options)) {
      await new Promise<void>(resolve => { gates.set(input.text, resolve); });
      emit({ type: 'text', text: `Finished: ${input.text}` });
      return;
    }
    ownerPrompts.push(input.text);
    if (ownerPrompts.length === 1) {
      spawned = session.subagentHostFor('sirus')!.spawn('Slow task', { runInBackground: false }, { callId: 'spawn' });
      await spawned.catch(() => {});
    }
    emit({ type: 'text', text: 'Noted' });
  });
  session = new Session({ id: 'foreground-left', name: 'Foreground left', model: testModel });
  const host = session.subagentHostFor('sirus')!;
  try {
    // Esc stops the owner's turn while it waits in its SpawnAgent call.
    const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Delegate it' }] });
    await until(() => gates.has('Slow task'), 'the worker to start');
    session.cancel();
    await turn.catch(() => {});
    await expect(spawned!).rejects.toThrow();
    const [cancelled] = session.getWorkers();
    expect(cancelled).toMatchObject({ status: 'working', runInBackground: true });
    gates.get('Slow task')!();
    await until(() => ownerPrompts.length === 2 && session.getStatus() === 'idle', 'the report turn');
    expect(cancelled.reported).toBe(true);
    expect(ownerPrompts[1]).toStartWith(`Subagent ${cancelled.id} done`);
    expect(ownerPrompts[1]).toContain('Finished: Slow task');

    // A wait that would outlast the vendor's patience with a tool call
    // returns before it gives up, and the run reports the same way.
    jest.useFakeTimers();
    let result: Record<string, unknown>;
    try {
      const pending = host.spawn('Long task', { runInBackground: false }, { callId: 'spawn-long' });
      // Microtasks only: the wait's own timer is the one being tested.
      for (let tick = 0; tick < 1000 && session.getWorkers().length < 2; tick++) await Promise.resolve();
      for (let tick = 0; tick < 20; tick++) await Promise.resolve();
      jest.advanceTimersByTime(TOOL_WAIT_LIMIT_MS);
      result = await pending;
    } finally {
      jest.useRealTimers();
    }
    expect(result).toMatchObject({ status: 'working', note: expect.stringContaining('carries on in the background') });
    const long = session.getWorkers()[1];
    expect(long.runInBackground).toBe(true);
    await until(() => gates.has('Long task'), 'the long worker to start');
    gates.get('Long task')!();
    await until(() => ownerPrompts.length === 3 && session.getStatus() === 'idle', 'the second report turn');
    expect(ownerPrompts[2]).toContain('Finished: Long task');
  } finally {
    for (const release of gates.values()) release();
    await session.dispose();
  }
});

test('a worker whose call was refused says so in the report its owner reads', async () => {
  bindScriptedRuntime(testModel, (_input, emit) => {
    emit({ type: 'tool_call', call: {
      type: 'tool_call', id: 'refused-edit', title: 'Edit README.md', kind: 'edit', status: 'failed', locations: [],
      content: [{ type: 'text', text: '```\n<tool_use_error>User refused permission to run tool</tool_use_error>\n```' }],
    } });
    emit({ type: 'text', text: 'The edit was declined.' });
  });
  const session = new Session({ id: 'refused-worker', name: 'Refused', model: testModel });
  try {
    const result = await session.subagentHostFor('sirus')!.spawn('Append a line', { runInBackground: false }, { callId: 'spawn' });
    expect(result).toMatchObject({ status: 'done', failedCalls: ['Edit README.md: User refused permission to run tool'] });
    const { workerReport } = await import('../../src/agent_runtime/tools/subagents/report');
    expect(workerReport(session.getWorkers()[0])).toContain(
      'Calls that did not go through:\n- Edit README.md: User refused permission to run tool\n\nFinal message:\n\nThe edit was declined.');
  } finally {
    await session.dispose();
  }
});

test('time inside a running tool call is not silence to the worker watchdog', async () => {
  let finishCall!: () => void;
  const callGate = new Promise<void>(resolve => { finishCall = resolve; });
  let finishTurn!: () => void;
  const turnGate = new Promise<void>(resolve => { finishTurn = resolve; });
  const call = { type: 'tool_call' as const, id: 'suite', title: 'bun test', kind: 'execute' as const, locations: [], content: [] };
  bindScriptedRuntime(testModel, async (_input, emit, options) => {
    if (!isWorker(options)) return;
    emit({ type: 'tool_call', call: { ...call, status: 'in_progress' } });
    await callGate;
    emit({ type: 'tool_call', call: { ...call, status: 'completed' } });
    await turnGate;
  });
  const session = new Session({ id: 'quiet-tool', name: 'Quiet tool', model: testModel });
  try {
    await session.subagentHostFor('sirus')!.spawn('Run the suite', {}, { callId: 'spawn' });
    const [run] = session.getWorkers();
    await until(() => run.content.some(block => block.type === 'tool_call'), 'the command to start');
    // Twenty minutes into the command, the worker is busy, not hung.
    setSystemTime(new Date(Date.now() + 20 * 60_000));
    expect(run.worker!.quietFor).toBe(0);
    setSystemTime();
    finishCall();
    await until(() => run.content.some(block => block.type === 'tool_call' && block.status === 'completed'), 'the command to end');
    // Once nothing is running, silence counts again.
    setSystemTime(new Date(Date.now() + 16 * 60_000));
    expect(run.worker!.quietFor).toBeGreaterThanOrEqual(15 * 60_000);
  } finally {
    setSystemTime();
    finishCall();
    finishTurn();
    await session.dispose();
  }
});

test('owner context on another vendor seeds a fresh runtime and never attempts a fork', async () => {
  const previous = { ANTHROPIC_API: process.env.ANTHROPIC_API, OPENAI_SECRET: process.env.OPENAI_SECRET };
  process.env.ANTHROPIC_API = 'test-anthropic-key';
  process.env.OPENAI_SECRET = 'test-openai-key';
  const owner = bindScriptedRuntime('gpt-5.6-luna', textTurn('Remember CROSS_VENDOR_CONTEXT'));
  const worker = bindScriptedRuntime('claude-sonnet-5', textTurn('I remember'));
  const session = new Session({ id: 'cross-vendor-worker', name: 'Cross vendor', model: 'gpt-5.6-luna' });
  try {
    await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Remember the context' }] });
    await session.subagentHostFor('sirus')!.spawn('Continue', { context: 'owner', model: 'claude-sonnet-5', runInBackground: false }, { callId: 'spawn' });
    expect(owner.forks).toHaveLength(0);
    expect(worker.runtimes[0].prompts[0].text).toContain('CROSS_VENDOR_CONTEXT');
    expect(worker.starts[0].vendor).toBe('claude');
  } finally {
    await session.dispose();
    unbindRuntime('gpt-5.6-luna');
    unbindRuntime('claude-sonnet-5');
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('notifications stay attached to their completed turn when steering acknowledges after a resume', async () => {
  let releaseOwner!: () => void;
  const ownerGate = new Promise<void>(resolve => { releaseOwner = resolve; });
  const acknowledgements: (() => void)[] = [];
  const steered: string[] = [];
  bindScriptedRuntime(testModel, async (input, emit, options, _signal, runtime) => {
    if (isWorker(options)) { emit({ type: 'text', text: input.text }); return; }
    runtime.steer = text => new Promise<void>(resolve => { steered.push(text); acknowledgements.push(resolve); });
    emit({ type: 'tool_call', call: {
      type: 'tool_call', id: 'spawn-delayed', title: 'mcp.sirus.SpawnAgent', kind: 'execute',
      status: 'completed', locations: [], content: [],
    } });
    await ownerGate;
  });
  const session = new Session({ id: 'delayed-reports', name: 'Delayed reports', model: testModel });
  const ownerTurn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Start' }] });
  try {
    await until(() => session.getMessages().some(entry => entry.content.some(block => block.type === 'tool_call')), 'owner runtime');
    const host = session.subagentHostFor('sirus')!;
    await host.spawn('FIRST_RESULT', { name: 'delayed' }, { callId: 'spawn-delayed' });
    await host.wait(['delayed'], 1000);
    expect(acknowledgements).toHaveLength(1);
    await host.message('delayed', 'SECOND_RESULT');
    await host.wait(['delayed'], 1000);
    expect(acknowledgements).toHaveLength(2);
    acknowledgements[1]();
    await new Promise(resolve => setImmediate(resolve));
    acknowledgements[0]();
    await new Promise(resolve => setImmediate(resolve));
    const notifications = session.getMessages().filter(entry => entry.hidden).map(textOf);
    expect(notifications).toHaveLength(2);
    expect(notifications.some(text => text.includes('Final message:\n\nFIRST_RESULT'))).toBe(true);
    expect(notifications.some(text => text.includes('Final message:\n\nSECOND_RESULT'))).toBe(true);
    expect(steered[0]).toContain('FIRST_RESULT');
    expect(steered[1]).toContain('SECOND_RESULT');
    const call = session.getMessages().flatMap(entry => entry.content).find(block => block.type === 'tool_call');
    expect(call).toMatchObject({ output: expect.stringContaining('Final message:\n\nSECOND_RESULT') });
    expect(session.getWorkers()[0].reported).toBe(true);
  } finally {
    for (const acknowledge of acknowledgements) acknowledge();
    releaseOwner();
    await ownerTurn;
    await session.dispose();
  }
});

test('retries an adapter crash once, carries completed work, and records the final error', async () => {
  const { AdapterLostError } = await import('../../src/agent_runtime/runtime/errors');
  let attempts = 0;
  const binding = bindScriptedRuntime(testModel, (_input, emit) => {
    attempts++;
    emit({ type: 'text', text: 'Inspected the project.' });
    throw new AdapterLostError('claude adapter closed the connection: sessionId=secret phase=validate-cwd');
  });
  const session = new Session({ model: testModel });
  try {
    await expect(session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Continue' }] })).rejects.toThrow('adapter stopped unexpectedly');
    expect(attempts).toBe(2);
    expect(binding.runtimes[1].prompts[0].text).toContain('Inspected the project.');
    expect(binding.runtimes[1].prompts[0].text).toContain('without repeating it');
    const errors = session.getMessages().flatMap(entry => entry.content).filter(block => block.type === 'notice' && block.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors)).not.toContain('sessionId');
    bindScriptedRuntime(testModel, textTurn('Recovered'));
    await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Next' }] });
    expect(Session.fromSnapshot(session.toSnapshot()).getMessages().flatMap(entry => entry.content)).toContainEqual(errors[0]);
  } finally { await session.dispose(); }
});

test('a single credential recovers automatically after its adapter crashes', async () => {
  const { providerFor } = await import('../../src/agent_runtime/providers');
  const { AdapterLostError } = await import('../../src/agent_runtime/runtime/errors');
  const model = 'gpt-5.6-luna';
  const credentials = spyOn(providerFor('gpt').sources, 'list').mockReturnValue([{ id: 'only', kind: 'subscription', profile: 'default' }]);
  let attempts = 0;
  const binding = bindScriptedRuntime(model, (_input, emit) => {
    if (++attempts === 1) throw new AdapterLostError('closed');
    emit({ type: 'text', text: 'Recovered' });
  });
  const session = new Session({ model });
  try {
    await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'hello' }] });
    expect(binding.starts).toHaveLength(2);
    expect(textOf(session.getMessages().at(-1)!)).toBe('Recovered');
  } finally { await session.dispose(); credentials.mockRestore(); unbindRuntime(model); }
});

test.each([
  ['429 rate limit. Resets at 18:30 UTC', 'limit', 'Resets at 18:30 UTC'],
  ['usage_limit_reached: allowance spent, try again in 12 hours', 'limit', 'try again in 12 hours'],
  ['401 authentication token expired', 'login', '/login'],
  ['policy denied', 'refused', 'refused'],
] as const)('classifies %s without retrying a live vendor refusal', async (raw, kind, expected) => {
  const { turnFailure } = await import('../../src/agent_runtime/runtime/errors');
  const failure = turnFailure(new Error(raw), 'claude', 'reviewer');
  expect(failure.kind).toBe(kind);
  expect(failure.message).toContain(expected);
  if (kind === 'limit') expect(failure.message).toMatch(/To use Codex instead, (?:type \/model @reviewer \S+|sign in with \/login)\.$/);
  let attempts = 0;
  bindScriptedRuntime(testModel, () => { attempts++; throw new Error(raw); });
  const session = new Session({ model: testModel });
  try {
    await expect(session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'hello' }] })).rejects.toThrow(expected);
    expect(attempts).toBe(1);
    expect(session.getMessages().at(-1)?.content).toMatchObject([{ type: 'notice', severity: 'error' }]);
  } finally { await session.dispose(); }
});

test('draft warmup is shared with the first turn and is disposed if unused', async () => {
  const binding = bindScriptedRuntime(testModel, textTurn('Ready'));
  const session = new Session({ model: testModel });
  await Promise.all([session.warmup(), session.warmup()]);
  expect(binding.starts).toHaveLength(1);
  expect(binding.runtimes[0].prompts).toHaveLength(0);
  expect(session.isEmpty()).toBe(true);
  await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'hello' }] });
  expect(binding.starts).toHaveLength(1);
  expect(binding.runtimes[0].prompts[0].text).toBe('hello');
  session.releaseWarmup();
  expect(binding.runtimes[0].disposed).toBe(false);
  await session.dispose();
  const draft = new Session({ model: testModel });
  await draft.warmup();
  draft.releaseWarmup();
  expect(binding.runtimes.at(-1)?.disposed).toBe(true);
  await draft.dispose();
});

test('queued follow-ups wait for all foreground tools, then steer in FIFO order in the same turn', async () => {
  let emit!: (update: RuntimeUpdate) => void;
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const binding = bindScriptedRuntime(testModel, async (_input, update) => {
    emit = update;
    await gate;
  });
  const session = new Session({ model: testModel });
  const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Work' }] });
  const tool = (id: string, status: 'in_progress' | 'completed') => emit({ type: 'tool_call', call: {
    type: 'tool_call', id, title: id, kind: 'execute', status, locations: [], content: [],
  } });
  try {
    await until(() => !!emit, 'runtime to start');
    tool('one', 'in_progress');
    tool('two', 'in_progress');
    session.queueMessage('First');
    session.queueMessage('Second');
    tool('one', 'completed');
    expect(binding.runtimes[0].steers).toEqual([]);
    expect(session.getQueuedMessageCount()).toBe(2);
    tool('two', 'completed');
    await until(() => binding.runtimes[0].steers.length === 2, 'safe point deliveries');
    expect(binding.runtimes[0].steers).toEqual(['First', 'Second']);
    expect(binding.runtimes[0].prompts).toHaveLength(1);
    expect(session.getQueuedMessageCount()).toBe(0);
  } finally {
    finish();
    await turn;
    await session.dispose();
  }
});

test('steering records the injection boundary before the runtime streams its continuation', async () => {
  let emit!: (update: RuntimeUpdate) => void;
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  bindScriptedRuntime(testModel, async (_input, update, _options, _signal, runtime) => {
    emit = update;
    emit({ type: 'text', text: 'Before' });
    runtime.onSteer = () => emit({ type: 'text', text: 'After' });
    await gate;
  });
  const session = new Session({ model: testModel });
  const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Work' }] });
  try {
    await until(() => !!emit, 'runtime to start');
    await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'New instruction' }] });
    const messages = session.getMessages();
    const reply = messages.find(message => message.role === 'assistant')!;
    expect(textOf(reply)).toBe('BeforeAfter');
    expect(messages.at(-1)!.injectedAt).toEqual({ seq: reply.seq, block: 0, offset: 6 });
  } finally {
    finish();
    await turn;
    await session.dispose();
  }
});

test.each(['/help', '!echo hello'])('queued %s blocks later text at a tool boundary', async command => {
  let emit!: (update: RuntimeUpdate) => void;
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const binding = bindScriptedRuntime(testModel, async (_input, update) => { emit = update; await gate; });
  const session = new Session({ model: testModel });
  const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Work' }] });
  try {
    await until(() => !!emit, 'runtime to start');
    session.queueMessage(command);
    session.queueMessage('Later');
    emit({ type: 'tool_call', call: {
      type: 'tool_call', id: 'done', title: 'Done', kind: 'execute', status: 'completed', locations: [], content: [],
    } });
    expect(binding.runtimes[0].steers).toEqual([]);
    expect(session.getQueuedMessages().map(item => item.text)).toEqual([command, 'Later']);
    finish();
    await turn;
    expect(session.getQueuedMessageCount()).toBe(2);
  } finally {
    finish();
    await turn;
    await session.dispose();
  }
});

test('refused send-now interrupts and delivers the retained messages in FIFO order', async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const binding = bindScriptedRuntime(testModel, async (input, _emit, _options, _signal, runtime) => {
    if (input.text === 'Work') {
      runtime.steer = async () => { throw new Error('Cannot steer'); };
      await gate;
    }
  });
  const session = new Session({ model: testModel });
  const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Work' }] }).catch(() => {});
  try {
    await until(() => binding.runtimes[0]?.prompts.length === 1, 'runtime to start');
    session.queueMessage('First');
    session.queueMessage('Second');
    await session.deliverQueuedMessages();
    await turn;
    await until(() => binding.runtimes[0].prompts.length === 3, 'queued turns');
    expect(binding.runtimes[0].prompts.map(prompt => prompt.text)).toEqual(['Work', 'First', 'Second']);
  } finally {
    finish();
    await turn;
    await session.dispose();
  }
});

test('an interrupted delivery retains only the undelivered follow-up ahead of later messages', async () => {
  let rejectSteer!: (error: Error) => void;
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const binding = bindScriptedRuntime(testModel, async (input, _emit, _options, _signal, runtime) => {
    if (input.text === 'Work') {
      runtime.steer = () => new Promise<void>((_resolve, reject) => { rejectSteer = reject; });
      await gate;
    }
  });
  const session = new Session({ model: testModel });
  const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Work' }] }).catch(() => {});
  try {
    await until(() => binding.runtimes[0]?.prompts.length === 1, 'runtime to start');
    session.queueMessage('First');
    session.queueMessage('Second');
    const delivery = session.deliverQueuedMessages();
    await until(() => !!rejectSteer, 'steering request');
    session.cancel();
    rejectSteer(new DOMException('Interrupted', 'AbortError'));
    await delivery;
    await turn;
    await until(() => binding.runtimes[0].prompts.length === 3, 'retained messages');
    expect(binding.runtimes[0].prompts.map(prompt => prompt.text)).toEqual(['Work', 'First', 'Second']);
    expect(session.getMessages().filter(message => message.role === 'user').map(textOf))
      .toEqual(['Work', 'First', 'Second']);
  } finally {
    finish();
    await turn;
    await session.dispose();
  }
});

test('a pending warmup cannot survive a model change or draft disposal', async () => {
  const { boundRuntimes } = await import('../../src/agent_runtime/runtime/runtime');
  const binding = bindScriptedRuntime(testModel, textTurn('Old'));
  const oldFactory = boundRuntimes[testModel];
  let finish!: () => void;
  let started!: () => void;
  const opening = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  boundRuntimes[testModel] = async options => { started(); await gate; return oldFactory(options); };
  const next = bindScriptedRuntime(secondTestModel, textTurn('New'));
  const session = new Session({ model: testModel });
  const warm = session.warmup().catch(() => undefined);
  await opening;
  session.changeParticipantModel('sirus', secondTestModel);
  await session.warmup();
  finish();
  await warm;
  await until(() => binding.runtimes[0]?.disposed === true, 'superseded warmup disposal');
  expect(binding.runtimes[0].disposed).toBe(true);
  await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'hello' }] });
  expect(next.starts).toHaveLength(1);
  expect(textOf(session.getMessages().at(-1)!)).toBe('New');
  await session.dispose();
});

test.each(['gpt', 'claude'] as const)('ACP %s advertises async tasks and stops cancelled shells including late announcements', async vendor => {
  const adapter = `
    import { createInterface } from 'node:readline';
    const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
    const update = (sessionId, update) => send({ method: 'session/update', params: { sessionId, update } });
    const task = (sessionId, id) => update(sessionId, {
      sessionUpdate: 'async_task_spawned', asyncTaskId: id, name: 'sleep 20', canStop: true, toolCallId: 'tool-' + id
    });
    const turns = new Map();
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      const reply = result => send({ id: request.id, result });
      const sessionId = request.params?.sessionId;
      if (request.method === 'initialize') {
        const air = request.params.clientCapabilities._meta?.jetbrains?.air;
        if (air?.version !== 1 || !air.capabilities.includes('asyncTasks')) throw new Error('Async tasks were not advertised');
        reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { fork: {} } } });
      } else if (request.method === 'session/new' || request.method === 'session/fork') {
        const id = request.method === 'session/new' ? 'owner' : 'worker';
        task(id, 'early');
        reply({ sessionId: id });
      } else if (request.method === 'session/prompt') {
        if (request.params.prompt.at(-1).text === 'Next') {
          update(sessionId, { sessionUpdate: 'usage_update', used: 100, size: 200000,
            _meta: { '_claude/rateLimit': { resetsAt: 2000000000 } } });
          task(sessionId, 'next');
          reply({ stopReason: 'end_turn' });
        } else {
          turns.set(sessionId, request.id);
          task(sessionId, 'running');
        }
      } else if (request.method === 'session/cancel') {
        send({ id: turns.get(sessionId), result: { stopReason: 'cancelled' } });
        setTimeout(() => task(sessionId, 'late'), 20);
      } else if (request.method === '_session/async_task/stop') {
        const id = request.params.asyncTaskId;
        update(sessionId, { sessionUpdate: 'notice', severity: 'info', title: 'stop received', description: id });
        update(sessionId, { sessionUpdate: 'async_task_progress', asyncTaskId: id, outputFilePath: '/tmp/' + id });
        setTimeout(() => {
          update(sessionId, { sessionUpdate: 'async_task_state_update', asyncTaskId: id, state: 'stopped' });
          reply({ stopped: true });
        }, 10);
      } else if (request.id !== undefined) reply({});
    }
  `;
  const spec = spyOn(launch, 'launchFor').mockImplementation(options => ({
    command: process.execPath, args: ['-e', adapter], env: options.env,
    mode: options.permissionMode, session: () => ({ mcpServers: [] }), forkNeedsResume: false,
  }));
  const updates: RuntimeUpdate[] = [];
  const workerUpdates: RuntimeUpdate[] = [];
  const startup = new AbortController();
  const options: RuntimeOptions = {
    signal: startup.signal,
    vendor, model: vendor === 'gpt' ? 'gpt-5.6-luna' : 'claude-sonnet-5', thinkingLevel: 'high',
    directory: process.cwd(), systemPrompt: '', env: { ...process.env }, mcpServer: null, permissionMode: 'auto',
    onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    onUpdate: update => { updates.push(update); },
  };
  const stopped = () => updates.flatMap(update => update.type === 'notice' && update.title === 'stop received'
    ? [update.description] : []);
  const terminal = (id: string) => updates.some(update =>
    update.type === 'async_task' && update.task.id === id && update.task.state === 'stopped');
  const controller = new AbortController();
  let runtime: Runtime | undefined;
  let turn: Promise<unknown> | undefined;
  try {
    runtime = await startAcpRuntime(options);
    expect(updates).toMatchObject([{ type: 'async_task', task: { id: 'early', state: 'running', canStop: true } }]);
    startup.abort(new Error('Startup already finished'));
    expect(runtime.lost).toBe(false);
    const worker = await runtime.fork({ ...options, onUpdate: update => { workerUpdates.push(update); } });
    expect(workerUpdates).toHaveLength(1);
    turn = runtime.prompt({ text: 'Start', images: [] }, controller.signal).catch(error => error);
    await until(() => updates.some(update => update.type === 'async_task' && update.task.id === 'running'), 'running shell');
    controller.abort(new Error('Stopped by Esc'));
    expect(await turn).toMatchObject({ message: 'Stopped by Esc' });
    await until(() => ['early', 'running', 'late'].every(terminal), 'known and late shell cancellation');
    expect(stopped().sort()).toEqual(['early', 'late', 'running']);
    expect(workerUpdates).toHaveLength(1);
    expect(workerUpdates[0]).toMatchObject({ type: 'async_task', task: { id: 'early', state: 'running' } });
    expect(updates.find(update => update.type === 'async_task' && update.task.id === 'late' && update.task.state === 'stopped'))
      .toMatchObject({ task: { name: 'sleep 20', toolCallId: 'tool-late', outputFilePath: '/tmp/late', canStop: false } });
    await runtime.prompt({ text: 'Next', images: [] }, new AbortController().signal);
    expect(stopped()).not.toContain('next');
    expect(updates).toContainEqual({ type: 'rate_limit', resetsAt: 2000000000 });
    expect(updates).toContainEqual({ type: 'context', usage: { tokens: 100, window: 200000 } });
    expect(await runtime.stopTask('next')).toBe(true);
    expect(stopped()).toContain('next');
    expect(await runtime.stopTask('next')).toBe(false);
    expect(await runtime.stopTask('missing')).toBe(false);
    worker.dispose();
  } finally {
    controller.abort();
    runtime?.dispose();
    await turn;
    spec.mockRestore();
  }
});

test('warming a draft again follows a changed preferred credential', async () => {
  const { providerFor } = await import('../../src/agent_runtime/providers');
  const model = 'gpt-5.6-luna';
  const credentials = spyOn(providerFor('gpt').sources, 'list').mockReturnValue([{ id: 'old', kind: 'subscription', profile: 'default' }]);
  const binding = bindScriptedRuntime(model, textTurn('Ready'));
  const session = new Session({ model });
  try {
    await session.warmup();
    credentials.mockReturnValue([{ id: 'new', kind: 'subscription', profile: 'default' }]);
    await session.warmup();
    expect(binding.starts).toHaveLength(2);
    expect(binding.runtimes[0].disposed).toBe(true);
    await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'hello' }] });
    expect(binding.starts).toHaveLength(2);
  } finally { await session.dispose(); credentials.mockRestore(); unbindRuntime(model); }
});

test('pending warmup adopts the latest permission mode and thinking level', async () => {
  const { boundRuntimes } = await import('../../src/agent_runtime/runtime/runtime');
  const binding = bindScriptedRuntime(testModel, textTurn('Ready'));
  const factory = boundRuntimes[testModel];
  let finish!: () => void;
  let started!: () => void;
  const opening = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  boundRuntimes[testModel] = async options => { started(); await gate; return factory(options); };
  const session = new Session({ model: testModel, permissionMode: 'bypass' });
  const warm = session.warmup();
  await opening;
  session.setPermissionMode('ask');
  session.setThinkingLevel('low');
  finish();
  await warm;
  expect(binding.runtimes[0].permissionMode).toBe('ask');
  expect(binding.runtimes[0].thinkingLevel).toBe('low');
  await session.dispose();
});

test('limit errors preserve structured reset times without copying debug credentials', async () => {
  const { turnFailure } = await import('../../src/agent_runtime/runtime/errors');
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const cause = Object.assign(new Error('Internal error'), { data: { details: 'rate_limit_exceeded', resetsAt } });
  const { rememberListedModels } = await import('../../src/agent_runtime/providers/catalog');
  const previousDirectory = process.env.SIRUS_DATA_DIR;
  process.env.SIRUS_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'sirus-limit-'));
  try {
    // Only a model the other vendor listed is offered, since that is all /model takes.
    expect(turnFailure(new Error('Rate limit exceeded'), 'gpt', 'sirus').message).toContain('To use Claude instead, sign in with /login.');
    rememberListedModels('claude', [{ id: 'sonnet', description: '' }]);
    const failure = turnFailure(new Error('Internal error', { cause }), 'gpt', 'reviewer');
    expect(failure.message).toContain(new Date(resetsAt * 1000).toLocaleString());
    expect(failure.message).toContain('To use Claude instead, type /model @reviewer sonnet.');
  } finally {
    rmSync(process.env.SIRUS_DATA_DIR!, { recursive: true, force: true });
    if (previousDirectory === undefined) delete process.env.SIRUS_DATA_DIR;
    else process.env.SIRUS_DATA_DIR = previousDirectory;
  }
  const debug = turnFailure(new Error('Rate limit exceeded. Resets at 18:30 UTC. Request Authorization: Bearer test-secret-key'), 'gpt', 'sirus');
  expect(debug.message).toContain('Resets at 18:30 UTC');
  expect(debug.message).not.toContain('test-secret-key');
});

test.each(['initialize', 'session/new'])('cancelling ACP startup terminates an adapter hung in %s', async phase => {
  const { existsSync, readFileSync } = await import('fs');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sirus-startup-cancel-'));
  const pidFile = path.join(directory, 'adapter.pid');
  const adapter = `
    import { createInterface } from 'node:readline';
    import { writeFileSync } from 'node:fs';
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      if (request.method === process.env.HANG_PHASE) {
        writeFileSync(process.env.PID_FILE, String(process.pid));
      } else if (request.method === 'initialize') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1 } }) + '\\n');
      }
    }
  `;
  const spec = spyOn(launch, 'launchFor').mockImplementation(options => ({
    command: process.execPath, args: ['-e', adapter], env: { ...options.env, HANG_PHASE: phase, PID_FILE: pidFile },
    mode: options.permissionMode, session: () => ({ mcpServers: [] }), forkNeedsResume: false,
  }));
  const controller = new AbortController();
  const opening = startAcpRuntime({
    vendor: 'gpt', model: 'gpt-5.6-luna', thinkingLevel: 'high', directory,
    systemPrompt: '', env: { ...process.env }, mcpServer: null, permissionMode: 'auto', signal: controller.signal,
    onPermission: async () => ({ outcome: { outcome: 'cancelled' } }), onUpdate: () => {},
  }).catch(error => error);
  let pid: number | undefined;
  try {
    await until(() => existsSync(pidFile), 'adapter startup request');
    pid = Number(readFileSync(pidFile, 'utf8'));
    controller.abort(new Error('Draft closed'));
    expect(await opening).toMatchObject({ message: 'Draft closed' });
    await until(() => {
      try { process.kill(pid!, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    }, 'adapter exit after startup cancellation');
  } finally {
    controller.abort();
    await opening;
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    spec.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each(['caller', 'shutdown'])('a bound runtime resolving after %s cancellation is disposed before it can be adopted', async cancellation => {
  const { boundRuntimes, createRuntime, disposeAllRuntimes } = await import('../../src/agent_runtime/runtime/runtime');
  const model = 'late-startup-runtime';
  const binding = bindScriptedRuntime(model, textTurn('Unused'));
  const start = boundRuntimes[model]!;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  boundRuntimes[model] = async options => { await gate; return start(options); };
  const controller = new AbortController();
  const opening = createRuntime({
    vendor: 'gpt', model, thinkingLevel: 'high', directory: process.cwd(), systemPrompt: '',
    env: { ...process.env }, mcpServer: null, permissionMode: 'auto', signal: controller.signal,
    onPermission: async () => ({ outcome: { outcome: 'cancelled' } }), onUpdate: () => {},
  }).catch(error => error);
  try {
    await new Promise(resolve => setImmediate(resolve));
    if (cancellation === 'caller') controller.abort(new Error('Draft replaced'));
    else disposeAllRuntimes();
    expect(await opening).toMatchObject({ message: cancellation === 'caller' ? 'Draft replaced' : 'Runtimes stopped' });
    release();
    await until(() => binding.runtimes.length === 1, 'late runtime');
    expect(binding.runtimes[0].disposed).toBe(true);
  } finally {
    release();
    await opening;
    unbindRuntime(model);
  }
});

describe('native participant sessions', () => {
  test('reopens a snapshot and a lost process without a text recap', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'sirus-native-participant-'));
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = directory;
    const binding = bindScriptedRuntime(testModel, textTurn('Learned'), true);
    const original = new Session({ model: testModel, directory });
    let restored: Session | undefined;
    try {
      await original.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Learn a hidden detail' }] });
      const snapshot = original.toSnapshot();
      const native = snapshot.participants[0].nativeSession!;
      expect(native).toMatchObject({ vendor: 'gpt', directory, sourceId: null, profileHome: directory });
      expect(native.sessionId).toBe(binding.runtimes[0].sessionId);
      await original.dispose();
      restored = Session.fromSnapshot(snapshot);
      // Switching away from a restored chat releases draft warmup resources,
      // but must retain the session that has not been reopened yet.
      restored.releaseWarmup();
      expect(restored.toSnapshot().participants[0].nativeSession).toEqual(native);
      await restored.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Recall it' }] });
      expect(binding.starts[1].resume).toEqual(native);
      expect(binding.runtimes[1].prompts).toEqual([{ text: 'Recall it', images: [] }]);
      binding.runtimes[1].dispose();
      await restored.sendMessage({ role: 'user', content: [{ type: 'text', text: 'After process loss' }] });
      expect(binding.starts[2].resume?.sessionId).toBe(native.sessionId);
      expect(binding.runtimes[2].prompts[0].text).toBe('After process loss');
    } finally {
      await restored?.dispose();
      await original.dispose();
      if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('cancelling a pending resume retains the native session for the next turn', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'sirus-native-cancel-'));
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = directory;
    const binding = bindScriptedRuntime(testModel, textTurn('Learned'), true);
    const original = new Session({ model: testModel, directory });
    const { boundRuntimes } = await import('../../src/agent_runtime/runtime/runtime');
    const factory = boundRuntimes[testModel];
    let restored: Session | undefined;
    let turn: Promise<unknown> | undefined;
    let started!: () => void;
    let release!: () => void;
    const opening = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      await original.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Learn a hidden detail' }] });
      const snapshot = original.toSnapshot();
      const native = snapshot.participants[0].nativeSession!;
      await original.dispose();
      boundRuntimes[testModel] = async options => {
        expect(options.resume).toEqual(native);
        started();
        await gate;
        return factory(options);
      };
      restored = Session.fromSnapshot(snapshot);
      turn = restored.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Cancelled before prompting' }] }).catch(error => error);
      await opening;
      restored.cancel();
      await turn;
      expect(restored.toSnapshot().participants[0].nativeSession).toEqual(native);
      release();
      await until(() => binding.runtimes[1]?.disposed === true, 'cancelled resume cleanup');
      expect(binding.runtimes[1].prompts).toEqual([]);
      boundRuntimes[testModel] = factory;
      await restored.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Recall it after cancellation' }] });
      expect(binding.starts[2].resume).toEqual(native);
      expect(binding.runtimes[2].prompts[0].text).toBe('Recall it after cancellation');
    } finally {
      release();
      restored?.cancel();
      await turn;
      await restored?.dispose();
      await original.dispose();
      boundRuntimes[testModel] = factory;
      if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test.each(['same', 'different'] as const)('credential fallback with a %s profile home preserves the appropriate native session', async profile => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'sirus-native-credentials-'));
    const previous = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, SIRUS_DATA_DIR: process.env.SIRUS_DATA_DIR };
    process.env.CLAUDE_CONFIG_DIR = directory;
    process.env.SIRUS_DATA_DIR = path.join(directory, 'data');
    const { providerFor } = await import('../../src/agent_runtime/providers');
    const model = 'claude-sonnet-5';
    const first = { id: 'first', kind: 'api' as const, key: 'test-first-key' };
    const backup = profile === 'same'
      ? { id: 'backup', kind: 'api' as const, key: 'test-backup-key' }
      : { id: 'backup', kind: 'subscription' as const, profile: 'backup-profile' };
    const credentials = spyOn(providerFor('claude').sources, 'list').mockReturnValue([first, backup]);
    let failFirst = false;
    const attempts: string[] = [];
    const binding = bindScriptedRuntime(model, (_input, emit, options) => {
      const source = options.env.ANTHROPIC_API_KEY === first.key ? 'first' : 'backup';
      attempts.push(source);
      if (failFirst && source === 'first') throw new Error('401 authentication rejected');
      emit({ type: 'text', text: 'Earlier answer' });
    }, true);
    const original = new Session({ model, directory });
    let restored: Session | undefined;
    try {
      await original.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Learn a hidden detail' }] });
      const native = original.toSnapshot().participants[0].nativeSession!;
      expect(native).toMatchObject({ sourceId: first.id, profileHome: directory });
      failFirst = true;
      await original.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Continue after credential failure' }] });
      expect(attempts).toEqual(['first', 'first', 'backup']);
      expect(binding.starts).toHaveLength(2);
      const replacement = original.toSnapshot().participants[0].nativeSession!;
      expect(replacement.sourceId).toBe(backup.id);
      if (profile === 'same') {
        expect(binding.starts[1].resume).toEqual(native);
        expect(replacement.sessionId).toBe(native.sessionId);
        expect(replacement.profileHome).toBe(native.profileHome);
        expect(binding.runtimes[1].prompts[0].text).not.toContain('Earlier conversation, for context:');
      } else {
        expect(binding.starts[1].resume).toBeUndefined();
        expect(replacement.sessionId).not.toBe(native.sessionId);
        expect(replacement.profileHome).toBe(path.join(directory, 'data', 'subscriptions', 'claude', 'backup-profile'));
        expect(binding.runtimes[1].prompts[0].text).toContain('Earlier answer');
        expect(original.getMessages().at(-1)?.content).toContainEqual(expect.objectContaining({
          type: 'notice', title: 'Starting fresh with a conversation recap',
          description: expect.stringContaining('different profile home'),
        }));
      }

      // The configured preference still puts the rejected credential first.
      // Restoring must use the saved backup directly, without failing again.
      const snapshot = original.toSnapshot();
      await original.dispose();
      restored = Session.fromSnapshot(snapshot);
      await restored.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Resume on the saved credential' }] });
      expect(attempts).toEqual(['first', 'first', 'backup', 'backup']);
      expect(binding.starts).toHaveLength(3);
      expect(binding.starts[2].resume).toEqual(replacement);
      expect(binding.runtimes[2].prompts[0].text).toBe('Resume on the saved credential');
      expect(restored.toSnapshot().participants[0].nativeSession!.sessionId).toBe(replacement.sessionId);
    } finally {
      await restored?.dispose();
      await original.dispose();
      credentials.mockRestore();
      unbindRuntime(model);
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test.each(['directory', 'profile', 'missing profile', 'credential', 'prompt', 'refused'] as const)('uses a recap if native recovery is invalid: %s', async invalid => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'sirus-native-fallback-'));
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = directory;
    const binding = bindScriptedRuntime(testModel, textTurn('Earlier answer'), true);
    const original = new Session({ model: testModel, directory });
    let restored: Session | undefined;
    const { boundRuntimes } = await import('../../src/agent_runtime/runtime/runtime');
    try {
      await original.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Earlier question' }] });
      const snapshot = original.toSnapshot();
      const native = snapshot.participants[0].nativeSession!;
      if (invalid === 'directory') native.directory = path.join(directory, 'missing');
      if (invalid === 'profile' || invalid === 'missing profile') native.profileHome = path.join(directory, 'missing-profile');
      if (invalid === 'missing profile') process.env.CODEX_HOME = native.profileHome;
      if (invalid === 'credential') native.sourceId = 'removed-credential';
      if (invalid === 'prompt') native.systemPromptHash = 'previous-prompt';
      let attempted = false;
      const factory = boundRuntimes[testModel];
      if (invalid === 'refused') boundRuntimes[testModel] = options => {
        if (options.resume) { attempted = true; throw new Error('Session not found'); }
        return factory(options);
      };
      restored = Session.fromSnapshot(snapshot);
      await restored.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Continue' }] });
      expect(binding.starts.at(-1)?.resume).toBeUndefined();
      expect(binding.runtimes.at(-1)?.prompts[0].text).toContain('Earlier conversation, for context:');
      expect(binding.runtimes.at(-1)?.prompts[0].text).toContain('Earlier answer');
      if (invalid === 'refused') expect(attempted).toBe(true);
      if (invalid === 'missing profile') expect(restored.getMessages().at(-1)?.content).toContainEqual(expect.objectContaining({
        type: 'notice', description: expect.stringContaining('saved profile home is missing'),
      }));
      if (invalid !== 'prompt') expect(restored.getMessages().at(-1)?.content).toContainEqual(expect.objectContaining({
        type: 'notice', title: 'Starting fresh with a conversation recap',
      }));
      expect(restored.toSnapshot().participants[0].nativeSession?.sessionId).not.toBe(native.sessionId);
    } finally {
      await restored?.dispose();
      await original.dispose();
      if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
