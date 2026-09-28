import { isMemoryAccessEnabled } from '../../agent_runtime/memory-access';
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODE_NAMES,
  PERMISSION_MODES,
  parsePermissionMode,
} from '../../agent_runtime/permissions/policy';
import {
  THINKING_LEVEL_DESCRIPTIONS,
  THINKING_LEVELS,
  parseThinkingLevel,
} from '../../agent_runtime/types';
import { notificationMode } from '../../frontend/terminal/notifications';
import { loadSirusModelPreference, openSettings } from '../../persistence';
import type { Feedback } from '../feedback';
import type { CommandMenuEntry, CommandSpec } from '../types';

// Sirus's own settings: what a new session starts in, and the switches that
// hold for every session. A session keeps its own mode and levels once it
// exists; `/permissions` and `/thinking` change those.

function defaults() {
  const settings = openSettings();
  return {
    permissionMode: settings.get('permissionMode') ?? DEFAULT_PERMISSION_MODE,
    // Null: each new agent runs at its model's default.
    thinkingLevel: settings.get('thinkingLevel'),
  };
}

function configMenu(args: readonly string[]): CommandMenuEntry[] | null {
  const current = defaults();
  if (args.length === 0) {
    return [
      { type: 'heading', key: 'new', label: 'New sessions start with' },
      {
        type: 'item', key: 'permissions', label: 'permissions',
        description: PERMISSION_MODE_NAMES[current.permissionMode], command: '/config permissions',
      },
      {
        type: 'item', key: 'thinking', label: 'thinking',
        description: current.thinkingLevel ?? 'the model\'s default', command: '/config thinking',
      },
      {
        type: 'heading', key: 'model',
        label: `model: ${loadSirusModelPreference() ?? 'the built-in default'} (/model before the first message sets it)`,
      },
      { type: 'heading', key: 'always', label: 'Every session' },
      { type: 'item', key: 'memory', label: 'memory', description: isMemoryAccessEnabled() ? 'on' : 'off', command: '/memory' },
      { type: 'item', key: 'notify', label: 'notifications', description: notificationMode(), command: '/notify' },
    ];
  }
  if (args.length !== 1) return null;
  if (args[0] === 'permissions') {
    return PERMISSION_MODES.map(mode => ({
      type: 'item', key: mode, label: PERMISSION_MODE_NAMES[mode],
      command: `/config permissions ${mode}`,
      ...(mode === current.permissionMode ? { current: true } : {}),
    }));
  }
  if (args[0] === 'thinking') {
    return [
      {
        type: 'item', key: 'default', label: 'default', description: 'whatever each agent\'s model picks',
        command: '/config thinking default', ...(current.thinkingLevel ? {} : { current: true }),
      },
      ...THINKING_LEVELS.map((level): CommandMenuEntry => ({
        type: 'item', key: level, label: level, description: THINKING_LEVEL_DESCRIPTIONS[level],
        command: `/config thinking ${level}`,
        ...(level === current.thinkingLevel ? { current: true } : {}),
      })),
    ];
  }
  return null;
}

function configCommand(args: readonly string[]): Feedback {
  const usage = 'Usage: /config [permissions ask|auto|bypass] [thinking default|low|medium|high|xhigh|max]';
  if (args.length === 0) {
    const current = defaults();
    return { kind: 'info', text: `New sessions start in ${PERMISSION_MODE_NAMES[current.permissionMode]}, thinking ${current.thinkingLevel ?? 'at the model\'s default'}.` };
  }
  if (args.length !== 2) throw new Error(usage);
  if (args[0] === 'permissions') {
    const mode = parsePermissionMode(args[1]);
    if (!mode) throw new Error(usage);
    if (!openSettings().set({ permissionMode: mode })) throw new Error('Could not save the setting.');
    return { kind: 'success', text: `New sessions start in ${PERMISSION_MODE_NAMES[mode]}. This one keeps its own; /permissions changes it.` };
  }
  if (args[0] === 'thinking') {
    if (args[1] === 'default') {
      if (!openSettings().set({ thinkingLevel: null })) throw new Error('Could not save the setting.');
      return { kind: 'success', text: 'New agents think at their model\'s default. Existing ones keep theirs; /thinking changes them.' };
    }
    const level = parseThinkingLevel(args[1]);
    if (!level) throw new Error(usage);
    if (!openSettings().set({ thinkingLevel: level })) throw new Error('Could not save the setting.');
    return { kind: 'success', text: `New agents start at ${level} thinking where their model offers it. Existing ones keep theirs; /thinking changes them.` };
  }
  throw new Error(usage);
}

export const configCommandSpec: CommandSpec = {
  name: 'config',
  args: '[permissions|thinking] [value]',
  description: 'Sirus settings: what new sessions start with, memory, notifications',
  run: args => configCommand(args),
  menu: args => configMenu(args),
};
