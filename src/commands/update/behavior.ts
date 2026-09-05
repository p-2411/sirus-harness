import type { Notify } from '../../agent_runtime/providers/login';
import { updateSirus } from '../../updater';
import type { Feedback } from '../feedback';

export async function updateCommand(notify: Notify, signal?: AbortSignal): Promise<Feedback> {
  const result = await updateSirus(notify, signal);
  return result.updated
    ? { kind: 'success', text: `Updated ${result.currentVersion} → ${result.latestVersion}. Restart to use it.` }
    : { kind: 'info', text: `Up to date (${result.currentVersion}).` };
}
