import { afterEach, describe, expect, test } from 'bun:test';
import { Session } from '../../src/agent_runtime/session';
import { bindScriptedRuntime, unbindRuntime } from '../support/runtime';

const streamingModel = 'test-round-streaming-model';
const failingModel = 'test-round-failing-model';

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
}

afterEach(() => {
  unbindRuntime(streamingModel);
  unbindRuntime(failingModel);
});

describe('Session rounds', () => {
  test('only the exact streaming reply is live, and peers finish independently', async () => {
    let releaseWriter!: () => void;
    let releasePeer!: () => void;
    const writerGate = new Promise<void>(resolve => { releaseWriter = resolve; });
    const peerGate = new Promise<void>(resolve => { releasePeer = resolve; });
    bindScriptedRuntime(streamingModel, async (_input, emit) => {
      emit({ type: 'thought', text: 'Current writer step' });
      await writerGate;
    });
    bindScriptedRuntime(failingModel, async (_input, emit) => {
      emit({ type: 'thought', text: 'Current peer step' });
      await peerGate;
    });
    const session = new Session({ name: 'Live replies', model: streamingModel });
    session.addParticipant('writer', streamingModel);
    session.addParticipant('peer', failingModel);
    session.append({ role: 'assistant', participant: 'writer', content: [{ type: 'thought', text: 'Old writer step' }] });
    const oldReply = session.getMessages()[0]!;
    const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: '@writer @peer inspect' }] });
    let observedFinishedWriter = false;
    const unsubscribe = session.subscribe(() => {
      const replies = session.getMessages().filter(message => message.role === 'assistant');
      if (replies.length === 3 && !session.isMessageLive(replies[1]!) && session.isMessageLive(replies[2]!)) {
        observedFinishedWriter = true;
      }
    });
    try {
      await waitFor(() => session.getMessages().filter(message => session.isMessageLive(message)).length === 2);
      expect(session.isMessageLive(oldReply)).toBe(false);
      releaseWriter();
      await waitFor(() => observedFinishedWriter);
      expect(session.getStatus()).toBe('working');
      releasePeer();
      await turn;
      expect(session.getMessages().some(message => session.isMessageLive(message))).toBe(false);
      const next = session.sendMessage({ role: 'user', content: [{ type: 'text', text: '@peer again' }] });
      expect(session.isMessageLive(oldReply)).toBe(false);
      await next;
    } finally {
      releaseWriter();
      releasePeer();
      await turn.catch(() => {});
      unsubscribe();
      await session.dispose();
    }
  });

  test.each(['cancel', 'fail'] as const)('clears the live reply when a turn ends with %s', async ending => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    bindScriptedRuntime(streamingModel, async (_input, emit) => {
      emit({ type: 'thought', text: 'Interrupted step' });
      await gate;
      if (ending === 'fail') throw new Error('failed after thinking');
    });
    const session = new Session({ name: 'Interrupted reply', model: streamingModel });
    const turn = session.sendMessage({ role: 'user', content: [{ type: 'text', text: 'inspect' }] });
    const result = turn.catch(error => error);
    try {
      await waitFor(() => session.getMessages().some(message => session.isMessageLive(message)));
      if (ending === 'cancel') session.cancel();
      else release();
      expect(await result).toBeInstanceOf(Error);
      expect(session.getMessages().some(message => session.isMessageLive(message))).toBe(false);
    } finally {
      release();
      await result;
      await session.dispose();
    }
  });

  // Streamed text and finished tool work stay in history after a failure, but
  // a participant that failed before producing anything leaves no empty entry.
  test('discards the entry of a participant that failed before streaming anything', async () => {
    bindScriptedRuntime(streamingModel, (_input, emit) => { emit({ type: 'text', text: 'partial answer' }); });
    bindScriptedRuntime(failingModel, () => { throw new Error('runtime failed before streaming'); });

    const session = new Session({ id: 'rounds-session', name: 'Rounds', model: streamingModel });
    session.addParticipant('writer', streamingModel);
    session.addParticipant('breaker', failingModel);

    const turn = session.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: '@writer @breaker take a look' }],
    });
    await expect(turn).rejects.toThrow('runtime failed before streaming');

    const messages = session.getMessages();
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant']);
    expect(messages[1]).toEqual({
      seq: 1,
      role: 'assistant',
      participant: 'writer',
      model: streamingModel,
      content: [{ type: 'text', text: 'partial answer' }],
    });
    expect(messages.some(message => message.participant === 'breaker')).toBe(false);
  });
});
