import { saveSirusModelPreference } from '../../persistence';
import { modelIds, modelsOf, VENDOR_INFO, VENDORS } from '../../agent_runtime/providers/catalog';
import type { SubagentRun } from '../../agent_runtime/tools/subagents';
import { renderTranscript } from '../../agent_runtime/tools/subagents/report';
import {
  THINKING_LEVEL_DESCRIPTIONS,
  THINKING_LEVELS,
  parseThinkingLevel,
  type ThinkingLevel,
} from '../../agent_runtime/types';
import type { Feedback } from '../feedback';
import type { CommandMenuEntry, CommandMenuItem, CommandSession } from '../types';

function modelFamily(model: string): string {
  return model
    .toLocaleLowerCase()
    .split('-')
    .filter(part => !/^\d+(?:\.\d+)*$/.test(part))
    .join('-');
}

function modelVersion(model: string): number[] {
  return model
    .split('-')
    .filter(part => /^\d+(?:\.\d+)*$/.test(part))
    .flatMap(part => part.split('.').map(Number));
}

function compareModelVersions(left: string, right: string): number {
  const leftVersion = modelVersion(left);
  const rightVersion = modelVersion(right);
  const length = Math.max(leftVersion.length, rightVersion.length);
  for (let index = 0; index < length; index++) {
    const difference = (leftVersion[index] ?? 0) - (rightVersion[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

export function resolveModelReference(
  reference: string,
  availableModels: readonly string[] = modelIds(),
): string {
  const normalized = reference.toLocaleLowerCase();
  const exact = availableModels.find(model => model.toLocaleLowerCase() === normalized);
  if (exact) return exact;

  const matches = availableModels.filter(model =>
    model.toLocaleLowerCase().includes(normalized),
  );
  if (matches.length === 0) {
    throw new Error(`Unknown model "${reference}". Try: ${availableModels.join(', ')}`);
  }
  if (matches.length === 1) return matches[0];

  const families = new Set(matches.map(modelFamily));
  if (families.size === 1) {
    return matches.reduce((latest, model) =>
      compareModelVersions(model, latest) > 0 ? model : latest,
    );
  }

  throw new Error(`Ambiguous model "${reference}". Matches: ${matches.join(', ')}`);
}

export function modelMenuItems(args: readonly string[] = []): CommandMenuEntry[] | null {
  if (args.length > 1 || (args.length === 1 && !args[0].startsWith('@'))) return null;
  const participant = args[0]?.replace(/^@/, '');

  return VENDORS.flatMap(vendor => [
    {
      type: 'heading' as const,
      key: `${vendor}-models`,
      label: VENDOR_INFO[vendor].displayName,
    },
    ...modelsOf(vendor).map(model => ({
      type: 'item' as const,
      key: model,
      label: model,
      command: participant ? `/model @${participant} ${model}` : `/model ${model}`,
    })),
  ]);
}

export function changeModel(
  participantName: string = 'sirus',
  model: string,
  session: CommandSession,
): Feedback {
  const resolvedModel = resolveModelReference(model);
  const normalizedParticipantName = participantName.replace(/^@/, '');
  session.changeParticipantModel(participantName, resolvedModel);
  // Choosing Sirus before a conversation starts also chooses the default for
  // future sessions. Existing sessions retain their own participant models.
  if (session.isEmpty() && normalizedParticipantName.toLocaleLowerCase() === 'sirus'
    && !saveSirusModelPreference(resolvedModel)) {
    return {
      kind: 'error',
      text: `@${normalizedParticipantName} model set to ${resolvedModel}, but the default could not be saved.`,
    };
  }
  return {
    kind: 'success',
    text: `@${normalizedParticipantName} model set to ${resolvedModel}.`,
  };
}

// `/model subagent` reads or sets the model spawned subagents run on, a
// setting of the session. `default` returns them to the spawning
// participant's own model.
export function subagentModelCommand(args: readonly string[], session: CommandSession): Feedback {
  const describe = (model: string | null) => `Subagents run on ${model ?? 'each participant\'s own model'}.`;
  if (args.length === 0) return { kind: 'info', text: describe(session.getSubagentModel()) };
  if (args.length > 1) throw new Error('Usage: /model subagent [<model>|default]');
  const model = args[0] === 'default' ? null : resolveModelReference(args[0]);
  session.setSubagentModel(model);
  return { kind: 'success', text: describe(model) };
}

export function changeThinkingLevel(
  participantName: string = 'sirus',
  value: string,
  session: CommandSession,
): Feedback {
  const level = parseThinkingLevel(value);
  if (!level) throw new Error(`Unknown thinking level. Try: ${THINKING_LEVELS.join(', ')}`);
  const normalizedParticipantName = participantName.replace(/^@/, '');
  session.setThinkingLevel(level, normalizedParticipantName);
  return {
    kind: 'success',
    text: `@${normalizedParticipantName} thinking set to ${level}.`,
  };
}

export function thinkingMenuItems(args: readonly string[] = []): CommandMenuItem[] | null {
  if (args.length > 1 || (args.length === 1 && (parseThinkingLevel(args[0]) || !args[0].startsWith('@')))) {
    return null;
  }
  const participant = args[0]?.replace(/^@/, '');
  return THINKING_LEVELS.map((level: ThinkingLevel) => ({
    type: 'item',
    key: level,
    label: level,
    description: THINKING_LEVEL_DESCRIPTIONS[level],
    command: participant ? `/thinking @${participant} ${level}` : `/thinking ${level}`,
  }));
}

export function thinkingCommand(args: readonly string[], session: CommandSession): Feedback {
  if (args.length === 0) {
    return { kind: 'info', text: `@sirus thinking is ${session.getThinkingLevel()}.` };
  }
  if (args.length === 1) {
    const level = parseThinkingLevel(args[0]);
    if (level) return changeThinkingLevel('sirus', level, session);
    if (!args[0].startsWith('@')) {
      throw new Error(`Unknown thinking level. Try: ${THINKING_LEVELS.join(', ')}`);
    }
    return {
      kind: 'info',
      text: `@${args[0].replace(/^@/, '')} thinking is ${session.getThinkingLevel(args[0])}.`,
    };
  }
  if (args.length === 2) return changeThinkingLevel(args[0], args[1], session);
  throw new Error('Usage: /thinking [participant] [low|medium|high|xhigh|max]');
}

// ── Workers ────────────────────────────────────────────────────────────────
// A worker is a subagent the session runs in the background. `/agents` is
// where the user watches one, steers it, stops it, or clears its line.

// The compact age the worker strip and the `/agents` menu both show: 45s,
// 2m10s, 1h04m. It lives beside the menu so the two cannot drift apart.
export function formatWorkerElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

export function workerAge(run: SubagentRun, now: number = Date.now()): string {
  return formatWorkerElapsed((run.finishedAt ?? now) - run.startedAt);
}

// Every worker `/agents` offers, in the order it lists them: the ones still
// working first, then the finished ones the user has not yet dismissed. The
// strip has an order of its own, since it shows one line at a time.
export function visibleWorkers(workers: readonly SubagentRun[]): SubagentRun[] {
  const shown = workers.filter(run => !run.dismissed);
  return [
    ...shown.filter(run => run.status === 'working'),
    ...shown.filter(run => run.status !== 'working'),
  ];
}

const WORKER_ACTIONS = ['show', 'message', 'cancel', 'dismiss'] as const;

type WorkerAction = typeof WORKER_ACTIONS[number];

function isWorkerAction(value: string | undefined): value is WorkerAction {
  return WORKER_ACTIONS.includes(value as WorkerAction);
}

function taskPreview(prompt: string, limit = 60): string {
  const single = prompt.replace(/\s+/g, ' ').trim();
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single;
}

function findWorker(id: string, session: CommandSession): SubagentRun {
  const run = session.getWorkers().find(candidate => candidate.id === id);
  if (!run) throw new Error(`No worker "${id}" in this session. /agents lists them.`);
  return run;
}

function workerActions(run: SubagentRun): CommandMenuEntry[] {
  const entries: CommandMenuEntry[] = [
    { type: 'heading', key: run.id, label: `${run.id} · ${run.status}` },
    {
      type: 'item',
      key: 'show',
      label: 'Show transcript',
      description: 'what it has said and done so far',
      command: `/agents show ${run.id}`,
    },
  ];
  // Only a working worker can be steered or stopped; only a finished one can
  // have its line cleared.
  if (run.status === 'working') {
    entries.push({
      type: 'item',
      key: 'message',
      label: 'Send a message',
      description: 'steer it while it works',
      command: `/agents message ${run.id}`,
      input: { prompt: `Message for ${run.id}` },
    });
    entries.push({
      type: 'item',
      key: 'cancel',
      label: 'Cancel',
      description: 'stop it and keep what it has done',
      command: `/agents cancel ${run.id}`,
    });
  } else {
    entries.push({
      type: 'item',
      key: 'dismiss',
      label: 'Dismiss',
      description: 'clear its line from the strip',
      command: `/agents dismiss ${run.id}`,
    });
  }
  return entries;
}

// `/agents` lists the session's workers; `/agents <id>` offers what can be
// done to one. Anything with an action word already chosen simply runs.
export function agentsMenuItems(args: readonly string[], session: CommandSession): CommandMenuEntry[] | null {
  if (args.length === 0) {
    const workers = visibleWorkers(session.getWorkers());
    if (workers.length === 0) return null;
    return [
      { type: 'heading', key: 'workers', label: 'Workers' },
      ...workers.map(run => ({
        type: 'item' as const,
        key: run.id,
        label: `${run.id} · ${run.model} · ${run.status} ${workerAge(run)}`,
        description: taskPreview(run.prompt),
        command: `/agents ${run.id}`,
      })),
    ];
  }
  if (args.length !== 1 || isWorkerAction(args[0])) return null;
  return workerActions(findWorker(args[0], session));
}

// The worker's record as text, for the panel: what it was asked, what it is
// on, where its work is, and the conversation it has had.
function showWorker(run: SubagentRun): Feedback {
  const transcript = run.transcript.length > 0
    ? run.transcript.flatMap(entry => [
      entry.role === 'user' ? '› you' : `› ${run.id}`,
      renderTranscript(entry.content),
      '',
    ])
    : [renderTranscript(run.content)];
  return {
    kind: 'info',
    showIcon: false,
    panel: true,
    text: [
      `${run.id} · ${run.status} · ${workerAge(run)}`,
      `task: ${run.prompt.trim()}`,
      `model: ${run.model} · ${run.thinkingLevel}`,
      `branch: ${run.branch ?? `none · works in ${run.directory}`}`,
      '',
      ...transcript,
    ].join('\n'),
  };
}

function describeWorkers(session: CommandSession): Feedback {
  const workers = visibleWorkers(session.getWorkers());
  if (workers.length === 0) return { kind: 'info', text: 'No workers in this session.' };
  return {
    kind: 'info',
    showIcon: false,
    panel: true,
    text: workers
      .map(run => `${run.id} · ${run.model} · ${run.status} ${workerAge(run)} · ${taskPreview(run.prompt)}`)
      .join('\n'),
  };
}

export function agentsCommand(
  args: readonly string[],
  session: CommandSession,
): Feedback | Promise<Feedback> {
  const action = args[0];
  if (action === undefined) return describeWorkers(session);
  // A bare id is what the list menu sends; typed on its own it shows the run.
  if (!isWorkerAction(action)) {
    if (args.length > 1) throw new Error('Usage: /agents [show|message|cancel|dismiss] <id>');
    return showWorker(findWorker(action, session));
  }
  const id = args[1];
  if (!id) throw new Error(`Usage: /agents ${action} <id>`);
  const run = findWorker(id, session);
  switch (action) {
    case 'show':
      return showWorker(run);
    case 'message': {
      // Typed, the message is the rest of the line; chosen from the menu it
      // arrives as one final argument the input bar collected.
      const text = args.slice(2).join(' ').trim();
      if (!text) throw new Error(`Usage: /agents message ${run.id} <message>`);
      if (run.status !== 'working') {
        throw new Error(`${run.id} is ${run.status}; only a working worker can be messaged.`);
      }
      return session.messageWorker(run.id, text).then(() => ({
        kind: 'success' as const,
        text: `Sent to ${run.id}.`,
      }));
    }
    case 'cancel': {
      if (run.status !== 'working') return { kind: 'info', text: `${run.id} is already ${run.status}.` };
      return session.cancelWorker(run.id).then(() => ({
        kind: 'success' as const,
        text: `Cancelled ${run.id}.`,
      }));
    }
    case 'dismiss': {
      if (run.status === 'working') {
        throw new Error(`${run.id} is still working. Cancel it first, or leave it to finish.`);
      }
      session.dismissWorker(run.id);
      return { kind: 'success', text: `Dismissed ${run.id}.` };
    }
  }
}
