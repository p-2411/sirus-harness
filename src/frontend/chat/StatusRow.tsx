import { Box, Text } from 'ink';
import { theme } from '../styles/theme';
import { contextPercent, formatTokens, type ContextUsage } from '../../agent_runtime/usage';
import { PERMISSION_MODE_NAMES, type PermissionMode } from '../../agent_runtime/permissions/policy';

export interface StatusRowProps {
  permissionMode?: PermissionMode;
  // What the vendor made of the mode, when it could not honour it: "auto
  // approve is unavailable on claude-haiku-4-5; the agent is on Manual".
  modeNotice?: string | null;
  model?: string;
  thinkingLevel?: string;
  contextUsage?: ContextUsage | null;
  activeSubagents?: number;
}

// The context gauge: how much of the model's window the last response used.
// Muted until it matters, amber when it is getting full, red when nearly so.
function ContextGauge({ usage }: { usage: ContextUsage }) {
  const percent = contextPercent(usage);
  const color = percent === null ? theme.textSubtle
    : percent >= 90 ? theme.danger
      : percent >= 70 ? theme.pending : theme.textSubtle;
  return (
    <Text color={color} dimColor={percent === null || percent < 70}>
      ctx {formatTokens(usage.tokens)}{percent !== null ? ` (${percent}%)` : ''}
    </Text>
  );
}

// The line under the input box: the session's permission mode, qualified when
// the vendor could not honour it, then how many spawned subagents are still
// at work; the context gauge and the session's model stay on the far right.
// It keeps its height when there is nothing to say so the layout stays put.
export function SubagentStatusRow({
  permissionMode,
  modeNotice,
  model,
  thinkingLevel,
  contextUsage,
  activeSubagents: active = 0,
}: StatusRowProps) {
  return (
    <Box paddingX={3} height={1} flexShrink={0} justifyContent="space-between">
      <Box>
        {permissionMode && (
          <Text color={permissionMode === 'bypass' ? theme.pending : theme.textMuted} wrap="truncate-end">
            {PERMISSION_MODE_NAMES[permissionMode]}
            {modeNotice && <Text color={theme.textSubtle} dimColor> · {modeNotice}</Text>}
            <Text color={theme.textSubtle}> · shift+tab</Text>
          </Text>
        )}
        {active > 0 && (
          <Text color={theme.textMuted}>{permissionMode ? ' · ' : ''}{active} active subagent{active === 1 ? '' : 's'}</Text>
        )}
      </Box>
      <Box>
        {contextUsage && <ContextGauge usage={contextUsage} />}
        {contextUsage && model && <Text color={theme.textSubtle} dimColor> · </Text>}
        {model && (
          <Text color={theme.textSubtle} dimColor>
            {model}{thinkingLevel ? ` · ${thinkingLevel}` : ''}
          </Text>
        )}
      </Box>
    </Box>
  );
}
