import { describe, expect, test } from 'bun:test';
import { renderToString } from 'ink';
import stripAnsi from 'strip-ansi';
import { CommandMenu } from '../../src/frontend/chat/CommandMenu';
import { matchCommands } from '../../src/commands/registry';
import { moveInWindow } from '../../src/frontend/chat/SelectMenu';

describe('command menu', () => {
  test('shows only the first six commands initially', () => {
    const output = stripAnsi(renderToString(
      <CommandMenu matches={matchCommands('/')} />,
      { columns: 100 },
    ));
    const lines = output.split('\n').filter(Boolean);

    expect(lines).toHaveLength(6);
    expect(output).toContain('/model');
    expect(output).toContain('/review');
    expect(output).not.toContain('/agents');
  });

  test('scrolls the six-command window to keep the selection visible', () => {
    let navigation = { selected: 0, offset: 0 };
    for (let index = 0; index < 6; index++) {
      navigation = moveInWindow(navigation, 1, 9, 6);
    }

    expect(navigation).toEqual({ selected: 6, offset: 1 });

    const output = stripAnsi(renderToString(
      <CommandMenu matches={matchCommands('/')} {...navigation} />,
      { columns: 100 },
    ));
    const lines = output.split('\n').filter(Boolean);

    expect(lines).toHaveLength(6);
    expect(output).not.toContain('/model');
    expect(output).toContain('› /status');
  });

  test('tags the vendors\' own commands and prefixes one a Sirus command shadows', () => {
    const nativeCommands = [
      { name: 'context', description: 'Show current context usage', invocation: '/context', vendor: 'claude' as const },
      { name: 'agents', description: 'Manage agent configurations', invocation: '/agents', vendor: 'claude' as const },
      { name: 'status', description: 'Display session configuration', invocation: '/status', vendor: 'gpt' as const },
    ];
    const render = (input: string) => stripAnsi(renderToString(
      <CommandMenu matches={matchCommands(input, nativeCommands)} />,
      { columns: 100 },
    ));
    expect(render('/cont')).toMatch(/\/context\s+\(claude\) Show current context usage/);
    const agents = render('/agen');
    expect(agents).toMatch(/\/agents\s+\[show/);
    expect(agents).toMatch(/\/claude:agents\s+\(claude\) Manage agent configurations/);
    expect(render('/codex:')).toMatch(/\/codex:status\s+\(codex\) Display session configuration/);
  });

  test('wraps navigation while resetting the visible window', () => {
    expect(moveInWindow({ selected: 0, offset: 0 }, -1, 9, 6))
      .toEqual({ selected: 8, offset: 3 });
    expect(moveInWindow({ selected: 8, offset: 3 }, 1, 9, 6))
      .toEqual({ selected: 0, offset: 0 });
  });
});
