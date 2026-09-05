import { afterEach, describe, expect, test } from 'bun:test';
import { modelStrategies } from '../../src/agent_runtime/chat';
import type { TurnContext } from '../../src/agent_runtime/turn';
import type { Message } from '../../src/agent_runtime/types';
import type { SubagentRun } from '../../src/agent_runtime/tools/subagents';
import { Session } from '../../src/agent_runtime/session';

const testModel = 'test-session-model';
const secondTestModel = 'test-second-session-model';
const thirdTestModel = 'test-third-session-model';

afterEach(() => {
  delete modelStrategies[testModel];
  delete modelStrategies[secondTestModel];
  delete modelStrategies[thirdTestModel];
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
    expect(Session.create('Owned', '/projects/owned').getDirectory()).toBe('/projects/owned');
  });

  test('auto-names a default session from its first prompt but preserves a custom name', async () => {
    modelStrategies[testModel] = {
      getResponse: async () => ({
        content: [{ type: 'text', text: 'Done' }],
        stop_reason: 'end_turn',
      }),
    };
    const automatic = Session.create('Session 3', process.cwd(), testModel);
    await automatic.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: '\n  Implement the queued message workflow with tests  \nDo not use this line' }],
    });
    expect(automatic.getName()).toBe('Implement the queued message workflow…');

    const custom = new Session('Session 9', 'custom-name', testModel);
    await custom.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'This must not replace the name' }],
    });
    expect(custom.getName()).toBe('Session 9');

    const explicitlyNamed = Session.create('Session 10', process.cwd(), testModel);
    explicitlyNamed.setName('Session 10');
    const restored = Session.fromSnapshot(explicitlyNamed.toSnapshot());
    await restored.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'Keep the explicit numeric name' }],
    });
    expect(restored.getName()).toBe('Session 10');
  });

  test('reports latest context usage and aggregates session token totals', () => {
    const session = new Session('Usage', 'usage', testModel, [
      {
        role: 'assistant',
        model: 'claude-sonnet-5',
        content: [{ type: 'text', text: 'First' }],
        usage: { inputTokens: 100, outputTokens: 20, contextTokens: 120, contextWindow: 200_000 },
      },
      {
        role: 'assistant',
        model: 'gpt-5.6-sol',
        content: [{ type: 'text', text: 'Second' }],
        usage: { inputTokens: 250, outputTokens: 50, contextTokens: 300, contextWindow: 400_000 },
      },
    ]);
    expect(session.getContextUsage()).toEqual({ tokens: 300, window: 400_000 });
    expect(session.getTotalUsage()).toEqual({ inputTokens: 350, outputTokens: 70 });
  });

  test('setModel changes the model for that session only', () => {
    const a = new Session('A');
    const b = new Session('B');
    a.setModel('claude-fable-5-1');
    expect(a.getModel()).toBe('claude-fable-5-1');
    expect(b.getModel()).toBe('gpt-5.6-luna');
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
    const original = new Session('Saved session', 'session-123', 'claude-fable-5-1', [], '/projects/sirus');
    original.append({ role: 'user', content: [{ type: 'text', text: 'remember me' }] });

    const restored = Session.fromSnapshot(original.toSnapshot());

    expect(restored.getId()).toBe('session-123');
    expect(restored.getName()).toBe('Saved session');
    expect(restored.getDirectory()).toBe('/projects/sirus');
    expect(restored.getModel()).toBe('claude-fable-5-1');
    expect(restored.getMessages()).toEqual(original.getMessages());
  });

  test('sends a message through the agent runtime and returns the updated history', async () => {
    const session = new Session('Test', 'session-id', testModel, [], '/projects/test');
    session.setThinkingLevel('medium');
    let receivedMessages: Message[] | undefined;
    let receivedTurn: TurnContext | undefined;

    modelStrategies[testModel] = {
      getResponse: async (messages, turn) => {
        receivedMessages = [...messages];
        receivedTurn = turn;
        return {
          content: [{ type: 'text', text: 'Hello back' }],
          stop_reason: 'end_turn',
        };
      },
    };

    const messages = await session.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'Hello' }],
    });

    expect(receivedMessages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    ]);
    expect(receivedTurn?.agent.model).toBe(testModel);
    expect(receivedTurn?.agent.name).toBe('sirus');
    expect(receivedTurn?.agent.runtimeId).toBe('session-id');
    expect(receivedTurn?.directory).toBe('/projects/test');
    expect(receivedTurn?.agent.thinkingLevel).toBe('medium');
    expect(receivedTurn?.permissions).toEqual({
      sessionId: 'session-id',
      mode: expect.any(Function),
      requester: { participant: 'sirus' },
      model: testModel,
      beforeMutation: expect.any(Function),
    });
    expect(receivedTurn?.signal).toBeInstanceOf(AbortSignal);
    expect(receivedTurn?.turnPrompt).toBeUndefined();
    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      {
        role: 'assistant',
        participant: 'sirus',
        model: testModel,
        content: [{ type: 'text', text: 'Hello back' }],
      },
    ]);
    expect(session.getMessages()).toBe(messages);
  });

  test('makes a streaming assistant response visible before the provider finishes', async () => {
    const session = new Session('Test', 'stream-session', testModel);
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });

    modelStrategies[testModel] = {
      getResponse: async (_messages, turn) => {
        turn.updateStream([{ type: 'text', text: 'Working' }]);
        await gate;
        return {
          content: [{ type: 'text', text: 'Working now.' }],
          stop_reason: 'end_turn',
          usage: { inputTokens: 120, outputTokens: 8, contextTokens: 128, contextWindow: 400_000 },
        };
      },
    };

    const turn = session.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'Start' }],
    });
    // The transcript pulls snapshots from the turn; let that pull run.
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(session.getAssistantVersion()).toBeGreaterThan(0);
    expect(session.getMessages().at(-1)).toEqual({
      role: 'assistant',
      participant: 'sirus',
      model: testModel,
      content: [{ type: 'text', text: 'Working' }],
    });

    finish();
    await turn;
    expect(session.getMessages().at(-1)).toMatchObject({
      content: [{ type: 'text', text: 'Working now.' }],
      usage: { inputTokens: 120, outputTokens: 8, contextTokens: 128, contextWindow: 400_000 },
    });
    expect(session.getContextUsage()).toEqual({ tokens: 128, window: 400_000 });
  });

  test('keeps queued messages on the session in FIFO order', () => {
    const session = new Session('Queue');
    session.queueMessage('first');
    session.queueMessage('second');

    expect(session.getQueuedMessageCount()).toBe(2);
    expect(session.shiftQueuedMessage()).toBe('first');
    expect(session.getQueuedMessageCount()).toBe(1);
    session.clearQueuedMessages();
    expect(session.getQueuedMessageCount()).toBe(0);
    expect(Session.fromSnapshot(session.toSnapshot()).getQueuedMessageCount()).toBe(0);
  });

  test('drains queued prompts in order without a mounted chat', async () => {
    const pending: Array<() => void> = [];
    const prompts: string[] = [];
    modelStrategies[testModel] = {
      getResponse: async messages => {
        const block = messages.at(-1)!.content[0];
        if (block.type === 'text') prompts.push(block.text);
        await new Promise<void>(resolve => pending.push(resolve));
        return { content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn' };
      },
    };
    const session = new Session('Queue', 'background-queue', testModel);
    const first = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'first' }] });
    session.queueMessage('second');
    session.queueMessage('third');
    pending.shift()!();
    await first;
    expect(prompts).toEqual(['first', 'second']);
    expect(session.getStatus()).toBe('working');
    expect(session.getQueuedMessageCount()).toBe(1);
    pending.shift()!();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(prompts).toEqual(['first', 'second', 'third']);
    expect(session.getQueuedMessageCount()).toBe(0);
    pending.shift()!();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(session.getStatus()).toBe('idle');
  });

  test('pauses the background queue at commands that may need user input', async () => {
    let finish!: () => void;
    modelStrategies[testModel] = {
      getResponse: async () => {
        await new Promise<void>(resolve => { finish = resolve; });
        return { content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn' };
      },
    };
    const session = new Session('Queue', 'command-queue', testModel);
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
    modelStrategies[testModel] = {
      getResponse: async () => {
        await gate;
        return { content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn' };
      },
    };
    const first = new Session('First', 'cancel-first', testModel);
    const second = new Session('Second', 'cancel-second', testModel);
    const message: Message = { role: 'user', content: [{ type: 'text', text: 'start' }] };
    const firstTurn = first.sendMessage(message);
    const secondTurn = second.sendMessage(message);
    first.queueMessage('after cancel');
    second.queueMessage('keep');
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
    modelStrategies[testModel] = {
      getResponse: async (_messages, turn) => {
        if (turn.agent.subagent) await gate;
        else workers.push(turn.agent.spawnSubagent('background task', testModel, {
          directory: process.cwd(),
          signal: turn.signal,
        }));
        return { content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn' };
      },
    };
    const first = new Session('First', 'detached-first', testModel);
    const second = new Session('Second', 'detached-second', testModel);
    const message: Message = { role: 'user', content: [{ type: 'text', text: 'start' }] };
    await first.sendMessage(message);
    await second.sendMessage(message);
    expect(first.getStatus()).toBe('idle');
    expect(workers.map(run => run.status)).toEqual(['working', 'working']);
    expect(first.cancel()).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(workers.map(run => run.status)).toEqual(['cancelled', 'working']);
    finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(workers[1].status).toBe('done');
  });

  test('tracks the active turn start independently of the chat view', async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    modelStrategies[testModel] = {
      getResponse: async () => {
        await gate;
        return { content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn' };
      },
    };
    const session = new Session('Elapsed', 'elapsed-session', testModel);

    const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Start' }] });
    expect(session.getActiveTurnStartedAt()).toBeNumber();
    finish();
    await turn;
    expect(session.getActiveTurnStartedAt()).toBeNull();
  });

  test('cancels the whole active turn even when a provider ignores its signal', async () => {
    const session = new Session('Test', 'cancel-session', testModel);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let providerSignal: AbortSignal | undefined;
    modelStrategies[testModel] = {
      getResponse: async (_messages, turn) => {
        providerSignal = turn.signal;
        turn.updateStream([{ type: 'text', text: 'Partial' }]);
        await gate;
        return { content: [{ type: 'text', text: 'Too late' }], stop_reason: 'end_turn' };
      },
    };

    const turn = session.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'Start' }],
    });
    await Promise.resolve();

    expect(session.cancel()).toBe(true);
    await expect(turn).rejects.toMatchObject({ name: 'AbortError' });
    expect(providerSignal?.aborted).toBe(true);
    expect(session.getStatus()).toBe('idle');
    expect(session.getMessages()).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Start' }] },
      {
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
    const calls: Array<{ model: string; turn: TurnContext; messages: Message[] }> = [];
    modelStrategies[testModel] = {
      getResponse: async (messages, turn) => {
        calls.push({ model: turn.agent.model, turn, messages: [...messages] });
        return { content: [{ type: 'text', text: 'reviewed' }], stop_reason: 'end_turn' };
      },
    };
    const session = new Session('Test', 'session-id', secondTestModel);

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
    expect(calls).toHaveLength(2);
    expect(calls[0].model).toBe(testModel);
    expect(calls[0].turn.agent).toMatchObject({
      name: 'Reviewer',
      runtimeId: 'session-id/participants/reviewer',
    });
    expect(calls[0].turn.directory).toBe(process.cwd());
    expect(calls[0].messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: '@Reviewer inspect this' }],
    });
    expect(session.getMessages()[0]).toEqual(calls[0].messages[0]);
    expect(calls[1].messages.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: '@reviewer check it again' }],
    });
    expect(session.getMessages().filter(message => message.role === 'assistant'))
      .toEqual([
        {
          role: 'assistant',
          participant: 'Reviewer',
          model: testModel,
          content: [{ type: 'text', text: 'reviewed' }],
        },
        {
          role: 'assistant',
          participant: 'Reviewer',
          model: testModel,
          content: [{ type: 'text', text: 'reviewed' }],
        },
      ]);
  });

  test('runs unique mentions in parallel and commits responses in mention order', async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
    const started: string[] = [];
    modelStrategies[testModel] = {
      getResponse: async () => {
        started.push('first');
        await firstGate;
        return { content: [{ type: 'text', text: 'first response' }], stop_reason: 'end_turn' };
      },
    };
    modelStrategies[secondTestModel] = {
      getResponse: async () => {
        started.push('second');
        await secondGate;
        return { content: [{ type: 'text', text: 'second response' }], stop_reason: 'end_turn' };
      },
    };
    const session = new Session();
    const turn = session.sendMessage({
      role: 'user',
      content: [{
        type: 'text',
        text: '@first test-session-model @second test-second-session-model @FIRST compare',
      }],
    });

    await Promise.resolve();
    expect(started).toEqual(['first', 'second']);
    releaseSecond();
    await Promise.resolve();
    expect(session.getMessages()).toHaveLength(1);
    releaseFirst();
    await turn;

    expect(session.getMessages()[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: '@first @second @FIRST compare' }],
    });
    expect(session.getMessages().slice(1).map(message => [message.participant, message.content[0]]))
      .toEqual([
        ['first', { type: 'text', text: 'first response' }],
        ['second', { type: 'text', text: 'second response' }],
      ]);
  });

  test('does not strip a model name following an existing participant mention', async () => {
    let receivedText: string | undefined;
    modelStrategies[testModel] = {
      getResponse: async messages => {
        receivedText = messages.at(-1)?.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('\n');
        return { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' };
      },
    };
    const session = new Session();
    session.addParticipant('Claude', testModel);

    await session.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: '@Claude claude-opus-5 is still relevant here' }],
    });

    expect(receivedText).toBe('@Claude claude-opus-5 is still relevant here');
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
    let calls = 0;
    modelStrategies[testModel] = {
      getResponse: async () => {
        calls++;
        return { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' };
      },
    };
    const session = new Session('Test', 'session-id', testModel);

    await session.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'Upgrade @scope/package for me' }],
    });

    expect(calls).toBe(1);
    expect(session.getParticipants()).toEqual([{ name: 'sirus', model: testModel }]);
  });

  test('does not invoke or create participants from mentions inside Markdown blocks', async () => {
    const calls: string[] = [];
    modelStrategies[testModel] = {
      getResponse: async () => {
        calls.push('sirus');
        return { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' };
      },
    };
    modelStrategies[secondTestModel] = {
      getResponse: async () => {
        calls.push('reviewer');
        return { content: [{ type: 'text', text: 'reviewed' }], stop_reason: 'end_turn' };
      },
    };
    const session = new Session('Team', 'team-id', testModel);
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
    expect(session.getMessages()[0]).toEqual({ role: 'user', content: [{ type: 'text', text }] });
  });

  test('runs only top-level mentions when blocked examples appear in the same message', async () => {
    const calls: string[] = [];
    modelStrategies[testModel] = {
      getResponse: async () => {
        calls.push('reviewer');
        return { content: [{ type: 'text', text: 'reviewed' }], stop_reason: 'end_turn' };
      },
    };
    modelStrategies[secondTestModel] = {
      getResponse: async () => {
        calls.push('verifier');
        return { content: [{ type: 'text', text: 'verified' }], stop_reason: 'end_turn' };
      },
    };
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
    modelStrategies[testModel] = {
      getResponse: async () => ({
        content: [{ type: 'text', text: '> @reviewer this is a quoted example' }],
        stop_reason: 'end_turn',
      }),
    };
    modelStrategies[secondTestModel] = {
      getResponse: async () => {
        reviewerCalls++;
        return { content: [{ type: 'text', text: 'reviewed' }], stop_reason: 'end_turn' };
      },
    };
    const session = new Session('Team', 'team-id', testModel);
    session.addParticipant('reviewer', secondTestModel);

    await session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Start' }] });

    expect(reviewerCalls).toBe(0);
    expect(session.getMessages()).toHaveLength(2);
  });

  test('lets agents mention existing participants across multiple delegation rounds', async () => {
    const calls: Array<{ model: string; turn: TurnContext; messages: Message[] }> = [];
    let sirusCalls = 0;
    modelStrategies[testModel] = {
      getResponse: async (messages, turn) => {
        calls.push({ model: turn.agent.model, turn, messages: [...messages] });
        sirusCalls++;
        return {
          content: [{
            type: 'text',
            text: sirusCalls === 1 ? '@reviewer please review this.' : 'Thanks, review complete.',
          }],
          stop_reason: 'end_turn',
        };
      },
    };
    modelStrategies[secondTestModel] = {
      getResponse: async (messages, turn) => {
        calls.push({ model: turn.agent.model, turn, messages: [...messages] });
        return {
          // Sirus can be invoked again for a genuine back-and-forth while the
          // verifier runs alongside it in the same next round.
          content: [{ type: 'text', text: '@sirus has the context. @verifier please verify.' }],
          stop_reason: 'end_turn',
        };
      },
    };
    modelStrategies[thirdTestModel] = {
      getResponse: async (messages, turn) => {
        calls.push({ model: turn.agent.model, turn, messages: [...messages] });
        return {
          // Agent output cannot use the user-only creation syntax.
          content: [{ type: 'text', text: 'Verified. @new-agent test-session-model join us.' }],
          stop_reason: 'end_turn',
        };
      },
    };
    const session = new Session('Team', 'team-id', testModel);
    session.addParticipant('reviewer', secondTestModel);
    session.addParticipant('verifier', thirdTestModel);

    await session.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'Start the review' }],
    });

    expect(calls.map(call => call.model))
      .toEqual([testModel, secondTestModel, testModel, thirdTestModel]);
    expect(calls[1].turn.turnPrompt).toContain('@sirus mentioned you');
    expect(calls[2].turn.turnPrompt).toContain('@reviewer mentioned you');
    expect(calls[3].turn.turnPrompt).toContain('@reviewer mentioned you');
    expect(calls[1].messages.at(-1)?.participant).toBe('sirus');
    expect(calls[2].messages.at(-1)?.participant).toBe('reviewer');
    expect(calls[3].messages.at(-1)?.participant).toBe('reviewer');
    expect(session.getMessages().filter(message => message.role === 'assistant')
      .map(message => message.participant)).toEqual(['sirus', 'reviewer', 'sirus', 'verifier']);
    expect(session.getParticipants().map(participant => participant.name))
      .toEqual(['sirus', 'reviewer', 'verifier']);
  });

  test('ignores an agent mentioning itself', async () => {
    let calls = 0;
    modelStrategies[testModel] = {
      getResponse: async () => {
        calls++;
        return {
          content: [{ type: 'text', text: '@sirus I should not invoke myself.' }],
          stop_reason: 'end_turn',
        };
      },
    };
    const session = new Session('Team', 'team-id', testModel);

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
    modelStrategies[testModel] = {
      getResponse: async () => ({
        content: [{ type: 'text', text: '@reviewer @verifier compare this.' }],
        stop_reason: 'end_turn',
      }),
    };
    modelStrategies[secondTestModel] = {
      getResponse: async () => {
        started.push('reviewer');
        await reviewerGate;
        return { content: [{ type: 'text', text: 'reviewed' }], stop_reason: 'end_turn' };
      },
    };
    modelStrategies[thirdTestModel] = {
      getResponse: async () => {
        started.push('verifier');
        await verifierGate;
        return { content: [{ type: 'text', text: 'verified' }], stop_reason: 'end_turn' };
      },
    };
    const session = new Session('Team', 'team-id', testModel);
    session.addParticipant('reviewer', secondTestModel);
    session.addParticipant('verifier', thirdTestModel);

    const turn = session.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'Delegate this' }],
    });
    for (let tick = 0; tick < 20 && started.length < 2; tick++) await Promise.resolve();
    releaseVerifier();
    releaseReviewer();
    expect(started).toEqual(['reviewer', 'verifier']);
    await turn;

    expect(session.getMessages().filter(message => message.role === 'assistant')
      .map(message => message.participant)).toEqual(['sirus', 'reviewer', 'verifier']);
  });

  test('persists all participants and their model choices in snapshots', () => {
    modelStrategies[testModel] = {
      getResponse: async () => ({ content: [], stop_reason: 'end_turn' }),
    };
    const session = new Session('Team');
    session.addParticipant('reviewer', testModel);

    const restored = Session.fromSnapshot(session.toSnapshot());

    expect(restored.getParticipants()).toEqual([
      { name: 'sirus', model: 'gpt-5.6-luna' },
      { name: 'reviewer', model: testModel },
    ]);
  });
});

