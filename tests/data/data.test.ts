import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as naming from '../../src/agent_runtime/session/naming';
import * as router from '../../src/agent_runtime/router';
import type { RuntimeOptions } from '../../src/agent_runtime/runtime/runtime';
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

  test('asks Jev for a draft\'s model on its first prompt unless the user picked one', async () => {
    const binding = bindScriptedRuntime(testModel, textTurn('Done'));
    const alternative = bindScriptedRuntime(secondTestModel, textTurn('Done'));
    const route = spyOn(router, 'routeSessionModel').mockResolvedValue({ model: secondTestModel, confidence: 0.9 });
    try {
      const routed = new Session({ name: 'Routed', directory: process.cwd(), model: testModel, routePending: true });
      await routed.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Review the auth module carefully' }] });
      expect(route).toHaveBeenCalledTimes(1);
      expect(route.mock.calls[0]?.[0]).toEqual({ prompt: 'Review the auth module carefully', directory: process.cwd() });
      expect(routed.getModel()).toBe(secondTestModel);
      expect(alternative.starts).toHaveLength(1);
      expect(binding.starts).toHaveLength(0);
      // The pick was made: a later prompt does not ask again.
      await routed.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Again' }] });
      expect(route).toHaveBeenCalledTimes(1);

      // The user's own /model pick settles the draft's model instead.
      const pinned = new Session({ name: 'Pinned', model: secondTestModel, routePending: true });
      pinned.changeParticipantModel('sirus', testModel);
      await pinned.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Go' }] });
      expect(route).toHaveBeenCalledTimes(1);
      expect(pinned.getModel()).toBe(testModel);

      // No confident answer leaves the draft on the model it started with.
      route.mockResolvedValue(null);
      const unsure = new Session({ name: 'Unsure', model: testModel, routePending: true });
      await unsure.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Go' }] });
      expect(route).toHaveBeenCalledTimes(2);
      expect(unsure.getModel()).toBe(testModel);

      // A prompt the session rejects never reaches Jev.
      const rejected = new Session({ name: 'Rejected', model: testModel, routePending: true });
      await expect(rejected.sendMessage({ role: 'user', content: [{ type: 'text', text: '@nobody help' }] })).rejects.toThrow();
      expect(route).toHaveBeenCalledTimes(2);
    } finally {
      route.mockRestore();
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
        await sessions[spawns].subagentHostFor('sirus')!.spawn('background task', 'fresh', { callId: `spawn-${spawns++}` });
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
        await session.subagentHostFor('sirus')!.spawn('Rewrite the parser', 'fresh', { callId: 'spawn' });
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
      expect(prompts[1]).toStartWith(`@${worker.id} wrote:`);
      expect(prompts[1]).toContain(`Subagent ${worker.id} done`);
      expect(prompts[1]).toContain('I rewrote the parser.');

      const report = session.getMessages().find(entry => entry.participant === worker.id);
      expect(report).toMatchObject({ role: 'assistant', participant: worker.id, model: testModel, to: ['sirus'] });
      expect(textOf(report!)).toContain('Final message:');
      expect(session.getMessages().at(-1)).toMatchObject({ role: 'assistant', participant: 'sirus' });
    } finally {
      release();
      await session.dispose();
    }
  });

  test('a report waits behind a busy turn and goes out before the user’s queued prompts', async () => {
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
        await session.subagentHostFor('sirus')!.spawn('Background task', 'fresh', { callId: 'spawn' });
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
      await until(() => worker.status === 'done', 'the worker to finish');
      // The report cannot interrupt the turn in flight.
      expect(worker.reported).toBe(false);
      expect(session.getQueuedMessageCount()).toBe(1);

      releaseOwner();
      await busy;
      await until(() => prompts.length === 4 && session.getStatus() === 'idle', 'the report and the queued prompt');
      expect(prompts[2]).toContain(`@${worker.id} wrote:`);
      expect(prompts[3]).toBe('Queued prompt');
      expect(session.getQueuedMessageCount()).toBe(0);
    } finally {
      releaseOwner();
      releaseWorker();
      await session.dispose();
    }
  });

  test('messageWorker steers a running worker and refuses one that has ended', async () => {
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
        await session.subagentHostFor('sirus')!.spawn('Background task', 'fresh', { callId: 'spawn' });
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
      await expect(session.messageWorker(worker.id, 'Too late')).rejects.toThrow(`Subagent ${worker.id} is done`);
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
        await session.subagentHostFor('sirus')!.spawn('Background task', 'fresh', { callId: 'spawn' });
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
      const report = entries.findIndex(entry => entry.participant === worker.id);
      const question = entries.findIndex(entry => entry.role === 'user' && textOf(entry) === 'What happened?');
      // The report is in the record the fresh runtime is seeded with, ahead
      // of the prompt, rather than a turn of its own.
      expect(report).toBeGreaterThan(-1);
      expect(report).toBeLessThan(question);
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain('Sirus quit while it was working');
      expect(prompts[1]).toContain('What happened?');
    } finally {
      release();
      await (restored ?? session).dispose();
    }
  });

  test('Jev picks the worker’s model and level, and a routing failure keeps the owner’s', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started: { model: string; thinkingLevel: string }[] = [];
    let session!: Session;
    let spawns = 0;
    bindScriptedRuntime(testModel, async (_input, emit, options) => {
      if (isWorker(options)) {
        started.push({ model: options.model, thinkingLevel: options.thinkingLevel });
        await gate;
        return;
      }
      if (spawns < 2) {
        spawns++;
        await session.subagentHostFor('sirus')!.spawn('Background task', 'fresh', { callId: `spawn-${spawns}` });
      }
      emit({ type: 'text', text: 'Noted' });
    });
    bindScriptedRuntime(secondTestModel, async (_input, _emit, options) => {
      started.push({ model: options.model, thinkingLevel: options.thinkingLevel });
      await gate;
    });
    const route = spyOn(router, 'routeWorker')
      .mockResolvedValueOnce({ model: secondTestModel, thinkingLevel: 'low' })
      .mockRejectedValueOnce(new Error('Jev is unreachable'));
    session = new Session({ id: 'worker-routing', name: 'Routing', model: testModel });
    session.setThinkingLevel('xhigh');
    try {
      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Delegate it' }] });
      await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Delegate another' }] });
      const [first, second] = session.getWorkers();
      expect(route).toHaveBeenCalledTimes(2);
      expect(route.mock.calls[0][0]).toEqual({ task: 'Background task', directory: session.getDirectory() });
      expect(route.mock.calls[0][3]).toMatchObject({ fallbackLevel: 'xhigh' });
      expect(first).toMatchObject({ model: secondTestModel, thinkingLevel: 'low' });
      // A throw is not an answer: the worker stays on its owner's model.
      expect(second).toMatchObject({ model: testModel, thinkingLevel: 'xhigh' });
      await until(() => started.length === 2, 'both workers to start');
      expect(started).toEqual([
        { model: secondTestModel, thinkingLevel: 'low' },
        { model: testModel, thinkingLevel: 'xhigh' },
      ]);
    } finally {
      release();
      route.mockRestore();
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
        await session.subagentHostFor('sirus')!.spawn('Carry on from here', 'owner', { callId: 'spawn' });
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
      await session.subagentHostFor('sirus')!.spawn('Carry on from here', 'owner', { callId: 'spawn' });
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
        await sessions[spawns++].subagentHostFor('sirus')!.spawn('Work', 'fresh', { callId: 'spawn' });
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
      // The session's fixed subagent model wins over anything Jev would say.
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
