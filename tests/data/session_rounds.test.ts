import { afterEach, describe, expect, test } from 'bun:test';
import { boundTransports } from '../../src/agent_runtime/providers';
import { Session } from '../../src/agent_runtime/session';

const streamingModel = 'test-round-streaming-model';
const failingModel = 'test-round-failing-model';

afterEach(() => {
  delete boundTransports[streamingModel];
  delete boundTransports[failingModel];
});

describe('Session rounds', () => {
  // Streamed text and finished tool work stay in history after a failure, but
  // a participant that failed before producing anything leaves no empty bubble.
  test('discards the bubble of a participant that failed before streaming anything', async () => {
    boundTransports[streamingModel] = {
      getResponse: async (_messages, turn) => {
        turn.updateStream([{ type: 'text', text: 'partial answer' }]);
        return { content: [{ type: 'text', text: 'partial answer' }], stop_reason: 'end_turn' };
      },
    };
    boundTransports[failingModel] = {
      getResponse: async () => { throw new Error('provider failed before streaming'); },
    };

    const session = new Session({ id: 'rounds-session', name: 'Rounds', model: streamingModel });
    session.addParticipant('writer', streamingModel);
    session.addParticipant('breaker', failingModel);

    const turn = session.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: '@writer @breaker take a look' }],
    });
    await expect(turn).rejects.toThrow('provider failed before streaming');

    const messages = session.getMessages();
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant']);
    expect(messages[1]).toEqual({
      role: 'assistant',
      participant: 'writer',
      model: streamingModel,
      content: [{ type: 'text', text: 'partial answer' }],
    });
    expect(messages.some(message => message.participant === 'breaker')).toBe(false);
  });
});
