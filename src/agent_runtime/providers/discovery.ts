import { dataDirectory } from '../../dataDirectory';
import { isAbortError } from '../../abort';
import { allProviders } from './index';
import { modelsOf, rememberListedModels } from './catalog';
import { sourceEnvironment } from './profiles';
import { createRuntime } from '../runtime/runtime';

// A vendor that has never been selected still needs to populate the picker.
// Successful lists live in the catalog. Failed or empty probes may be retried
// after a short, capped delay, without repeatedly launching an offline adapter.
const retry = new Map<string, { failures: number; after: number }>();
const inFlight = new Set<string>();
const MAX_RETRY_DELAY_MS = 60_000;

export async function discoverMissingModels(directory: string): Promise<boolean> {
  const results = await Promise.all(allProviders().map(async provider => {
    const vendor = provider.vendor.id;
    if (modelsOf(vendor).length > 0) return false;
    for (const source of provider.sources.list()) {
      const key = JSON.stringify([dataDirectory(), vendor, source]);
      if (inFlight.has(key) || (retry.get(key)?.after ?? 0) > Date.now()) continue;
      inFlight.add(key);
      let discovered = false;
      let runtime;
      const signal = AbortSignal.timeout(15_000);
      try {
        try {
          runtime = await createRuntime({
            vendor, model: '', thinkingLevel: 'low', directory,
            signal,
            systemPrompt: '', env: sourceEnvironment(vendor, source),
            mcpServer: null, bare: true, discoverModelsOnly: true,
            permissionMode: 'ask',
            onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
            onUpdate: update => {
              if (update.type === 'models' && update.models.length > 0) {
                rememberListedModels(vendor, update.models);
                discovered = true;
              }
            },
          });
        } catch (error) {
          // An abort independent of this probe's timeout is shutdown. A
          // timed-out adapter can recover after backoff or via another source.
          if (isAbortError(error) && !signal.aborted) return false;
          // A failed connection contributes no invented models. Another
          // credential may work; ordinary turns report connection failures.
        } finally {
          runtime?.dispose();
        }
        if (discovered) {
          retry.delete(key);
          return true;
        }
        const failures = (retry.get(key)?.failures ?? 0) + 1;
        retry.set(key, { failures, after: Date.now() + Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** Math.min(failures - 1, 6)) });
      } finally {
        inFlight.delete(key);
      }
    }
    return false;
  }));
  return results.some(Boolean);
}
