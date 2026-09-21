// The lines above the status row, one per worker of the displayed session:
// the background subagents the user can watch without leaving the chat. The
// SpawnAgent row in the history stays the anchor; this is the live view.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../styles/theme';
import { toolLine } from './ChatMessage';
import { visibleWorkers, workerAge } from '../../commands/agents/behavior';
import {
  getSubagentsVersion,
  subscribeSubagents,
  type SubagentRun,
  type SubagentStatus,
} from '../../agent_runtime/tools/subagents';
import type { ToolCallBlock } from '../../agent_runtime/types';

// The same colours the SpawnAgent row uses, so a worker looks the same
// wherever it appears. An interrupted run is a record nobody stopped on
// purpose: muted, like a cancelled one.
const workerColors: Record<SubagentStatus, string> = {
  working: theme.pending,
  done: theme.success,
  failed: theme.danger,
  cancelled: theme.textMuted,
  interrupted: theme.textMuted,
};

// Room for a tool title on a strip line before it is cut.
const TOOL_TITLE_LENGTH = 32;

// What the worker is doing: its latest tool call while it works, and how it
// ended once it has.
function workerActivity(run: SubagentRun): string {
  if (run.status !== 'working') return run.status;
  const call = [...run.content]
    .reverse()
    .find((block): block is ToolCallBlock => block.type === 'tool_call');
  return call ? toolLine(call, TOOL_TITLE_LENGTH) : 'starting';
}

function WorkerLine({ run, now }: { run: SubagentRun; now: number }) {
  const finished = run.status !== 'working';
  return (
    <Text wrap="truncate-end" dimColor={finished}>
      <Text color={workerColors[run.status]}>●</Text>
      <Text color={theme.textMuted}> {run.id}</Text>
      <Text color={theme.textSubtle}> · {run.model} {run.thinkingLevel}</Text>
      <Text color={theme.textSubtle}> · {workerAge(run, now)}</Text>
      <Text color={theme.textSubtle}> · {workerActivity(run)}</Text>
      {run.branch && <Text color={theme.textSubtle}> · {run.branch}</Text>}
    </Text>
  );
}

// Runs first, then the finished ones the user has not dismissed, dimmed
// until they do. With nothing to show the strip takes no height at all, so
// the input box does not move around under it.
export function WorkerStrip({ workers }: { workers: readonly SubagentRun[] }) {
  // Runs are mutated in place, so the strip follows the index rather than
  // waiting for the chat to hand it a new array.
  useSyncExternalStore(subscribeSubagents, getSubagentsVersion);
  const shown = visibleWorkers(workers);
  const anyWorking = shown.some(run => run.status === 'working');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!anyWorking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [anyWorking]);

  if (shown.length === 0) return null;
  return (
    <Box paddingX={3} flexDirection="column" flexShrink={0}>
      {shown.map(run => <WorkerLine key={run.id} run={run} now={now} />)}
    </Box>
  );
}
