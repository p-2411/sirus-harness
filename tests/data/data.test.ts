import { afterEach, describe, expect, test } from 'bun:test';
import { modelStrategies, type ModelContext } from '../../src/agent/chat';
import type { Message } from '../../src/data/data';
import { Session } from '../../src/runtime/session';

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
  });

  test('is owned by the directory where it was created', () => {
    expect(new Session().getDirectory()).toBe(process.cwd());
    expect(Session.create('Owned', '/projects/owned').getDirectory()).toBe('/projects/owned');
  });

  test('setModel changes the model for that session only', () => {
    const a = new Session('A');
    const b = new Session('B');
    a.setModel('claude-fable-5');
    expect(a.getModel()).toBe('claude-fable-5');
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
    const original = new Session('Saved session', 'session-123', 'claude-fable-5', [], '/projects/sirus');
    original.append({ role: 'user', content: [{ type: 'text', text: 'remember me' }] });

    const restored = Session.fromSnapshot(original.toSnapshot());

    expect(restored.getId()).toBe('session-123');
    expect(restored.getName()).toBe('Saved session');
    expect(restored.getDirectory()).toBe('/projects/sirus');
    expect(restored.getModel()).toBe('claude-fable-5');
    expect(restored.getMessages()).toEqual(original.getMessages());
  });

  test('sends a message through the agent runtime and returns the updated history', async () => {
    const session = new Session('Test', 'session-id', testModel, [], '/projects/test');
    let receivedMessages: Message[] | undefined;
    let receivedContext: (ModelContext & { model: string }) | undefined;

    modelStrategies[testModel] = {
      getResponse: async (messages, model, context) => {
        receivedMessages = [...messages];
        receivedContext = { model, ...context };
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
    expect(receivedContext).toEqual({
      model: testModel,
      sessionId: 'session-id',
      directory: '/projects/test',
      onUpdate: expect.any(Function),
      signal: expect.any(AbortSignal),
      permissions: {
        sessionId: 'session-id',
        mode: expect.any(Function),
        requester: { participant: 'sirus' },
        model: testModel,
      },
    });
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
      getResponse: async (_messages, _model, context) => {
        context.onUpdate?.([{ type: 'text', text: 'Working' }]);
        await gate;
        return { content: [{ type: 'text', text: 'Working now.' }], stop_reason: 'end_turn' };
      },
    };

    const turn = session.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'Start' }],
    });
    await Promise.resolve();

    expect(session.getAssistantVersion()).toBeGreaterThan(0);
    expect(session.getMessages().at(-1)).toEqual({
      role: 'assistant',
      participant: 'sirus',
      model: testModel,
      content: [{ type: 'text', text: 'Working' }],
    });

    finish();
    await turn;
    expect(session.getMessages().at(-1)?.content).toEqual([
      { type: 'text', text: 'Working now.' },
    ]);
  });

  test('cancels the whole active turn even when a provider ignores its signal', async () => {
    const session = new Session('Test', 'cancel-session', testModel);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let providerSignal: AbortSignal | undefined;
    modelStrategies[testModel] = {
      getResponse: async (_messages, _model, context) => {
        providerSignal = context.signal;
        context.onUpdate?.([{ type: 'text', text: 'Partial' }]);
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
    ]);
    expect(session.cancel()).toBe(false);
    release();
  });

  test('creates a named participant from a mention and targets it thereafter', async () => {
    const calls: Array<{ model: string; context: ModelContext; messages: Message[] }> = [];
    modelStrategies[testModel] = {
      getResponse: async (messages, model, context) => {
        calls.push({ model, context, messages: [...messages] });
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
    expect(calls[0]).toMatchObject({
      model: testModel,
      context: {
        sessionId: 'session-id/participants/reviewer',
        directory: process.cwd(),
        participantName: 'Reviewer',
      },
    });
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
    const calls: Array<{ model: string; context: ModelContext; messages: Message[] }> = [];
    let sirusCalls = 0;
    modelStrategies[testModel] = {
      getResponse: async (messages, model, context) => {
        calls.push({ model, context, messages: [...messages] });
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
      getResponse: async (messages, model, context) => {
        calls.push({ model, context, messages: [...messages] });
        return {
          // Sirus can be invoked again for a genuine back-and-forth while the
          // verifier runs alongside it in the same next round.
          content: [{ type: 'text', text: '@sirus has the context. @verifier please verify.' }],
          stop_reason: 'end_turn',
        };
      },
    };
    modelStrategies[thirdTestModel] = {
      getResponse: async (messages, model, context) => {
        calls.push({ model, context, messages: [...messages] });
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
    expect(calls[1].context.turnPrompt).toContain('@sirus mentioned you');
    expect(calls[2].context.turnPrompt).toContain('@reviewer mentioned you');
    expect(calls[3].context.turnPrompt).toContain('@reviewer mentioned you');
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
      getResponse: async () => {
        await new Promise<void>(resolve => { finish = resolve; });
        if (shouldFail) throw new Error('provider failed');
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
  });

  test('notifies subscribers when the model changes', () => {
    const session = new Session();
    let calls = 0;
    session.subscribe(() => calls++);
    session.setModel('claude-fable-5');
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
    session.setModel('claude-fable-5');
    session.append({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
    expect(calls).toBe(0);
  });

  test('version increments on each mutation (stable snapshot for useSyncExternalStore)', () => {
    const session = new Session();
    const before = session.getVersion();
    session.append({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
    session.setModel('claude-fable-5');
    expect(session.getVersion()).toBe(before + 2);
  });
});
