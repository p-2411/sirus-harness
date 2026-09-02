import { describe, expect, test } from 'bun:test';
import { isValidElement, type ReactElement } from 'react';
import {
  MentionText,
  mentionSegments,
  participantColorMap,
} from '../../src/frontend/MentionText';
import { theme } from '../../src/frontend/theme';

describe('mention text', () => {
  test('finds every participant mention without consuming punctuation', () => {
    expect(mentionSegments('Ask @sirus, then @Reviewer.')).toEqual([
      { text: 'Ask ', isMention: false },
      { text: '@sirus', isMention: true },
      { text: ', then ', isMention: false },
      { text: '@Reviewer', isMention: true },
      { text: '.', isMention: false },
    ]);
  });

  test('does not color emails or scoped package names', () => {
    expect(mentionSegments('user@example.com uses @scope/package'))
      .toEqual([{ text: 'user@example.com uses @scope/package', isMention: false }]);
  });

  test('renders mentions with their participant color', () => {
    const colors = participantColorMap([
      { name: 'sirus', model: 'gpt' },
      { name: 'reviewer', model: 'claude' },
    ]);
    const rendered = MentionText({ children: 'Ask @reviewer', colors });
    expect(Array.isArray(rendered)).toBe(true);
    const mention = rendered[1];
    expect(isValidElement(mention)).toBe(true);
    expect((mention as ReactElement<{ color: string }>).props.color).toBe(colors.get('reviewer')!);
  });

  test('assigns a different stable color to each participant', () => {
    const participants = [
      { name: 'sirus', model: 'gpt' },
      { name: 'reviewer', model: 'claude' },
      { name: 'builder', model: 'gpt' },
    ];
    const first = participantColorMap(participants);
    const second = participantColorMap(participants);

    expect(new Set(first.values()).size).toBe(participants.length);
    expect([...second]).toEqual([...first]);
    expect(first.get('sirus')).toBe(theme.accentSoft);
  });

  test('keeps sirus grey regardless of participant ordering', () => {
    const colors = participantColorMap([
      { name: 'reviewer', model: 'claude' },
      { name: 'sirus', model: 'gpt' },
    ]);

    expect(colors.get('sirus')).toBe(theme.accentSoft);
    expect(colors.get('reviewer')).toBe(theme.mention);
  });
});
