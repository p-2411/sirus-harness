import type { Notify } from '../../agent_runtime/providers/login';
import { updateSirus } from '../../updater';
import type { Feedback } from '../feedback';

export async function updateCommand(notify: Notify, signal?: AbortSignal): Promise<Feedback> {
  const result = await updateSirus(notify, signal);
  return result.updated
    ? {
      kind: 'success',
      text: `Updated Sirus ${result.currentVersion} → ${result.latestVersion}. Restart Sirus to use the new version.`,
    }
    : {
      kind: 'info',
      text: `Sirus is already up to date (${result.currentVersion}).`,
    };
}
