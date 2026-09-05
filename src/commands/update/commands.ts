import { updateCommand } from './behavior';
import { SIRUS_VERSION } from '../../version';
import type { CommandSpec } from '../types';

export const updateCommandSpec: CommandSpec = {
  name: 'update',
  description: 'install the latest release',
  run: (args, execution) => {
    if (args.length > 0) throw new Error('Usage: /update');
    return updateCommand(execution.notify, execution.signal);
  },
};

export const versionCommandSpec: CommandSpec = {
  name: 'version',
  description: 'show the installed version',
  run: args => {
    if (args.length > 0) throw new Error('Usage: /version');
    return { kind: 'info', text: `sirus ${SIRUS_VERSION}`, showIcon: false };
  },
};
