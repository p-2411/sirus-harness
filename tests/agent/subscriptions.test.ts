import { describe, expect, test } from 'bun:test';
import { promptWithSharedHistory, transcript } from '../../src/agent_runtime/providers/subscription';
import type { Message } from '../../src/agent_runtime/types';

describe('subscription shared history', () => {
  test('identifies participants in a plain-text transcript', () => {
    expect(transcript([
      { role: 'user', content: [{ type: 'text', text: 'Review this' }] },
      {
        role: 'assistant',
        participant: 'reviewer',
        content: [{ type: 'text', text: 'Found one issue' }],
      },
    ])).toBe('User: Review this\n@reviewer: Found one issue');
  });

  test('replays unseen peer messages but not the participant own remembered response', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: '@builder start' }] },
      {
        role: 'assistant',
        participant: 'builder',
        content: [{ type: 'text', text: 'Builder result' }],
      },
      { role: 'user', content: [{ type: 'text', text: '@reviewer inspect' }] },
      {
        role: 'assistant',
        participant: 'reviewer',
        content: [{ type: 'text', text: 'Reviewer result' }],
      },
      { role: 'user', content: [{ type: 'text', text: '@builder continue' }] },
    ];

    const prompt = promptWithSharedHistory(messages, false, 1, 'builder');

    expect(prompt).toContain('User: @reviewer inspect');
    expect(prompt).toContain('@reviewer: Reviewer result');
    expect(prompt).not.toContain('Builder result');
    expect(prompt).toEndWith('@builder continue');
  });

  test('uses a routed prompt when the latest visible message came from another agent', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Start' }] },
      {
        role: 'assistant',
        participant: 'builder',
        content: [{ type: 'text', text: '@reviewer inspect this' }],
      },
    ];

    const prompt = promptWithSharedHistory(
      messages,
      true,
      0,
      'reviewer',
      '@builder mentioned you. Respond to that message.',
    );

    expect(prompt).toContain('@builder: @reviewer inspect this');
    expect(prompt).toEndWith('@builder mentioned you. Respond to that message.');
  });
});
