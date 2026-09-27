import { compactCommand, permissionsCommand, permissionsMenuItems, renameSession } from './behavior';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { textOf } from '../../agent_runtime/types';
import { generateSessionName } from '../../agent_runtime/session/naming';
import type { CommandSpec } from '../types';

export const clearCommand: CommandSpec = {
  name: 'clear',
  description: 'start a new session, keeping this conversation',
  run: (_args, context) => {
    if (!context.newSession) throw new Error('/clear is not available here.');
    context.newSession();
  },
};

export const compactCommandSpec: CommandSpec = {
  name: 'compact',
  description: 'ask the agent to compact its context now',
  run: (args, context) => {
    if (args.length > 0) throw new Error('Usage: /compact');
    return compactCommand(context.session, context.signal);
  },
};

export const renameCommand: CommandSpec = {
  name: 'rename',
  args: '[name]',
  description: 'rename this session',
  run: (args, context) => {
    if (args.length) return renameSession(args.join(' '), context.session);
    return (async () => {
      const content = context.session.getMessages().filter(message => !message.hidden)
        .map(message => `${message.role}: ${textOf(message)}`).join('\n').slice(0, 12000);
      if (!content.trim()) throw new Error('Send a message first, or use /rename <name>.');
      const name = await generateSessionName(content, context.session.getDirectory(), context.session.getModel(), context.signal);
      const fallback = context.session.getMessages().find(message => message.role === 'user');
      return renameSession(name ?? textOf(fallback ?? { content: [] }).replace(/\s+/g, ' ').slice(0, 40), context.session);
    })();
  },
};

export const exitCommand: CommandSpec = {
  name: 'exit',
  description: 'quit sirus',
  // Only a caller that owns the app can quit it.
  run: (args, context) => {
    if (args.length > 0) throw new Error('Usage: /exit');
    if (!context.exit) throw new Error('/exit is not available here.');
    context.exit();
  },
};

export const quitCommand: CommandSpec = {
  ...exitCommand,
  name: 'quit',
  run: (args, context) => {
    if (args.length > 0) throw new Error('Usage: /quit');
    return exitCommand.run(args, context);
  },
};

export const permissionsCommandSpec: CommandSpec = {
  name: 'permissions',
  args: '[ask|auto|bypass]',
  description: 'show or set how tool calls are approved',
  run: (args, context) => permissionsCommand(args[0], context.session),
  menu: args => args.length === 0 ? permissionsMenuItems() : null,
};

export const newCommand: CommandSpec = { ...clearCommand, name: 'new' };

export const resumeCommand: CommandSpec = {
  name: 'resume', args: '[query]', description: 'search and resume a saved session',
  run: (args, context) => {
    if (!context.resumeSession) throw new Error('/resume is not available here.');
    context.resumeSession(args.join(' '));
  },
};

export const archiveCommand: CommandSpec = {
  name: 'archive', description: 'hide this session from the sidebar; recover with /resume',
  run: (_args, context) => {
    if (!context.archiveSession) throw new Error('/archive is not available here.');
    context.archiveSession();
  },
};

export const deleteCommand: CommandSpec = {
  name: 'delete', description: 'delete this session after confirmation',
  run: async (_args, context) => {
    if (!context.deleteSession || !context.confirm) throw new Error('/delete is not available here.');
    if (await context.confirm(`Delete “${context.session.getName()}”? This cannot be undone.`)) context.deleteSession();
  },
};

export const forkCommand: CommandSpec = {
  name: 'fork', description: 'continue a copy of this conversation',
  run: (_args, context) => {
    if (!context.openSession) throw new Error('/fork is not available here.');
    context.openSession(context.session.fork());
  },
};

export const exportCommand: CommandSpec = {
  name: 'export', args: '[path]', description: 'save this conversation as Markdown',
  run: (args, context) => {
    const session = context.session;
    const path = resolve(session.getDirectory(), args.join(' ') || `sirus-${Date.now()}.md`);
    const messages = session.getMessages().filter(message => !message.hidden);
    const body = messages.map(message => `## ${message.role === 'user' ? 'You' : message.participant ?? 'Assistant'}\n\n${textOf(message)}`).join('\n\n');
    writeFileSync(path, `# ${session.getName()}\n\n${body}\n`, { flag: 'wx' });
    return { kind: 'success', text: `Exported to ${path}.` };
  },
};

export const copyCommand: CommandSpec = {
  name: 'copy', description: 'copy the last reply to the clipboard',
  run: (_args, context) => {
    if (!context.copy) throw new Error('/copy is not available here.');
    const reply = context.session.getMessages().slice().reverse().find(message => message.role === 'assistant' && !message.hidden && textOf(message).trim());
    if (!reply) throw new Error('There is no reply to copy yet.');
    context.copy(textOf(reply));
    return { kind: 'success', text: 'Copied the last reply.' };
  },
};
