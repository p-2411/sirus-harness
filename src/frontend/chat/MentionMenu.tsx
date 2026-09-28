import { useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import path from 'node:path';
import stringWidth from 'string-width';
import type { Participant } from '../../agent_runtime/agent';
import { NAME_PATTERN_SOURCE } from '../../agent_runtime/session/roster';
import { formatFileMention } from '../../fileMentions';
import { activeFileMention, fileSearchDirectory, listMentionFiles, matchFileSuggestions } from '../../fileSearch';
import { MentionText, participantColorMap } from '../MentionText';
import { theme } from '../styles/theme';
import { terminalText } from '../terminal/text';
import { moveInWindow } from './SelectMenu';

const MENTION_MENU_VISIBLE_ITEMS = 4;

// The files the unfinished @token at the cursor could name, listed afresh from
// disk whenever the directory it browses changes, and matched as it is typed.
export function useFileSuggestions(directory: string | undefined, input: string, cursor: number) {
  const mention = activeFileMention(input, cursor);
  const active = Boolean(directory && mention);
  const browseDirectory = directory && mention ? fileSearchDirectory(directory, mention.query) : undefined;
  const absoluteReferences = mention ? path.isAbsolute(mention.query) : false;
  const searchKey = JSON.stringify([directory, browseDirectory, absoluteReferences]);
  const [result, setResult] = useState<{ key?: string; files: string[]; loading: boolean; error: string | null }>({
    files: [], loading: false, error: null,
  });

  useEffect(() => {
    if (!active || !directory || !browseDirectory) return;
    const controller = new AbortController();
    setResult({ key: searchKey, files: [], loading: true, error: null });
    listMentionFiles(directory, browseDirectory, absoluteReferences, controller.signal).then(files => {
      if (!controller.signal.aborted) setResult({ key: searchKey, files, loading: false, error: null });
    }, () => {
      if (!controller.signal.aborted) setResult({ key: searchKey, files: [], loading: false, error: 'Unable to list files in this directory.' });
    });
    return () => controller.abort();
  }, [active, directory, browseDirectory, absoluteReferences, searchKey]);

  const files = useMemo(() => active && result.key === searchKey && mention
    ? matchFileSuggestions(result.files, mention.query, 50, directory) : [],
  [active, directory, searchKey, result.key, result.files, mention?.query]);
  return {
    mention,
    files,
    loading: active && (result.key !== searchKey || result.loading),
    error: active && result.key === searchKey ? result.error : null,
  };
}

export interface MentionMenuItem {
  key: string;
  label: string;
  description: string;
  replacement: string;
  kind: 'participant' | 'file' | 'create';
}

// Only the unfinished @token at the cursor offers participants. This supports
// a second mention in the same message without mistaking emails or @scope/pkg
// package names for participant input.
const activeMentionPattern = new RegExp(`(?<![\\w@])@(${NAME_PATTERN_SOURCE}|)$`);

// The menu's rows, top to bottom: the participant the name typed so far
// would create unless one already has it, the participants whose names start
// with it, longest first, then the matching files, which sit nearest the
// input and take the selection once they arrive.
export function mentionMenuItems(
  input: string,
  participants: readonly Participant[],
  files: readonly string[],
): MentionMenuItem[] {
  const fileItems: MentionMenuItem[] = [...files].reverse().map(file => {
    const label = formatFileMention(file);
    return { key: `file:${file}`, label, description: 'attach file', replacement: `${label} `, kind: 'file' };
  });
  const fragment = activeMentionPattern.exec(input)?.[1];
  if (fragment === undefined) return fileItems;

  const typed = fragment.toLocaleLowerCase();
  // Longest name first, so the shortest, and so the closest, is last.
  const matching = participants
    .filter(participant => participant.name.toLocaleLowerCase().startsWith(typed))
    .sort((left, right) => right.name.length - left.name.length || right.name.localeCompare(left.name));
  const items: MentionMenuItem[] = [];
  if (!matching.some(participant => participant.name.toLocaleLowerCase() === typed)) {
    const name = fragment || 'name';
    items.push({
      key: 'create-participant',
      label: `@${name} <model> <prompt>`,
      description: 'create participant',
      replacement: `@${name} `,
      kind: 'create',
    });
  }
  for (const participant of matching) {
    items.push({
      key: `participant:${participant.name.toLocaleLowerCase()}`,
      label: `@${participant.name}`,
      description: 'message participant',
      replacement: `@${participant.name} `,
      kind: 'participant',
    });
  }
  return [...items, ...fileItems];
}

// Which item the menu has selected and which slice of it is on screen. The
// closest match sits at the bottom, so the window is tracked from its bottom
// edge. Matching files take precedence once they arrive; explicit keyboard
// selection stays on the item the user chose.
export function useMentionMenu({ active, input, cursor, participants, files }: {
  active: boolean;
  input: string;
  cursor: number;
  participants: readonly Participant[];
  files: readonly string[];
}) {
  const [navigation, setNavigation] = useState({ key: '', selected: '', bottomGap: 0 });
  const items = active ? mentionMenuItems(input.slice(0, cursor), participants, files) : [];
  const key = `${input}\0${cursor}`;
  useEffect(() => {
    setNavigation({ key, selected: '', bottomGap: 0 });
  }, [key]);
  const saved = navigation.key === key ? items.findIndex(item => item.key === navigation.selected) : -1;
  const selected = saved >= 0 ? saved : Math.max(0, items.length - 1);
  const bottomOffset = Math.max(0, items.length - MENTION_MENU_VISIBLE_ITEMS
    - (saved >= 0 ? navigation.bottomGap : 0));
  const offset = Math.max(0, Math.min(selected, Math.max(bottomOffset, selected - MENTION_MENU_VISIBLE_ITEMS + 1)));
  return {
    items,
    selected,
    offset,
    move(delta: -1 | 1) {
      if (items.length === 0) return;
      const next = moveInWindow({ selected, offset }, delta, items.length, MENTION_MENU_VISIBLE_ITEMS);
      setNavigation({
        key,
        selected: items[next.selected].key,
        bottomGap: Math.max(0, items.length - MENTION_MENU_VISIBLE_ITEMS - next.offset),
      });
    },
  };
}

export function MentionMenu({ items, participants, selected, offset, loading = false, error = null }: {
  items: readonly MentionMenuItem[];
  participants: readonly Participant[];
  selected: number;
  offset: number;
  loading?: boolean;
  error?: string | null;
}) {
  const colors = participantColorMap(participants);
  // A file's name is whatever is on disk, so it is made safe to print.
  const labels = items.map(item => terminalText(item.label));
  const labelWidth = Math.min(38, Math.max(0, ...labels.map(label => stringWidth(label))) + 2);
  const descriptionWidth = Math.max(0, ...items.map(item => stringWidth(item.description)));
  const visible = items.slice(offset, offset + MENTION_MENU_VISIBLE_ITEMS);
  return (
    <Box flexDirection="column" paddingX={2} marginX={1} flexShrink={0} position="static">
      {visible.map((item, index) => {
        const active = offset + index === selected;
        return (
          <Box key={item.key} height={1} minHeight={1} flexShrink={0} overflow="hidden">
            <Box width={2} flexShrink={0}>
              <Text color={active ? theme.accent : theme.textSubtle}>{active ? '› ' : '  '}</Text>
            </Box>
            <Box width={labelWidth} flexShrink={1} minWidth={0} paddingRight={2}>
              <Text color={active ? theme.accent : theme.text} wrap="truncate-end">
                <MentionText colors={colors}>{labels[offset + index]}</MentionText>
              </Text>
            </Box>
            <Box width={descriptionWidth} flexShrink={1} minWidth={0}>
              <Text color={theme.textMuted} wrap="truncate-end">{item.description}</Text>
            </Box>
          </Box>
        );
      })}
      {visible.length === 0 ? (
        <Text color={theme.textMuted} wrap="truncate-end">{loading ? 'Finding files…' : error ? 'Unable to list files in this directory.' : 'No matching files'}</Text>
      ) : null}
    </Box>
  );
}
