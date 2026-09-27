import { Box, Text } from 'ink';
import { theme } from '../styles/theme';
import { contextPercent, formatTokens, type ContextUsage } from '../../agent_runtime/usage';
import { PERMISSION_MODE_NAMES, type PermissionMode } from '../../agent_runtime/permissions/policy';

// How much the vendor may do unasked, by colour: red when nothing is asked,
// yellow when its own reviewer decides, muted when it asks.
const MODE_COLORS: Record<PermissionMode, string> = {
  ask: theme.textMuted,
  auto: theme.pending,
  bypass: theme.danger,
};

export interface StatusRowProps {
  permissionMode?: PermissionMode;
  // What the vendor made of the mode, when the agent is not on it: "auto
  // approve is unavailable to @sirus, which is on Manual", or "@sirus
  // switched to Bypass Permissions; the session is on ask for approval".
  modeNotice?: string | null;
  model?: string;
  thinkingLevel?: string;
  contextUsage?: ContextUsage | null;
  tasksVisible?: boolean;
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
// the vendor could not honour it; the context gauge and the session's model
// stay on the far right. The workers have their own strip above this row.
// It keeps its height when there is nothing to say so the layout stays put.
export function SubagentStatusRow({
  permissionMode,
  modeNotice,
  model,
  thinkingLevel,
  contextUsage,
  tasksVisible,
}: StatusRowProps) {
  return (
    <Box paddingX={3} height={1} flexShrink={0} justifyContent="space-between">
      <Box>
        {permissionMode && (
          <Text color={MODE_COLORS[permissionMode]} wrap="truncate-end">
            {PERMISSION_MODE_NAMES[permissionMode]}
            {modeNotice && <Text color={theme.textSubtle} dimColor> · {modeNotice}</Text>}
            <Text color={theme.textSubtle}> · shift+tab</Text>
          </Text>
        )}
        {tasksVisible !== undefined && (
          <Text color={theme.textSubtle}>{permissionMode ? ' · ' : ''}ctrl+t to {tasksVisible ? 'hide' : 'show'} tasks</Text>
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
