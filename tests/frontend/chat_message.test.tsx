import { describe, expect, test } from 'bun:test';
import { renderToString } from 'ink';
import stripAnsi from 'strip-ansi';
import {
  ChatMessage,
  messageSegments,
  ToolRunGroup,
} from '../../src/frontend/chat/ChatMessage';
import type { MessageBlock, ToolCallBlock, ToolResultBlock } from '../../src/data/data';

const calls: ToolCallBlock[] = [
  { type: 'tool_call', id: 'call-1', name: 'ReadFile', arguments: { path: 'one.ts' } },
  { type: 'tool_call', id: 'call-2', name: 'RunShell', arguments: { command: 'bun test' } },
];

const results: ToolResultBlock[] = [
  { type: 'tool_result', callId: 'call-1', result: 'one', isError: false },
  { type: 'tool_result', callId: 'call-2', result: 'passed', isError: false },
];

describe('chat message', () => {
  test('renders the participant that produced an assistant message', () => {
    const output = stripAnsi(renderToString(
      <ChatMessage message={{
        role: 'assistant',
        participant: 'reviewer',
        content: [{ type: 'text', text: 'Looks good.' }],
      }} />,
      { columns: 120 },
    ));

    expect(output).toContain('reviewer');
    expect(output).not.toContain('@reviewer');
  });

  test('renders the producing model next to an assistant participant', () => {
    const output = stripAnsi(renderToString(
      <ChatMessage
        message={{
          role: 'assistant',
          participant: 'codex',
          content: [{ type: 'text', text: 'Done.' }],
        }}
        model="gpt-5.6-sol"
      />,
      { columns: 120 },
    ));

    expect(output).toContain('codex gpt-5.6-sol');
    expect(output).not.toContain('@codex');
  });

  test('does not render a model next to user messages', () => {
    const output = stripAnsi(renderToString(
      <ChatMessage
        message={{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }}
        model="gpt-5.6-sol"
      />,
      { columns: 120 },
    ));

    expect(output).toContain('you');
    expect(output).not.toContain('gpt-5.6-sol');
  });

  test('renders only the first tool-call argument with long values truncated to ten characters', () => {
    const output = stripAnsi(renderToString(
      <ChatMessage message={{
        role: 'assistant',
        content: [{
          type: 'tool_call',
          id: 'call-1',
          name: 'SearchMemories',
          arguments: { query: 'abcdefghijk', limit: 5 },
        }],
      }} />,
      { columns: 120 },
    ));

    expect(output).toContain('● SearchMemories { query : abcdefghij...');
    expect(output).not.toContain('limit');
  });

  test('collapses consecutive tool activity only when it contains multiple calls', () => {
    const content: MessageBlock[] = [
      { type: 'text', text: 'First' },
      calls[0],
      results[0],
      calls[1],
      results[1],
      { type: 'text', text: 'Second' },
      { ...calls[0], id: 'call-3' },
    ];

    const segments = messageSegments(content);

    expect(segments.map(segment => segment.type)).toEqual([
      'text',
      'tool_run',
      'text',
      'tool_call',
    ]);
  });

  test('summarizes completed and running tool groups while collapsed', () => {
    const completed = stripAnsi(renderToString(
      <ToolRunGroup blocks={[...calls, ...results]} />,
      { columns: 120 },
    ));
    const running = stripAnsi(renderToString(
      <ToolRunGroup blocks={[...calls, results[0]]} />,
      { columns: 120 },
    ));

    expect(completed).toContain('Ran 2 commands');
    expect(completed).not.toContain('ReadFile');
    expect(running).toContain('Running 2 commands.');
    expect(running).not.toContain('RunShell');
  });

  test('expands a tool group into compact indented one-line calls', () => {
    const output = stripAnsi(renderToString(
      <ToolRunGroup blocks={[...calls, ...results]} defaultExpanded />,
      { columns: 120 },
    ));
    const lines = output.split('\n');

    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('');
    expect(lines[1]).toContain('Ran 2 commands');
    expect(lines[2]).toContain('● ReadFile { path : one.ts');
    expect(lines[3]).toContain('● RunShell { command : bun test');
    expect(lines[4]).toBe('');
    expect(lines[2].indexOf('●')).toBeGreaterThan(lines[1].indexOf('⌄'));
  });
});
