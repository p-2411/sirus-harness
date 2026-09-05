import { describe, expect, test } from 'bun:test';
import { isValidElement, type ReactElement } from 'react';
import {
  MentionText,
  mentionSegments,
  participantColorMap,
} from '../../src/frontend/MentionText';
import { theme } from '../../src/frontend/styles/theme';

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

  test('styles explicit file paths as whole mentions alongside agent names', () => {
    expect(mentionSegments('Ask @reviewer about @../proj/file.tsx and @"./@reviewer notes.txt"')).toEqual([
      { text: 'Ask ', isMention: false },
      { text: '@reviewer', isMention: true },
      { text: ' about ', isMention: false },
      { text: '@../proj/file.tsx', isMention: true },
      { text: ' and ', isMention: false },
      { text: '@"./@reviewer notes.txt"', isMention: true },
    ]);
    const rendered = MentionText({ children: '@../proj/file.tsx' });
    expect(isValidElement(rendered[0])).toBe(true);
    expect((rendered[0] as ReactElement<{ color: string }>).props.color).toBe(theme.textMuted);
    const filename = MentionText({ children: '@README.md' });
    expect((filename[0] as ReactElement<{ color: string; children: string }>).props)
      .toMatchObject({ color: theme.textMuted, children: '@README.md' });
    const nested = MentionText({ children: '@src/file.tsx' });
    expect((nested[0] as ReactElement<{ color: string; children: string }>).props)
      .toMatchObject({ color: theme.textMuted, children: '@src/file.tsx' });
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
