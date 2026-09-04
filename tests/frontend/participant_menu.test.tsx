import { describe, expect, test } from 'bun:test';
import { renderToString } from 'ink';
import stripAnsi from 'strip-ansi';
import {
  ParticipantMenu,
  participantMenuItems,
} from '../../src/frontend/chat/ParticipantMenu';
import type { Participant } from '../../src/agent_runtime/session';

const participants: Participant[] = [
  { name: 'sirus', model: 'gpt-5.6-luna' },
  { name: 'Reviewer', model: 'claude-sonnet-5' },
];

describe('participant menu', () => {
  test('bare @ shows existing participants and the creation instructions', () => {
    const items = participantMenuItems('@', participants, ['gpt-test', 'claude-test']);

    expect(items.map(item => item.label)).toEqual([
      '@sirus',
      '@Reviewer',
      '@name <model> <prompt>',
    ]);
    expect(items[2].description).toBe('create participant');
  });

  test('filters participants case-insensitively and personalizes a new name', () => {
    expect(participantMenuItems('@rev', participants, ['gpt-test']).map(item => item.label))
      .toEqual(['@Reviewer', '@rev <model> <prompt>']);
    expect(participantMenuItems('@REVIEWER', participants, ['gpt-test']).map(item => item.label))
      .toEqual(['@Reviewer']);
  });

  test('works for later mentions and closes once prompt text begins', () => {
    expect(participantMenuItems('@sirus @r', participants, ['gpt-test']).map(item => item.label))
      .toEqual(['@Reviewer', '@r <model> <prompt>']);
    expect(participantMenuItems('@reviewer inspect this', participants)).toEqual([]);
  });

  test('ignores ordinary text, email addresses, and scoped packages', () => {
    expect(participantMenuItems('hello', participants)).toEqual([]);
    expect(participantMenuItems('user@', participants)).toEqual([]);
    expect(participantMenuItems('install @scope/package', participants)).toEqual([]);
  });

  test('renders instructions in the same compact style as the command menu', () => {
    const output = stripAnsi(renderToString(
      <ParticipantMenu input="@rev" participants={participants} />,
      { columns: 120 },
    ));

    expect(output).toContain('@Reviewer');
    expect(output).toContain('message participant');
    expect(output).toContain('@rev <model> <prompt>');
    expect(output).toContain('create participant');
  });
});
