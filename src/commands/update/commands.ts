import { updateSirus } from '../../updater';
import { SIRUS_VERSION } from '../../version';
import type { Feedback } from '../feedback';
import type { Notify } from '../../agent_runtime/providers/login';
import type { CommandSpec } from '../types';

async function updateCommand(notify: Notify, signal?: AbortSignal): Promise<Feedback> {
  const result = await updateSirus(notify, signal);
  return result.updated
    ? { kind: 'success', text: `Updated ${result.currentVersion} → ${result.latestVersion}. Restart to use it.` }
    : { kind: 'info', text: `Up to date (${result.currentVersion}).` };
}

export const updateCommandSpec: CommandSpec = {
  name: 'update',
  description: 'install the latest release',
  run: (_args, context) => updateCommand(context.notify, context.signal),
};

export const versionCommandSpec: CommandSpec = {
  name: 'version',
  description: 'show the installed version',
  run: () => ({ kind: 'info', text: `sirus ${SIRUS_VERSION}`, showIcon: false }),
};
