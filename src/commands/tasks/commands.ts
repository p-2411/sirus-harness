import type { CommandSession, CommandSpec } from '../types';

function findTask(participant: string, id: string, session: CommandSession) {
  const task = session.getBackgroundTasks().find(task =>
    task.participant.toLowerCase() === participant.replace(/^@/, '').toLowerCase() && task.id === id);
  if (!task) throw new Error(`No background task ${id} for ${participant}. /tasks lists them.`);
  return task;
}

export const tasksCommandSpec: CommandSpec = {
  name: 'tasks',
  args: '[stop] @participant <id>',
  description: 'show or stop background shells',
  run: async (args, { session }) => {
    if (args.length === 0) {
      const tasks = session.getBackgroundTasks();
      if (tasks.length === 0) return { kind: 'info', text: 'No background tasks in this session.' };
      return {
        kind: 'info', panel: true, showIcon: false,
        text: tasks.map(task => `@${task.participant} · ${task.id} · ${task.state} · ${task.name}`).join('\n'),
      };
    }
    const stop = args[0] === 'stop';
    if (args.length !== (stop ? 3 : 2)) throw new Error('Usage: /tasks [stop] @participant <id>');
    const task = findTask(args[stop ? 1 : 0], args[stop ? 2 : 1], session);
    if (!stop) {
      return {
        kind: 'info', panel: true, showIcon: false,
        text: [
          `@${task.participant} · ${task.id} · ${task.state}`,
          task.name,
          task.description !== task.name ? task.description : undefined,
          task.summary,
          task.outputFilePath ? `Output: ${task.outputFilePath}` : undefined,
          task.canStop ? `Stop: /tasks stop @${task.participant} ${task.id}` : undefined,
        ].filter(Boolean).join('\n'),
      };
    }
    if (!task.canStop) return { kind: 'info', text: `${task.id} is ${task.state} and cannot be stopped.` };
    const stopped = await session.stopBackgroundTask(task.participant, task.id);
    return stopped
      ? { kind: 'success', text: `Stopped ${task.id} for @${task.participant}.` }
      : { kind: 'info', text: `${task.id} could not be stopped; it may have already finished.` };
  },
  menu: (args, session) => {
    if (args.length === 0) {
      const tasks = session.getBackgroundTasks();
      if (tasks.length === 0) return null;
      return tasks.map(task => ({
        type: 'item', key: `${task.participant}:${task.id}`,
        label: `@${task.participant} · ${task.id} · ${task.state}`,
        description: task.name, command: `/tasks @${task.participant} ${task.id}`,
      }));
    }
    if (args.length !== 2 || args[0] === 'stop') return null;
    const task = findTask(args[0], args[1], session);
    if (!task.canStop) return null;
    return [{
      type: 'item', key: 'stop', label: 'Stop background task', description: task.name,
      command: `/tasks stop @${task.participant} ${task.id}`,
    }];
  },
};
