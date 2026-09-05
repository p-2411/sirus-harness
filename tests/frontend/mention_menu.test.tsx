import { describe, expect, test } from 'bun:test';
import { isValidElement, type ReactElement } from 'react';
import { renderToString } from 'ink';
import stripAnsi from 'strip-ansi';
import type { Participant } from '../../src/agent_runtime/session';
import { MentionText, participantColorMap } from '../../src/frontend/MentionText';
import { MentionMenu, mentionMenuItems } from '../../src/frontend/chat/MentionMenu';

const participants: Participant[] = [
  { name: 'sirus', model: 'gpt' },
  { name: 'Reviewer', model: 'claude' },
  { name: 'Researcher', model: 'gpt' },
];

describe('unified mention menu', () => {
  test('places every name below files with the closest matches nearest the bottom', () => {
    const items = mentionMenuItems('Ask @Re', participants, ['README.md', 'src/Reviewer.ts']);
    expect(items.map(item => item.kind)).toEqual(['file', 'file', 'create', 'participant', 'participant']);
    expect(items.map(item => item.label)).toEqual([
      '@src/Reviewer.ts', '@README.md', '@Re <model> <prompt>', '@Researcher', '@Reviewer',
    ]);
    expect(items.map(item => item.replacement)).toEqual([
      '@src/Reviewer.ts ', '@README.md ', '@Re ', '@Researcher ', '@Reviewer ',
    ]);
  });

  test('keeps colliding files above an exact matching agent', () => {
    const items = mentionMenuItems('@Reviewer', participants, ['Reviewer', 'Reviewer.ts']);
    expect(items.map(item => item.kind)).toEqual(['file', 'file', 'participant']);
    expect(items.map(item => item.label)).toEqual(['@Reviewer.ts', '@"Reviewer"', '@Reviewer']);
    expect(items.map(item => item.replacement)).toEqual(['@Reviewer.ts ', '@"Reviewer" ', '@Reviewer ']);
  });

  test('quotes spaced paths and preserves explicit parent and absolute references', () => {
    const items = mentionMenuItems('@./', participants, ['docs/design notes.md', '../proj/file.tsx', '/tmp/file.ts']);
    expect(items.map(item => item.replacement)).toEqual([
      '@/tmp/file.ts ', '@../proj/file.tsx ', '@"docs/design notes.md" ',
    ]);
    expect(items.every(item => item.description === 'attach file')).toBe(true);
    expect(mentionMenuItems('@', [], [])[0]?.replacement).toBe('@name ');
  });

  test('aligns agent and file descriptions with identical fixed selection slots', () => {
    const items = mentionMenuItems('@Re', participants, ['README.md']);
    const output = stripAnsi(renderToString(
      <MentionMenu items={items} participants={participants} selected={0} offset={0} />,
      { columns: 80 },
    ));
    const lines = output.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toContain('@Reviewer');
    expect(lines[0]).toContain('› @README.md');
    const labelColumn = lines[3]!.indexOf('@Reviewer');
    expect(lines[2]!.indexOf('@Researcher')).toBe(labelColumn);
    expect(lines[0]!.indexOf('@README.md')).toBe(labelColumn);
    const descriptionColumn = lines[3]!.indexOf('message participant');
    expect(lines[2]!.indexOf('message participant')).toBe(descriptionColumn);
    expect(lines[0]!.indexOf('attach file')).toBe(descriptionColumn);
    expect(lines[1]!.indexOf('create participant')).toBe(descriptionColumn);
    expect(output).not.toContain('↑↓ choose · tab / enter select · esc close');
  });

  test('clips four menu rows in a narrow terminal and scrolls to the selected file', () => {
    const files = Array.from({ length: 8 }, (_, index) => `${index}/${'long-directory/'.repeat(8)}file.ts`);
    const items = mentionMenuItems('@', participants, files);
    const output = stripAnsi(renderToString(
      <MentionMenu items={items} participants={participants} selected={4} offset={3} />,
      { columns: 44 },
    ));
    const lines = output.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('@4/');
    expect(lines[1]).toContain('› @3/');
    expect(output).not.toContain('@0/');
    expect(lines.every(line => line.length <= 44)).toBe(true);
    expect(output).not.toContain('@Reviewer');
  });

  test('retains the existing per-agent MentionText colors and hides raw errors', () => {
    const colors = participantColorMap(participants);
    const menu = MentionMenu({ items: mentionMenuItems('@Reviewer', participants, []), participants, selected: 0, offset: 0 });
    const descendants = (node: unknown): ReactElement<{ colors?: ReadonlyMap<string, string>; children?: unknown }>[] => {
      if (Array.isArray(node)) return node.flatMap(descendants);
      if (!isValidElement<{ colors?: ReadonlyMap<string, string>; children?: unknown }>(node)) return [];
      return [node, ...descendants(node.props.children)];
    };
    const mention = descendants(menu).find(element => element.type === MentionText);
    expect(mention?.props.colors?.get('reviewer')).toBe(colors.get('reviewer'));
    expect(mention?.props.children).toBe('@Reviewer');
    expect(stripAnsi(renderToString(
      <MentionMenu items={[]} participants={participants} selected={0} offset={0} error="secret stack trace" />,
    ))).not.toContain('secret stack trace');
  });
});
