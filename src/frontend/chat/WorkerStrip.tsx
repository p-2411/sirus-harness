// The line above the status row: the background subagents of the displayed
// session, one at a time. The run that changed last leads, with a counter
// when there are others behind it, and ↓ from the input bar walks them. The
// SpawnAgent row in the history stays the anchor; this is the live view.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../styles/theme';
import { toolLine } from './ChatMessage';
import { workerAge } from '../../commands/agents/behavior';
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

// How long a finished run keeps its line: long enough to read how it ended,
// then the strip belongs to the ones still working. `/agents` still lists it
// afterwards, so nothing is lost with the line.
const FINISHED_LINGER_MS = 1000;

// What the strip would show, freshest first: the runs still working and the
// ones that have only just ended, minus the lines the user has cleared.
export function stripWorkers(
  workers: readonly SubagentRun[],
  now: number = Date.now(),
): SubagentRun[] {
  return workers
    .filter(run => !run.dismissed
      && (run.status === 'working' || now - (run.finishedAt ?? 0) < FINISHED_LINGER_MS))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

// The strip while it has the keyboard: the list as it stood when focus
// arrived, so nothing reorders or leaves under the user, and the line they
// are on. The input bar owns both.
export interface WorkerSelection {
  runs: readonly SubagentRun[];
  index: number;
}

// What the worker is doing: its latest tool call while it works, and how it
// ended once it has.
function workerActivity(run: SubagentRun): string {
  if (run.status !== 'working') return run.status;
  const call = [...run.content]
    .reverse()
    .find((block): block is ToolCallBlock => block.type === 'tool_call');
  return call ? toolLine(call, TOOL_TITLE_LENGTH) : 'starting';
}

function WorkerLine({ run, now, selected, position }: {
  run: SubagentRun;
  now: number;
  selected: boolean;
  // "2/3" while others are waiting behind this line, null when it is alone.
  position: string | null;
}) {
  const finished = run.status !== 'working';
  return (
    <Text wrap="truncate-end" dimColor={finished}>
      {/* The mark keeps its column whether or not the strip has the keyboard,
          so the line does not jump when focus arrives. */}
      <Text color={theme.accent}>{selected ? '› ' : '  '}</Text>
      {position && <Text color={theme.textSubtle}>{position} </Text>}
      <Text color={workerColors[run.status]}>●</Text>
      <Text color={theme.textMuted}> {run.id}</Text>
      <Text color={theme.textSubtle}> · {run.model} {run.thinkingLevel}</Text>
      <Text color={theme.textSubtle}> · {workerAge(run, now)}</Text>
      <Text color={theme.textSubtle}> · {workerActivity(run)}</Text>
      {run.branch && <Text color={theme.textSubtle}> · {run.branch}</Text>}
    </Text>
  );
}

// One line, for the freshest run or for the one the user has selected. With
// nothing to show the strip takes no height at all, so the input box does not
// move around under it.
export function WorkerStrip({ workers, selection }: {
  workers: readonly SubagentRun[];
  selection?: WorkerSelection | null;
}) {
  // Runs are mutated in place, so the strip follows the index rather than
  // waiting for the chat to hand it a new array.
  useSyncExternalStore(subscribeSubagents, getSubagentsVersion);
  const [now, setNow] = useState(() => Date.now());
  const shown = selection ? selection.runs : stripWorkers(workers, now);
  const index = selection ? Math.min(selection.index, shown.length - 1) : 0;

  // The age on a working line moves every second, and a finished line leaves
  // when its second is up: wake for whichever is due first, and not at all
  // when there is neither.
  const working = workers.some(run => !run.dismissed && run.status === 'working');
  const departures = workers
    .filter(run => !run.dismissed && run.status !== 'working' && run.finishedAt !== null)
    .map(run => (run.finishedAt ?? 0) + FINISHED_LINGER_MS)
    .filter(at => at > now);
  const nextDeparture = departures.length > 0 ? Math.min(...departures) : null;
  useEffect(() => {
    if (!working && nextDeparture === null) return;
    const delay = nextDeparture === null
      ? 1000
      : Math.max(0, Math.min(1000, nextDeparture - Date.now()));
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [working, nextDeparture, now]);

  const run = shown[index];
  if (!run) return null;
  return (
    <Box paddingX={3} flexDirection="column" flexShrink={0}>
      <WorkerLine
        run={run}
        now={now}
        selected={Boolean(selection)}
        position={shown.length > 1 ? `${index + 1}/${shown.length}` : null}
      />
    </Box>
  );
}
