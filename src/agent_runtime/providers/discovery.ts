import { dataDirectory } from '../../dataDirectory';
import { isAbortError } from '../../abort';
import { allProviders } from './index';
import { modelsOf, rememberListedModels } from './catalog';
import { sourceEnvironment } from './profiles';
import { createRuntime } from '../runtime/runtime';

// A vendor that has never been selected still needs to populate the picker.
// Probe connected vendors once per credential in this process; normal agent
// sessions keep refreshing their cached lists afterwards.
const attempted = new Set<string>();

export async function discoverMissingModels(directory: string): Promise<boolean> {
  const results = await Promise.all(allProviders().map(async provider => {
    const vendor = provider.vendor.id;
    if (modelsOf(vendor).length > 0) return false;
    for (const source of provider.sources.list()) {
      const key = JSON.stringify([dataDirectory(), vendor, source]);
      if (attempted.has(key)) continue;
      attempted.add(key);
      let discovered = false;
      let runtime;
      try {
        runtime = await createRuntime({
          vendor, model: '', thinkingLevel: 'low', directory,
          signal: AbortSignal.timeout(15_000),
          systemPrompt: '', env: sourceEnvironment(vendor, source),
          mcpServer: null, bare: true, discoverModelsOnly: true,
          permissionMode: 'ask',
          onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
          onUpdate: update => {
            if (update.type === 'models') {
              rememberListedModels(vendor, update.models);
              discovered = true;
            }
          },
        });
      } catch (error) {
        // Shutdown must not start another credential's adapter as a fallback.
        if (isAbortError(error)) return false;
        // A failed connection contributes no invented models. Another
        // credential may work; ordinary turns report connection failures.
      } finally {
        runtime?.dispose();
      }
      if (discovered) return true;
    }
    return false;
  }));
  return results.some(Boolean);
}
