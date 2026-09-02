import { describe, expect, test } from 'bun:test';
import { isMouseInput, parseMouseEvent, parseMouseWheel } from '../../src/frontend/mouse';

describe('terminal mouse input', () => {
  test('parses wheel up after Ink strips the escape prefix', () => {
    expect(parseMouseWheel('[<64;40;12M')).toEqual({
      direction: 'up',
      column: 40,
      row: 12,
    });
  });

  test('parses raw wheel down input with modifier bits', () => {
    expect(parseMouseWheel('\x1b[<69;42;9M')).toEqual({
      direction: 'down',
      column: 42,
      row: 9,
    });
  });

  test('recognizes clicks without treating them as wheel movement', () => {
    expect(isMouseInput('[<0;30;8M')).toBe(true);
    expect(parseMouseWheel('[<0;30;8M')).toBeNull();
  });

  test('distinguishes press, drag and release of the left button', () => {
    expect(parseMouseEvent('[<0;30;8M')).toMatchObject({ kind: 'press', button: 'left', column: 30, row: 8 });
    expect(parseMouseEvent('[<32;31;8M')).toMatchObject({ kind: 'drag', button: 'left', column: 31 });
    expect(parseMouseEvent('[<0;35;9m')).toMatchObject({ kind: 'release', button: 'left', column: 35, row: 9 });
  });

  test('decodes modifier bits and reports buttonless motion as a move', () => {
    expect(parseMouseEvent('[<4;10;2M')).toMatchObject({ kind: 'press', shift: true, alt: false, ctrl: false });
    expect(parseMouseEvent('[<35;10;2M')).toMatchObject({ kind: 'move', button: 'none', column: 10, row: 2 });
  });

  test('ignores regular keyboard input', () => {
    expect(isMouseInput('hello')).toBe(false);
    expect(parseMouseWheel('hello')).toBeNull();
  });
});
