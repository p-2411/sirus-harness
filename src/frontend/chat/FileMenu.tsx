import { useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import path from 'node:path';
import { activeFileMention, fileSearchDirectory, listMentionFiles, matchFileSuggestions } from '../../fileSearch';
import { theme } from '../styles/theme';

export const FILE_MENU_VISIBLE_ITEMS = 4;

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

export function FileMenu({ files, selected, offset, loading = false, error = null }: {
  files: string[];
  selected: number;
  offset: number;
  loading?: boolean;
  error?: string | null;
}) {
  const visible = files.slice(offset, offset + FILE_MENU_VISIBLE_ITEMS);
  return (
    <Box flexDirection="column" paddingX={2} marginX={1} flexShrink={0} position="static">
      {visible.map((file, index) => (
        <Box key={file} height={1} minHeight={1} flexShrink={0} overflow="hidden">
          <Box width={2} flexShrink={0}>
            <Text color={offset + index === selected ? theme.accent : theme.textSubtle}>{offset + index === selected ? '› ' : '  '}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text color={theme.textMuted} wrap="truncate-end">{file}</Text>
          </Box>
        </Box>
      ))}
      {visible.length === 0 ? (
        <Text color={theme.textMuted} wrap="truncate-end">{loading ? 'Finding files…' : error ? 'Unable to list files in this directory.' : 'No matching files'}</Text>
      ) : null}
      <Text color={theme.textMuted} wrap="truncate-end">↑↓ choose · tab attach · esc close</Text>
    </Box>
  );
}
