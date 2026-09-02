import { afterEach, describe, expect, test } from 'bun:test';
import { getResponse, modelStrategies } from '../../src/agent/chat';
import type { Message } from '../../src/data/data';

const testModel = 'test-message-list-model';

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
      getResponse: async (providerMessages, model, context) => {
        receivedMessages = providerMessages;
        receivedModel = model;
        receivedDirectory = context.directory;
        return { content: [{ type: 'text', text: 'Hi' }], stop_reason: 'end_turn' };
      },
    };

    const response = await getResponse(messages, testModel);

    expect(receivedMessages).toEqual(messages);
    expect(receivedModel).toBe(testModel);
    expect(receivedDirectory).toBe(process.cwd());
    expect(response).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi' }],
    });
  });

  test('preserves tool call IDs and sends results into the next provider turn', async () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Read package.json' }] },
    ];
    let receivedMessages: readonly Message[] | undefined;
    let receivedToolResults: Parameters<NonNullable<import('../../src/agent/chat').Response['continueWithToolResults']>>[0] | undefined;

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

    const response = await getResponse(messages, testModel);

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

    const toolRound = (round: number): import('../../src/agent/chat').Response => ({
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

    const response = await getResponse(messages, testModel);

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

  test('publishes partial text before returning the completed response', async () => {
    const updates: Message[] = [];
    modelStrategies[testModel] = {
      getResponse: async (_messages, _model, context) => {
        context.onUpdate?.([{ type: 'text', text: 'Hel' }]);
        context.onUpdate?.([{ type: 'text', text: 'Hello' }]);
        return { content: [{ type: 'text', text: 'Hello' }], stop_reason: 'end_turn' };
      },
    };

    const response = await getResponse(
      [{ role: 'user', content: [{ type: 'text', text: 'Say hello' }] }],
      testModel,
      'default',
      process.cwd(),
      undefined,
      undefined,
      update => updates.push(update),
    );

    expect(updates.map(update => update.content)).toEqual([
      [{ type: 'text', text: 'Hel' }],
      [{ type: 'text', text: 'Hello' }],
      [{ type: 'text', text: 'Hello' }],
    ]);
    expect(response.content).toEqual([{ type: 'text', text: 'Hello' }]);
  });

  test('keeps streamed continuation text after tool calls and results', async () => {
    const updates: Message[] = [];
    modelStrategies[testModel] = {
      getResponse: async (_messages, _model, context) => {
        const toolCall = {
          type: 'tool_call' as const,
          id: 'call_stream',
          name: 'ReadFile',
          arguments: { path: 'package.json' },
        };
        context.onUpdate?.([{ type: 'text', text: 'Reading.' }, toolCall]);
        return {
          content: [{ type: 'text', text: 'Reading.' }, toolCall],
          stop_reason: 'tool_use',
          continueWithToolResults: async () => {
            context.onUpdate?.([{ type: 'text', text: 'The package is' }]);
            return {
              content: [{ type: 'text', text: 'The package is ready.' }],
              stop_reason: 'end_turn',
            };
          },
        };
      },
    };

    await getResponse(
      [{ role: 'user', content: [{ type: 'text', text: 'Inspect it' }] }],
      testModel,
      'default',
      process.cwd(),
      undefined,
      undefined,
      update => updates.push(update),
    );

    const continuation = updates.find(update => {
      const last = update.content.at(-1);
      return last?.type === 'text' && last.text === 'The package is';
    });
    expect(continuation?.content.map(block => block.type)).toEqual([
      'text',
      'tool_call',
      'tool_result',
      'text',
    ]);
  });

  test('publishes each result while a multi-tool run is still in progress', async () => {
    const updates: Message[] = [];
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

    await getResponse(
      [{ role: 'user', content: [{ type: 'text', text: 'Read both' }] }],
      testModel,
      'default',
      process.cwd(),
      undefined,
      undefined,
      update => updates.push(update),
    );

    expect(updates.some(update =>
      update.content.filter(block => block.type === 'tool_call').length === 2
      && update.content.filter(block => block.type === 'tool_result').length === 1,
    )).toBe(true);
  });
});
