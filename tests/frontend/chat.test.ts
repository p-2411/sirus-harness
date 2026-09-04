import { describe, expect, test } from 'bun:test';
import type { Message } from '../../src/agent_runtime/types';
import { formatElapsed, promptHistory, turnPhase } from '../../src/frontend/chat/Chat';

describe('chat input history', () => {
  test('collects user prompts in order and removes immediate duplicates', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
    ];
    expect(promptHistory(messages)).toEqual(['first', 'second']);
  });
});

describe('turn status', () => {
  test('distinguishes thinking, tool activity, and writing', () => {
    expect(turnPhase([])).toBe('thinking');
    expect(turnPhase([{
      role: 'assistant',
      content: [{ type: 'tool_call', id: 'call-1', name: 'RunShell', arguments: { command: 'bun test' } }],
    }])).toBe('running RunShell');
    expect(turnPhase([{
      role: 'assistant',
      content: [
        { type: 'tool_call', id: 'call-1', name: 'RunShell', arguments: { command: 'bun test' } },
        { type: 'tool_result', callId: 'call-1', result: 'ok', isError: false },
        { type: 'text', text: 'All done' },
      ],
    }])).toBe('writing');
  });

  test('formats elapsed seconds and minutes', () => {
    expect(formatElapsed(999)).toBe('0s');
    expect(formatElapsed(12_400)).toBe('12s');
    expect(formatElapsed(125_000)).toBe('2m 5s');
  });
});
