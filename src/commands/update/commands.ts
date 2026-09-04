import { updateCommand } from './behavior';
import type { CommandSpec } from '../types';

export const updateCommandSpec: CommandSpec = {
  name: 'update',
  description: 'install the latest published Sirus release',
  run: (args, execution) => {
    if (args.length > 0) throw new Error('Usage: /update');
    return updateCommand(execution.notify, execution.signal);
  },
};
