// The input box while a command asks something of the user rather than the
// bar collecting a message: a menu to choose from, or one value to type. It
// answers and hands the bar back; the draft the user was typing waits
// untouched in the session, so nothing here knows about it.
import { useEffect, useState, type ReactNode } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import { theme } from '../styles/theme';
import { moveSelection, SelectMenu } from './SelectMenu';
import { EntryInput } from './InputRows';
import { backspaceAtEnd, isForeignInput, isTypedText } from './editor';
import type { CommandMenuEntry, CommandMenuItem } from '../../commands/types';

export type CommandPrompt =
  | {
    type: 'menu';
    items: readonly CommandMenuEntry[];
    onSelect: (item: CommandMenuItem) => void;
    onCancel: () => void;
  }
  | {
    type: 'entry';
    prompt: string;
    // A secret is echoed as dots; everything else is typed in the open.
    masked: boolean;
    onSubmit: (value: string) => void;
    onCancel: () => void;
  };

export function PromptBar({ mode, frame }: {
  mode: CommandPrompt;
  // The input bar's lines around the box, given the menu that opens above
  // them and the box itself.
  frame: (menu: ReactNode, box: ReactNode) => ReactNode;
}) {
  const [selected, setSelected] = useState(0);
  const [entry, setEntry] = useState('');
  // A new prompt starts on its first choice with nothing typed.
  useEffect(() => {
    setSelected(0);
    setEntry('');
  }, [mode]);

  usePaste(text => {
    if (mode.type === 'entry') setEntry(current => current + text.trim());
  });

  useInput((enteredInput, key) => {
    if (isForeignInput(enteredInput, key)) return;
    if (mode.type === 'menu') {
      const items = mode.items.filter((entry): entry is CommandMenuItem => entry.type === 'item');
      if (key.escape) mode.onCancel();
      else if (key.upArrow) setSelected(current => moveSelection(current, -1, items.length));
      else if (key.downArrow) setSelected(current => moveSelection(current, 1, items.length));
      else if (key.return && items[selected]) mode.onSelect(items[selected]);
      return;
    }
    // Most terminals (macOS included) send DEL for the backspace key, which
    // Ink reports as key.delete rather than key.backspace.
    const isBackspace = key.backspace || key.delete;
    if (key.escape) mode.onCancel();
    else if (key.return) {
      const value = entry.trim();
      if (value) mode.onSubmit(value);
    } else if (key.ctrl && enteredInput === 'u') setEntry('');
    else if (isBackspace) setEntry(backspaceAtEnd);
    else if (isTypedText(key)) setEntry(current => current + enteredInput);
  });

  return frame(
    mode.type === 'menu' && <SelectMenu items={mode.items} selected={selected} />,
    <Box
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
      marginX={1}
      flexShrink={0}
      flexDirection="column"
    >
      <Box justifyContent="space-between">
        {mode.type === 'entry'
          ? <EntryInput prompt={mode.prompt} value={entry} masked={mode.masked} />
          : (
            <Box>
              <Text color={theme.accentSoft}>›{' '}</Text>
              <Text color={theme.textSubtle}>↑↓ choose · enter to select</Text>
            </Box>
          )}
        <Text color={theme.textSubtle}>esc cancels</Text>
      </Box>
    </Box>,
  );
}