describe('Session subscriptions', () => {
  test('tracks working, idle, and error turn states', async () => {
    let finish!: () => void;
    let shouldFail = false;
    modelStrategies[testModel] = {
      getResponse: async (_messages, turn) => {
        await new Promise<void>(resolve => { finish = resolve; });
        if (shouldFail) {
          turn.updateStream([{ type: 'text', text: 'Partial before failure' }]);
          throw new Error('provider failed');
        }
        return { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' };
      },
    };
    const session = new Session('Status', 'status-id', testModel);

    expect(session.getStatus()).toBe('idle');
    const successfulTurn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Start' }] });
    expect(session.getStatus()).toBe('working');
    await Promise.resolve();
    finish();
    await successfulTurn;
    expect(session.getStatus()).toBe('idle');

    shouldFail = true;
    const failedTurn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Again' }] });
    expect(session.getStatus()).toBe('working');
    await Promise.resolve();
    finish();
    await expect(failedTurn).rejects.toThrow('provider failed');
    expect(session.getStatus()).toBe('error');
    expect(session.getMessages().at(-1)).toEqual({
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
    session.setModel('claude-fable-5-1');
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
    session.setModel('claude-fable-5-1');
    session.append({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
    expect(calls).toBe(0);
  });

  test('version increments on each mutation (stable snapshot for useSyncExternalStore)', () => {
    const session = new Session();
    const before = session.getVersion();
    session.append({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
    session.setModel('claude-fable-5-1');
    expect(session.getVersion()).toBe(before + 2);
  });
});

describe('session-owned subagent cancellation', () => {
  test('cancels its detached workers after the parent finishes without cancelling another session', async () => {
    const { listAllSubagents, checkSubagent } = await import('../../src/agent_runtime/tools/subagents');
    const workers = new Map<string, import('../../src/agent_runtime/tools/subagents').SubagentRun>();
    let finishWorkers!: () => void;
    const workerGate = new Promise<void>(resolve => { finishWorkers = resolve; });
    modelStrategies[secondTestModel] = {
      getResponse: async () => {
        await workerGate;
        return { content: [{ type: 'text', text: 'Worker done' }], stop_reason: 'end_turn' };
      },
    };
    modelStrategies[testModel] = {
      getResponse: async (_messages, turn) => {
        workers.set(turn.agent.runtimeId, turn.agent.spawnSubagent('Work', secondTestModel, {
          directory: turn.directory,
          permissions: turn.permissions,
        }));
        return { content: [{ type: 'text', text: 'Worker started' }], stop_reason: 'end_turn' };
      },
    };
    const first = new Session('First', 'owned-first', testModel);
    const second = new Session('Second', 'owned-second', testModel);
    const message: Message = { role: 'user', content: [{ type: 'text', text: 'Start' }] };
    try {
      await first.sendMessage(message);
      await second.sendMessage(message);
      expect(first.getStatus()).toBe('idle');
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
