import { describe, expect, test } from 'bun:test';
import { renderToString } from 'ink';
import stripAnsi from 'strip-ansi';
import { Session } from '../../src/agent_runtime/session';
import { ChatHeader } from '../../src/frontend/chat/Chat';

describe('chat header', () => {
  test('shows the owning directory beside the session name', () => {
    const session = new Session({ id: 'session-id', name: 'Project work', directory: '/projects/sirus', model: 'gpt-5.6-luna' });
    const output = stripAnsi(renderToString(
      <ChatHeader session={session} />,
      { columns: 100 },
    ));

    expect(output).toContain('PROJECT WORK /projects/sirus');
    expect(output).toContain('sirus');
    expect(output).not.toContain('gpt-5.6-luna');
  });

  test('keeps the title and highlighted agents on the original single header row', () => {
    const session = new Session({ id: 'session-id', name: 'Project work', directory: '/projects/sirus', model: 'gpt-5.6-luna' });
    const output = stripAnsi(renderToString(
      <ChatHeader session={session} />,
      { columns: 100 },
    ));

    expect(output.split('\n')[0]).toContain('PROJECT WORK');
    expect(output.split('\n')).toHaveLength(1);
  });

  test('shows a session name an agent chose as plain text', () => {
    const session = new Session({ id: 'session-id', directory: '/projects/sirus' });
    session.setName('Fix\x07 the \x1b]8;;https://elsewhere.example\x1b\\loader\x1b]8;;\x1b\\');
    const output = renderToString(<ChatHeader session={session} />, { columns: 100 });
    expect(output).not.toMatch(/\x07|\x1b\]/);
    expect(stripAnsi(output)).toContain('FIX THE LOADER /projects/sirus');
  });

  test('lists participant names without their models', () => {
    const session = new Session();
    session.addParticipant('reviewer', 'claude-sonnet-5');
    const output = stripAnsi(renderToString(<ChatHeader session={session} />, { columns: 100 }));

    expect(output).toContain('sirus');
    expect(output).not.toContain('·');
    expect(output).toContain('reviewer');
    expect(output.split('\n')).toHaveLength(1);
    expect(output).not.toContain('gpt-5.6-luna');
    expect(output).not.toContain('claude-sonnet-5');
  });
});
