import { describe, expect, test } from 'bun:test';
import { renderToString } from 'ink';
import stripAnsi from 'strip-ansi';
import { Session } from '../../src/agent_runtime/session';
import { ChatHeader } from '../../src/frontend/chat/Chat';

describe('chat header', () => {
  test('shows the owning directory beside the session name', () => {
    const session = new Session('Project work', 'session-id', 'gpt-5.6-luna', [], '/projects/sirus');
    const output = stripAnsi(renderToString(
      <ChatHeader session={session} />,
      { columns: 100 },
    ));

    expect(output).toContain('PROJECT WORK /projects/sirus');
    expect(output).toContain('sirus');
    expect(output).not.toContain('gpt-5.6-luna');
  });

  test('uses the same one-line top inset as the sidebar header', () => {
    const session = new Session('Project work', 'session-id', 'gpt-5.6-luna', [], '/projects/sirus');
    const output = stripAnsi(renderToString(
      <ChatHeader session={session} />,
      { columns: 100 },
    ));

    expect(output.split('\n')[0]).toBe('');
    expect(output.split('\n')[1]).toContain('PROJECT WORK');
  });

  test('lists participant names without their models', () => {
    const session = new Session();
    session.addParticipant('reviewer', 'claude-sonnet-5');
    const output = stripAnsi(renderToString(<ChatHeader session={session} />, { columns: 100 }));

    expect(output).toContain('sirus · reviewer');
    expect(output).not.toContain('gpt-5.6-luna');
    expect(output).not.toContain('claude-sonnet-5');
  });
});
