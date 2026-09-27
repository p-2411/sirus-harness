import { expect, test } from 'bun:test';
import { renderToString } from 'ink';
import stripAnsi from 'strip-ansi';
import { ChatHistory } from '../../src/frontend/chat/ChatMessage';
import { historyParts } from '../../src/frontend/chat/history';
import { textOf, type Message } from '../../src/agent_runtime/types';

test('steering stays between streamed text fragments and later tool output', () => {
  const reply: Message = { seq: 1, role: 'assistant', content: [{ type: 'text', text: 'Before. ' }] };
  const first: Message = { seq: 2, role: 'user', content: [{ type: 'text', text: 'Change direction.' }], injectedAt: { seq: 1, block: 0, offset: 8 } };
  const second: Message = { seq: 3, role: 'user', content: [{ type: 'text', text: 'Also test it.' }], injectedAt: { seq: 1, block: 0, offset: 15 } };
  const messages = [reply, first, second];
  reply.content[0] = { type: 'text', text: 'Before. Middle. After.' };
  reply.content.push({ type: 'tool_call', id: 'test', title: 'bun test', kind: 'execute', status: 'completed', locations: [], content: [] });
  const parts = historyParts(messages);
  expect(parts.map(part => textOf(part.message))).toEqual(['Before. ', 'Change direction.', 'Middle.', 'Also test it.', ' After.']);
  expect(parts.filter(part => part.message.role === 'assistant').map(part => part.final)).toEqual([false, false, true]);
  expect(parts.at(-1)!.message.content[1]).toBe(reply.content[1]);
  expect(new Set(parts.map(part => part.key)).size).toBe(parts.length);
  expect(textOf(reply)).toBe('Before. Middle. After.');
});

test('an injection at the end stays ahead of new blocks, with a live continuation', () => {
  const reply: Message = { seq: 1, role: 'assistant', content: [{ type: 'text', text: 'Original response' }] };
  const user: Message = { seq: 2, role: 'user', content: [{ type: 'text', text: 'Steered instruction' }], injectedAt: { seq: 1, block: 1, offset: 0 } };
  expect(historyParts([reply, user]).map(part => part.message.role)).toEqual(['assistant', 'user']);
  reply.content.push({ type: 'thought', text: 'Considering the new instruction' });
  const output = stripAnsi(renderToString(<ChatHistory messages={[reply, user]} participants={[]}
    isMessageLive={message => message === reply} sessionId="history-test" participantColors={new Map()} />, { columns: 120 }));
  expect(output).toContain('Considering the new instruction');
  expect(output.indexOf('Original response')).toBeLessThan(output.indexOf('Steered instruction'));
  expect(output.indexOf('Steered instruction')).toBeLessThan(output.indexOf('Considering the new instruction'));
});

test('same-position injections keep delivery order, while orphaned anchors stay in place', () => {
  const reply: Message = { seq: 1, role: 'assistant', content: [{ type: 'text', text: 'BeforeAfter' }] };
  const user = (seq: number, anchor = 1): Message => ({ seq, role: 'user', content: [{ type: 'text', text: `Follow-up ${seq}` }], injectedAt: { seq: anchor, block: 0, offset: 6 } });
  expect(historyParts([reply, user(2), user(3), user(4, 999)]).map(part => textOf(part.message)))
    .toEqual(['Before', 'Follow-up 2', 'Follow-up 3', 'After', 'Follow-up 4']);
});
