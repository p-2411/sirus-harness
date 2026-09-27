import { isMemoryAccessEnabled, setMemoryAccessEnabled } from '../../agent_runtime/memory-access';
import { invalidateAllRuntimes } from '../../agent_runtime/runtime/runtime';
import { memoryStoreFor, memoryTarget, type Memory } from '../../memory/store';
import type { Feedback } from '../feedback';
import type { CommandMenuEntry, CommandSpec } from '../types';

const USAGE = 'Usage: /memory [on|off|list|forget [global|project] <name>]';

function memoryCommand(mode: string | undefined): Feedback {
  if (mode === undefined) {
    return {
      kind: 'info',
      text: `Memory access is ${isMemoryAccessEnabled() ? 'on' : 'off'}.`,
    };
  }
  if (mode !== 'on' && mode !== 'off') throw new Error(USAGE);

  const enabled = mode === 'on';
  const changed = isMemoryAccessEnabled() !== enabled;
  setMemoryAccessEnabled(enabled);
  // The system prompt changed under every runtime; each starts afresh.
  if (changed) invalidateAllRuntimes();
  return {
    kind: 'success',
    text: `Memory access set to ${mode}.`,
  };
}

// One line of content, cut to fit beside the name.
function gist(memory: Memory, limit = 72): string {
  const line = memory.content.replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

// What the agents can recall from this directory: the global memories and
// the project's own, which is all a session here can see or change.
function listMemories(directory: string): Feedback {
  const memories = memoryStoreFor().list(directory);
  if (memories.length === 0) return { kind: 'info', text: 'No memories saved, globally or for this project.' };
  const section = (scope: Memory['scope'], title: string) => {
    const scoped = memories.filter(memory => memory.scope === scope);
    return scoped.length ? [title, ...scoped.map(memory => `  ${memory.name} · ${gist(memory)}`)] : [];
  };
  return {
    kind: 'info', showIcon: false, panel: true,
    text: [
      ...section('global', 'global'),
      ...section('project', 'this project'),
      '',
      '/memory forget <name> removes one.',
    ].join('\n'),
  };
}

// Deletes one memory by name. The scope may be left out when only one of
// global and this project has a memory of that name.
function forgetMemory(args: readonly string[], directory: string): Feedback {
  const scope = args[0] === 'global' || args[0] === 'project' ? args[0] : undefined;
  const name = (scope ? args.slice(1) : args).join(' ').trim();
  if (!name && memoryStoreFor().list(directory).length === 0) return { kind: 'info', text: 'No memories saved, globally or for this project.' };
  if (!name) throw new Error(USAGE);
  const matches = memoryStoreFor().list(directory).filter(memory => memory.name === name && (!scope || memory.scope === scope));
  if (matches.length === 0) throw new Error(`No memory named "${name}"${scope ? ` in ${scope} scope` : ''}. /memory list shows them.`);
  if (matches.length > 1) throw new Error(`Both a global and a project memory are named "${name}". Say which: /memory forget project ${name}`);
  const [memory] = matches;
  memoryStoreFor().delete(memoryTarget(memory.scope, directory), memory.name);
  return { kind: 'success', text: `Forgot the ${memory.scope === 'global' ? 'global' : 'project'} memory "${memory.name}".` };
}

function memoryMenu(args: readonly string[], directory: string): CommandMenuEntry[] | null {
  if (args.length === 0) {
    const enabled = isMemoryAccessEnabled();
    return [
      { type: 'item', key: 'on', label: 'on', description: 'agents can save and recall memories', command: '/memory on', ...(enabled ? { current: true } : {}) },
      { type: 'item', key: 'off', label: 'off', description: 'agents neither see nor change them; nothing is deleted', command: '/memory off', ...(enabled ? {} : { current: true }) },
      { type: 'item', key: 'list', label: 'list', description: 'show what is remembered, globally and for this project', command: '/memory list' },
      { type: 'item', key: 'forget', label: 'forget', description: 'remove one memory', command: '/memory forget' },
    ];
  }
  if (args.length !== 1 || args[0] !== 'forget') return null;
  const memories = memoryStoreFor().list(directory);
  if (memories.length === 0) return null;
  return memories.map(memory => ({
    type: 'item',
    key: `${memory.scope}:${memory.name}`,
    label: `${memory.scope === 'global' ? 'global' : 'project'} · ${memory.name}`,
    description: gist(memory, 60),
    command: `/memory forget ${memory.scope} ${memory.name}`,
  }));
}

export const memoryCommandSpec: CommandSpec = {
  name: 'memory',
  args: '[on|off|list|forget <name>]',
  description: 'show or set agent access to memory, list memories or forget one',
  run: (args, context) => {
    const directory = context.session.getDirectory();
    if (args[0] === 'list') {
      if (args.length > 1) throw new Error(USAGE);
      return listMemories(directory);
    }
    if (args[0] === 'forget') return forgetMemory(args.slice(1), directory);
    if (args.length > 1) throw new Error(USAGE);
    return memoryCommand(args[0]);
  },
  menu: (args, session) => memoryMenu(args, session.getDirectory()),
};
