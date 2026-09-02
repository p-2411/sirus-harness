import { Box, Text } from 'ink';
import { matchCommands } from '../../commands/command_register';
import { theme } from '../theme';


export function CommandMenu({ input }: { input: string }) {
  const matches = matchCommands(input);
  if (matches.length === 0) return null;

  const labels = matches.map(spec => `/${spec.name}${spec.args ? ` ${spec.args}` : ''}`);
  const column = Math.max(...labels.map(label => label.length)) + 2;

  return (
    <Box flexDirection="column" paddingX={2} marginX={1} flexShrink={0} position="static">
      {matches.map((spec, i) => (
        <Box key={spec.name}>
          <Text color={theme.accent}>{labels[i].padEnd(column)}</Text>
          <Text color={theme.textMuted}>{spec.description}</Text>
        </Box>
      ))}
    </Box>
  );
}
