import { describe, expect, test } from 'bun:test';
import { render, renderToString } from 'ink';
import { PassThrough } from 'node:stream';
import { pressAt, releaseAt } from '../../src/frontend/interaction/clickable';
import stripAnsi from 'strip-ansi';
import {
  ChatMessage,
  messageSegments,
  ToolRunGroup,
} from '../../src/frontend/chat/ChatMessage';
import type { MessageBlock, ToolCallBlock, ToolResultBlock } from '../../src/agent_runtime/types';

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

  test('aligns user messages right and assistant messages left', () => {
    const userOutput = stripAnsi(renderToString(
      <ChatMessage message={{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }} />,
      { columns: 40 },
    ));
    const assistantOutput = stripAnsi(renderToString(
      <ChatMessage message={{ role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }} />,
      { columns: 40 },
    ));
    const userLines = userOutput.split('\n');
    const assistantLines = assistantOutput.split('\n');

    expect(userLines[0].indexOf('you')).toBeGreaterThan(assistantLines[0].indexOf('sirus'));
    expect(userLines[1].indexOf('Hello')).toBeGreaterThan(assistantLines[1].indexOf('Hello'));
    expect(assistantLines[0]).toStartWith('   sirus');
    expect(assistantLines[1]).toStartWith('   Hello');
  });

  test('renders the subject of a tool call in full and nothing else', () => {
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

    expect(output).toContain('● SearchMemories abcdefghijk');
    expect(output).not.toContain('limit');
  });

  test('shows the lines a file change adds and removes', () => {
    const output = stripAnsi(renderToString(
      <ChatMessage message={{
        role: 'assistant',
        content: [{
          type: 'tool_call',
          id: 'call-1',
          name: 'EditFile',
          arguments: { path: 'src/app.ts', old_text: 'a\nb', new_text: 'a\nb\nc\nd' },
        }, { type: 'tool_result', callId: 'call-1', result: '{}', isError: false }],
      }} />,
      { columns: 120 },
    ));

    expect(output).toContain('● EditFile src/app.ts +4 −2');
    expect(output).toContain('- a');
    expect(output).toContain('- b');
    expect(output).toContain('+ c');
    expect(output).toContain('+ d');
  });

  test('shows completed file diffs inside grouped tool activity', () => {
    const edit: ToolCallBlock = {
      type: 'tool_call',
      id: 'edit-1',
      name: 'WriteFile',
      arguments: { path: 'src/new.ts', content: 'first\nsecond' },
    };
    const output = stripAnsi(renderToString(
      <ToolRunGroup blocks={[
        calls[0],
        edit,
        results[0],
        { type: 'tool_result', callId: 'edit-1', result: '{}', isError: false },
      ]} />,
      { columns: 120 },
    ));

    expect(output).toContain('● WriteFile src/new.ts +2');
    expect(output).toContain('+ first');
    expect(output).toContain('+ second');
  });

  test('reveals a file diff when a running group completes and respects manual collapse', async () => {
    const edit: ToolCallBlock = {
      type: 'tool_call', id: 'live-edit', name: 'WriteFile',
      arguments: { path: 'new.ts', content: 'new content' },
    };
    const pending = [calls[0], edit, results[0]];
    const completed = [...pending, {
      type: 'tool_result' as const, callId: edit.id, result: '{}', isError: false,
    }];
    const stdout = Object.assign(new PassThrough(), { columns: 120 }) as unknown as NodeJS.WriteStream;
    const frames: string[] = [];
    stdout.on('data', data => frames.push(stripAnsi(data.toString())));
    const app = render(<ToolRunGroup blocks={pending} />, {
      stdout, debug: true, patchConsole: false, exitOnCtrlC: false,
    });
    try {
      await app.waitUntilRenderFlush();
      expect(frames.at(-1)).not.toContain('+ new content');
      app.rerender(<ToolRunGroup blocks={completed} />);
      await app.waitUntilRenderFlush();
      expect(frames.at(-1)).toContain('+ new content');

      await new Promise<void>(resolve => setImmediate(resolve));
      const summary = { col: 3, line: 1 };
      expect(pressAt(summary)).toBe(true);
      expect(releaseAt(summary)).toBe(true);
      await new Promise<void>(resolve => setImmediate(resolve));
      await app.waitUntilRenderFlush();
      expect(frames.at(-1)).not.toContain('+ new content');
      app.rerender(<ToolRunGroup blocks={[...completed]} />);
      await app.waitUntilRenderFlush();
      expect(frames.at(-1)).not.toContain('+ new content');
    } finally {
      app.unmount();
      await app.waitUntilExit();
    }
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
    expect(lines[2]).toContain('● ReadFile one.ts');
    expect(lines[3]).toContain('● RunShell bun test');
    expect(lines[4]).toBe('');
    expect(lines[2].indexOf('●')).toBeGreaterThan(lines[1].indexOf('⌄'));
  });
});
