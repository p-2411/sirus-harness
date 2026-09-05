import { describe, expect, test } from 'bun:test';
import { renderToString } from 'ink';
import stripAnsi from 'strip-ansi';
import {
  CommandMenu,
  moveCommandMenuSelection,
} from '../../src/frontend/chat/CommandMenu';

describe('command menu', () => {
  test('shows only the first six commands initially', () => {
    const output = stripAnsi(renderToString(
      <CommandMenu input="/" />,
      { columns: 100 },
    ));
    const lines = output.split('\n').filter(Boolean);

    expect(lines).toHaveLength(6);
    expect(output).toContain('/model');
    expect(output).toContain('/usage');
    expect(output).not.toContain('/update');
  });

  test('scrolls the six-command window to keep the selection visible', () => {
    let navigation = { selected: 0, offset: 0 };
    for (let index = 0; index < 6; index++) {
      navigation = moveCommandMenuSelection(navigation, 1, 9);
    }

    expect(navigation).toEqual({ selected: 6, offset: 1 });

    const output = stripAnsi(renderToString(
      <CommandMenu input="/" {...navigation} />,
      { columns: 100 },
    ));
    const lines = output.split('\n').filter(Boolean);

    expect(lines).toHaveLength(6);
    expect(output).not.toContain('/model');
    expect(output).toContain('› /update');
  });

  test('wraps navigation while resetting the visible window', () => {
    expect(moveCommandMenuSelection({ selected: 0, offset: 0 }, -1, 9))
      .toEqual({ selected: 8, offset: 3 });
    expect(moveCommandMenuSelection({ selected: 8, offset: 3 }, 1, 9))
      .toEqual({ selected: 0, offset: 0 });
  });
});
