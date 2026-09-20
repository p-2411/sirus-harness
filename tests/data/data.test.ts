import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as naming from '../../src/agent_runtime/session/naming';
import type { RuntimeOptions } from '../../src/agent_runtime/runtime/runtime';
import type { Draft } from '../../src/agent_runtime/session';
import type { SubagentRun } from '../../src/agent_runtime/tools/subagents';
import { Session } from '../../src/agent_runtime/session';
import { bindScriptedRuntime, textTurn, unbindRuntime, type ScriptedTurn } from '../support/runtime';

const testModel = 'test-session-model';
const secondTestModel = 'test-second-session-model';
const thirdTestModel = 'test-third-session-model';

// A worker's runtime starts with the subagent contract; that is how a
// scripted turn shared by an owner and its workers tells them apart.
const isWorker = (options: RuntimeOptions) => options.systemPrompt.includes('You are a Sirus subagent');

afterEach(() => {
  unbindRuntime(testModel);
  unbindRuntime(secondTestModel);
  unbindRuntime(thirdTestModel);
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
    expect(options.systemPrompt).toContain('You are Sirus');
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

  test('records tool calls, thoughts and compaction as the runtime reports them', async () => {
    bindScriptedRuntime(testModel, (_input, emit) => {
      emit({ type: 'thought', text: 'Let me look.' });
      emit({ type: 'tool_call', call: { type: 'tool_call', id: 'call-1', title: 'cat file.txt', kind: 'execute', status: 'pending', locations: [], content: [] } });
      emit({ type: 'tool_call', call: { type: 'tool_call', id: 'call-1', title: 'cat file.txt', kind: 'execute', status: 'completed', locations: [], content: [{ type: 'text', text: 'hi' }], output: 'hi' } });
      emit({ type: 'compaction', status: 'in_progress' });
      emit({ type: 'compaction', status: 'completed', summary: 'Read the file.' });
      emit({ type: 'text', text: 'It says hi.' });
    });
    const session = new Session({ id: 'tools', name: 'Tools', model: testModel });
    await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'What does file.txt say?' }] });
    expect(session.getMessages().at(-1)?.content).toEqual([
      { type: 'thought', text: 'Let me look.' },
      { type: 'tool_call', id: 'call-1', title: 'cat file.txt', kind: 'execute', status: 'completed', locations: [], content: [{ type: 'text', text: 'hi' }], output: 'hi' },
      { type: 'compaction', summary: 'Read the file.' },
      { type: 'text', text: 'It says hi.' },
    ]);
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

  test('cancels its detached subagents after the parent turn has finished', async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const workers: SubagentRun[] = [];
    const sessions: Session[] = [];
    bindScriptedRuntime(testModel, async (_input, emit, options) => {
      if (isWorker(options)) await gate;
      else {
        const owner = sessions.find(candidate => candidate.getId() === options.mcpServer?.url && false) ?? sessions[workers.length];
        workers.push(owner.subagentHostFor('sirus')!.spawn('background task', { callId: `spawn-${workers.length}` }) as SubagentRun);
      }
      emit({ type: 'text', text: 'Done' });
    });
    const first = new Session({ id: 'detached-first', name: 'First', model: testModel });
    const second = new Session({ id: 'detached-second', name: 'Second', model: testModel });
    sessions.push(first, second);
    const message: Draft = { role: 'user', content: [{ type: 'text', text: 'start' }] };
    await first.sendMessage(message);
    await second.sendMessage(message);
    expect(first.getStatus()).toBe('idle');
    expect(workers.map(run => run.status)).toEqual(['working', 'working']);
    expect(first.getActiveSubagentCount()).toBe(1);
    expect(first.cancel()).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(workers.map(run => run.status)).toEqual(['cancelled', 'working']);
    finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(workers[1].status).toBe('done');
    expect(workers[1].finalMessage).toBe('Done');
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
    expect(binding.starts[0].systemPrompt).toContain('You are @Reviewer');
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

describe('session-owned subagent cancellation', () => {
  test('cancels its detached workers after the parent finishes without cancelling another session', async () => {
    const { listAllSubagents } = await import('../../src/agent_runtime/tools/subagents');
    const { checkSubagent } = await import('../../src/agent_runtime/tools/subagents/run');
    const workers = new Map<string, SubagentRun>();
    let finishWorkers!: () => void;
    const workerGate = new Promise<void>(resolve => { finishWorkers = resolve; });
    const sessions: Session[] = [];
    bindScriptedRuntime(secondTestModel, async (_input, emit) => {
      await workerGate;
      emit({ type: 'text', text: 'Worker done' });
    });
    bindScriptedRuntime(testModel, (_input, emit, options) => {
      const owner = sessions[workers.size];
      workers.set(owner.getId(), owner.subagentHostFor('sirus')!.spawn('Work', { callId: 'spawn' }) as SubagentRun);
      expect(options.mcpServer?.headers[1].value).toBe('sirus');
      emit({ type: 'text', text: 'Worker started' });
    });
    const first = new Session({ id: 'owned-first', name: 'First', model: testModel, subagentModel: secondTestModel });
    const second = new Session({ id: 'owned-second', name: 'Second', model: testModel, subagentModel: secondTestModel });
    sessions.push(first, second);
    const message: Draft = { role: 'user', content: [{ type: 'text', text: 'Start' }] };
    try {
      await first.sendMessage(message);
      await second.sendMessage(message);
      expect(first.getStatus()).toBe('idle');
      expect(workers.get(first.getId())?.model).toBe(secondTestModel);
      expect(workers.get(first.getId())?.sessionId).toBe('owned-first');
      expect(first.cancel()).toBe(true);
      await checkSubagent(workers.get(first.getId())!, true);
      expect(workers.get(first.getId())?.status).toBe('cancelled');
      expect(workers.get(second.getId())?.status).toBe('working');
      expect(listAllSubagents()).toContain(workers.get(second.getId())!);
    } finally {
      finishWorkers();
      first.cancel();
      second.cancel();
      await Promise.all([...workers.values()].map(worker => checkSubagent(worker, true)));
    }
  });
});
