import { updateSirus } from '../../updater';
import { SIRUS_VERSION } from '../../version';
import type { Feedback } from '../feedback';
import type { CommandSpec, Notify } from '../types';

async function updateCommand(notify: Notify, signal?: AbortSignal): Promise<Feedback> {
  const result = await updateSirus(notify, signal);
  return result.updated
    ? { kind: 'success', text: `Updated ${result.currentVersion} → ${result.latestVersion}. Restart to use it.` }
    : { kind: 'info', text: `Up to date (${result.currentVersion}).` };
}

export const updateCommandSpec: CommandSpec = {
  name: 'update',
  description: 'install the latest release',
  run: (args, context) => {
    if (args.length > 0) throw new Error('Usage: /update');
    return updateCommand(context.notify, context.signal);
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
