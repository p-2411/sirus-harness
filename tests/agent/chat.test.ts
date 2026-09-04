import { afterEach, describe, expect, test } from 'bun:test';
import { getResponse, modelStrategies } from '../../src/agent_runtime/chat';
import type { Response } from '../../src/agent_runtime/chat';
import { SessionAgent } from '../../src/agent_runtime/agent';
import { TurnContext, type TurnOptions } from '../../src/agent_runtime/turn';
import type { Message, MessageBlock } from '../../src/agent_runtime/types';

const testModel = 'test-message-list-model';

function testTurn(options: Partial<TurnOptions> = {}): TurnContext {
  return new TurnContext(
    new SessionAgent({ name: 'sirus', model: testModel, runtimeId: 'default' }),
    { directory: process.cwd(), ...options },
  );
}

afterEach(() => {
  delete modelStrategies[testModel];
});

describe('getResponse', () => {
  test('passes model messages to the selected provider', async () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    ];
    let receivedMessages: readonly Message[] | undefined;
    let receivedModel: string | undefined;
    let receivedDirectory: string | undefined;

    modelStrategies[testModel] = {
      getResponse: async (providerMessages, turn) => {
        receivedMessages = providerMessages;
        receivedModel = turn.agent.model;
        receivedDirectory = turn.directory;
        return { content: [{ type: 'text', text: 'Hi' }], stop_reason: 'end_turn' };
      },
    };

    const turn = testTurn();
    const response = await getResponse(messages, turn);

    expect(receivedMessages).toEqual(messages);
    expect(receivedModel).toBe(testModel);
    expect(receivedDirectory).toBe(process.cwd());
    expect(response).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi' }],
    });
    expect(await turn.result).toEqual(response);
    expect(turn.done).toBe(true);
  });

  test('preserves tool call IDs and sends results into the next provider turn', async () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Read package.json' }] },
    ];
    let receivedMessages: readonly Message[] | undefined;
    let receivedToolResults: Parameters<NonNullable<Response['continueWithToolResults']>>[0] | undefined;

    modelStrategies[testModel] = {
      getResponse: async providerMessages => {
        receivedMessages = providerMessages;
        return {
          content: [
            { type: 'text', text: 'I will read it.' },
            {
              type: 'tool_call',
              id: 'call_123',
              name: 'ReadFile',
              arguments: { path: 'package.json' },
            },
          ],
          stop_reason: 'tool_use',
          continueWithToolResults: async toolResults => {
            receivedToolResults = toolResults;
            return { content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' };
          },
        };
      },
    };

    const response = await getResponse(messages, testTurn());

    expect(receivedMessages).toEqual(messages);
    expect(receivedToolResults?.[0]).toMatchObject({
      type: 'tool_result',
      callId: 'call_123',
      isError: false,
    });
    expect(receivedToolResults?.[0].result).toContain('"name": "sirus-harness"');
    expect(response.content).toEqual([
      { type: 'text', text: 'I will read it.' },
      {
        type: 'tool_call',
        id: 'call_123',
        name: 'ReadFile',
        arguments: { path: 'package.json' },
      },
      expect.objectContaining({ type: 'tool_result', callId: 'call_123' }),
      { type: 'text', text: 'Done.' },
    ]);
  });

  test('keeps text from successive tool rounds in order', async () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Read it twice' }] },
    ];
    let continuationCount = 0;

    const toolRound = (round: number): Response => ({
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: `Before tool ${round}.` },
        {
          type: 'tool_call',
          id: `call_${round}`,
          name: 'ReadFile',
          arguments: { path: 'package.json' },
        },
      ],
      continueWithToolResults: async () => {
        continuationCount++;
        if (round === 1) return toolRound(2);
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'After both tools.' }],
        };
      },
    });

    modelStrategies[testModel] = {
      getResponse: async () => toolRound(1),
    };

    const response = await getResponse(messages, testTurn());

    expect(response.content.map(block => block.type === 'text' ? block.text : block.type)).toEqual([
      'Before tool 1.',
      'tool_call',
      'tool_result',
      'Before tool 2.',
      'tool_call',
      'tool_result',
      'After both tools.',
    ]);
    expect(continuationCount).toBe(2);
  });

  test('exposes streamed text on the turn before the provider finishes', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    modelStrategies[testModel] = {
      getResponse: async (_messages, turn) => {
        turn.updateStream([{ type: 'text', text: 'Hel' }]);
        await gate;
        turn.updateStream([{ type: 'text', text: 'Hello' }]);
        return { content: [{ type: 'text', text: 'Hello' }], stop_reason: 'end_turn' };
      },
    };

    const turn = testTurn();
    const result = getResponse([{ role: 'user', content: [{ type: 'text', text: 'Say hello' }] }], turn);
    const snapshots: MessageBlock[][] = [];
    for await (const snapshot of turn.changes()) {
      snapshots.push(snapshot.content);
      if (snapshots.length === 1) {
        expect(turn.content).toEqual([{ type: 'text', text: 'Hel' }]);
        expect(turn.done).toBe(false);
        release();
      }
    }

    expect(snapshots[0]).toEqual([{ type: 'text', text: 'Hel' }]);
    expect(snapshots.at(-1)).toEqual([{ type: 'text', text: 'Hello' }]);
    expect((await result).content).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(turn.done).toBe(true);
  });

  test('keeps streamed continuation text after tool calls and results', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    modelStrategies[testModel] = {
      getResponse: async (_messages, turn) => {
        const toolCall = {
          type: 'tool_call' as const,
          id: 'call_stream',
          name: 'ReadFile',
          arguments: { path: 'package.json' },
        };
        turn.updateStream([{ type: 'text', text: 'Reading.' }, toolCall]);
        return {
          content: [{ type: 'text', text: 'Reading.' }, toolCall],
          stop_reason: 'tool_use',
          continueWithToolResults: async () => {
            turn.updateStream([{ type: 'text', text: 'The package is' }]);
            await gate;
            return {
              content: [{ type: 'text', text: 'The package is ready.' }],
              stop_reason: 'end_turn',
            };
          },
        };
      },
    };

    const turn = testTurn();
    const result = getResponse([{ role: 'user', content: [{ type: 'text', text: 'Inspect it' }] }], turn);
    let continuation: Message | undefined;
    for await (const snapshot of turn.changes()) {
      const last = snapshot.content.at(-1);
      if (last?.type === 'text' && last.text === 'The package is') {
        continuation = snapshot;
        release();
      }
    }
    await result;

    expect(continuation?.content.map(block => block.type)).toEqual([
      'text',
      'tool_call',
      'tool_result',
      'text',
    ]);
  });

  test('commits each result while a multi-tool run is still in progress', async () => {
    modelStrategies[testModel] = {
      getResponse: async () => ({
        content: [
          { type: 'tool_call', id: 'call_one', name: 'ReadFile', arguments: { path: 'package.json' } },
          { type: 'tool_call', id: 'call_two', name: 'ReadFile', arguments: { path: 'tsconfig.base.json' } },
        ],
        stop_reason: 'tool_use',
        continueWithToolResults: async () => ({
          content: [{ type: 'text', text: 'Done.' }],
          stop_reason: 'end_turn',
        }),
      }),
    };

    const turn = testTurn();
    const result = getResponse([{ role: 'user', content: [{ type: 'text', text: 'Read both' }] }], turn);
    const snapshots: Message[] = [];
    for await (const snapshot of turn.changes()) snapshots.push(snapshot);
    await result;

    expect(snapshots.some(snapshot =>
      snapshot.content.filter(block => block.type === 'tool_call').length === 2
      && snapshot.content.filter(block => block.type === 'tool_result').length === 1,
    )).toBe(true);
  });

  test('settles the turn with the provider error and ends the change stream', async () => {
    modelStrategies[testModel] = {
      getResponse: async () => {
        throw new Error('provider down');
      },
    };

    const turn = testTurn();
    const result = getResponse([{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }], turn);
    const snapshots: Message[] = [];
    for await (const snapshot of turn.changes()) snapshots.push(snapshot);

    await expect(result).rejects.toThrow('provider down');
    await expect(turn.result).rejects.toThrow('provider down');
    expect(snapshots).toEqual([]);
    expect(turn.done).toBe(true);
  });
});
