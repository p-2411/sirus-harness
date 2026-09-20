import { afterEach, describe, expect, test } from 'bun:test';
import { Session } from '../../src/agent_runtime/session';
import { bindScriptedRuntime, unbindRuntime } from '../support/runtime';

const streamingModel = 'test-round-streaming-model';
const failingModel = 'test-round-failing-model';

afterEach(() => {
  unbindRuntime(streamingModel);
  unbindRuntime(failingModel);
});

describe('Session rounds', () => {
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
