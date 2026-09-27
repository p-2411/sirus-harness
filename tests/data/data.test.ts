import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import * as naming from '../../src/agent_runtime/session/naming';
import * as launch from '../../src/agent_runtime/runtime/launch';
import { startAcpRuntime } from '../../src/agent_runtime/runtime/acp';
import { pendingQuestions, questionFields, requestAnswers, resolveQuestion } from '../../src/agent_runtime/permissions/questions';
import type { Runtime, RuntimeOptions, RuntimeUpdate } from '../../src/agent_runtime/runtime/runtime';
import type { Draft } from '../../src/agent_runtime/session';
import { Session } from '../../src/agent_runtime/session';
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
    expect(updates).toEqual([{ type: 'notice', severity: 'info', title: 'owner opening' }]);
    const worker = await runtime.fork({ ...options, onUpdate: update => { workerUpdates.push(update); } });
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
    expect(session.getThinkingLevel()).toBe('high');
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
    // The default participant has not reported: the last responder's shows.
    expect(session.getContextUsage()).toEqual({ tokens: 50, window: 400_000 });
    expect(session.getContextUsage('reviewer')).toEqual({ tokens: 50, window: 400_000 });
    expect(session.getContextUsage('sirus')).toBeNull();

    await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Now you' }] });
    expect(session.getContextUsage()).toEqual({ tokens: 300, window: 200_000 });
    // Nothing of it survives a restore: the gauge waits for the runtime.
    expect(Session.fromSnapshot(session.toSnapshot()).getContextUsage()).toBeNull();
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
      },
    ]);
    expect(session.getMessages()).toEqual(messages);
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
    expect(session.getMessages().at(-1)).toEqual({
      seq: 1,
      role: 'assistant',
      participant: 'sirus',
      model: testModel,
      content: [{ type: 'text', text: 'Working' }],
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
      { type: 'thought', text: 'Let me look.' },
      { type: 'tool_call', id: 'call-1', title: 'cat file.txt', kind: 'execute', status: 'completed', locations: [], content: [{ type: 'text', text: 'hi' }], output: 'hi' },
      { type: 'compaction', summary: 'Read the file.' },
      { type: 'text', text: 'Read it.' },
      { type: 'notice', severity: 'warning', title: 'Model fallback', description: 'Using the available model.' },
      { type: 'text', text: 'It says hi.' },
    ]);
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
    const started: { model: string; thinkingLevel: string }[] = [];
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
    });
    session = new Session({ id: 'worker-fork', name: 'Fork', model: testModel });
    try {
      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Delegate it' }] });
      const [worker] = session.getWorkers();
      expect(worker.context).toBe('owner');
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
    expect(session.getMessages()).toEqual([
      { seq: 0, role: 'user', to: ['sirus'], content: [{ type: 'text', text: 'Start' }] },
      {
        seq: 1,
        role: 'assistant',
        participant: 'sirus',
        model: testModel,
        content: [{ type: 'text', text: 'Partial' }],
      },
    ]);
    expect(session.cancel()).toBe(false);
    release();
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
    expect(session.getMessages()[0]).toEqual({
      seq: 0,
      role: 'user',
      to: ['Reviewer'],
      content: [{ type: 'text', text: '@Reviewer inspect this' }],
    });
    expect(session.getMessages().filter(message => message.role === 'assistant'))
      .toEqual([
        { seq: 1, role: 'assistant', participant: 'Reviewer', model: testModel, content: [{ type: 'text', text: 'reviewed' }] },
        { seq: 3, role: 'assistant', participant: 'Reviewer', model: testModel, content: [{ type: 'text', text: 'reviewed' }] },
      ]);
  });

  test('runs unique mentions in parallel and commits responses in mention order', async () => {
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
      content: [{ type: 'text', text: '@first @second @FIRST compare' }],
    });
    expect(session.getMessages().slice(1).map(message => [message.participant, message.content[0]]))
      .toEqual([
        ['first', { type: 'text', text: 'first response' }],
        ['second', { type: 'text', text: 'second response' }],
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

  test('rejects an unknown mention without a model before changing the session', async () => {
    const session = new Session();
    await expect(session.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'Could @reviewer inspect this?' }],
    })).rejects.toThrow(/requires a model/i);
    expect(session.getParticipants()).toEqual([{ name: 'sirus', model: 'gpt-5.6-luna' }]);
    expect(session.getMessages()).toEqual([]);
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
        // Agent output cannot use the user-only creation syntax.
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
      .toEqual([testModel, secondTestModel, testModel, thirdTestModel]);
    expect(calls[0].text).toBe('Start the review');
    // A mentioned participant gets the sender's whole message, attributed.
    expect(calls[1].text).toBe('@sirus wrote:\n@reviewer please review this.');
    expect(calls[2].text).toBe('@reviewer wrote:\n@sirus has the context. @verifier please verify.');
    expect(calls[3].text).toBe('@reviewer wrote:\n@sirus has the context. @verifier please verify.');
    const responses = session.getMessages().filter(message => message.role === 'assistant');
    expect(responses.map(message => message.participant)).toEqual(['sirus', 'reviewer', 'sirus', 'verifier']);
    // Delivery is recorded on the entry, so a restore puts it back where it went.
    expect(responses[0].to).toEqual(['reviewer']);
    expect(responses[1].to).toEqual(['sirus', 'verifier']);
    expect(responses[2].to).toBeUndefined();
    expect(session.getParticipants().map(participant => participant.name))
      .toEqual(['sirus', 'reviewer', 'verifier']);
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

  test('runs several participants mentioned by an agent in parallel', async () => {
    let releaseReviewer!: () => void;
    let releaseVerifier!: () => void;
    const reviewerGate = new Promise<void>(resolve => { releaseReviewer = resolve; });
    const verifierGate = new Promise<void>(resolve => { releaseVerifier = resolve; });
    const started: string[] = [];
    bindScriptedRuntime(testModel, textTurn('@reviewer @verifier compare this.'));
    bindScriptedRuntime(secondTestModel, async (_input, emit) => {
      started.push('reviewer');
      await reviewerGate;
      emit({ type: 'text', text: 'reviewed' });
    });
    bindScriptedRuntime(thirdTestModel, async (_input, emit) => {
      started.push('verifier');
      await verifierGate;
      emit({ type: 'text', text: 'verified' });
    });
    const session = new Session({ id: 'team-id', name: 'Team', model: testModel });
    session.addParticipant('reviewer', secondTestModel);
    session.addParticipant('verifier', thirdTestModel);

    const turn = session.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'Delegate this' }],
    });
    while (started.length < 2) await new Promise(resolve => setTimeout(resolve, 0));
    releaseVerifier();
    releaseReviewer();
    expect(started).toEqual(['reviewer', 'verifier']);
    await turn;

    expect(session.getMessages().filter(message => message.role === 'assistant')
      .map(message => message.participant)).toEqual(['sirus', 'reviewer', 'verifier']);
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
    await expect(failedTurn).rejects.toThrow('runtime failed');
    expect(session.getStatus()).toBe('error');
    expect(session.getMessages().at(-1)).toEqual({
      seq: 3,
      role: 'assistant',
      participant: 'sirus',
      model: testModel,
      content: [{ type: 'text', text: 'Partial before failure' }],
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
    expect(notifications.some(text => text.includes('Final message:\nFIRST_RESULT'))).toBe(true);
    expect(notifications.some(text => text.includes('Final message:\nSECOND_RESULT'))).toBe(true);
    expect(steered[0]).toContain('FIRST_RESULT');
    expect(steered[1]).toContain('SECOND_RESULT');
    const call = session.getMessages().flatMap(entry => entry.content).find(block => block.type === 'tool_call');
    expect(call).toMatchObject({ output: expect.stringContaining('Final message:\nSECOND_RESULT') });
    expect(session.getWorkers()[0].reported).toBe(true);
  } finally {
    for (const acknowledge of acknowledgements) acknowledge();
    releaseOwner();
    await ownerTurn;
    await session.dispose();
  }
});
