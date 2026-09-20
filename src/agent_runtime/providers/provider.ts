import { dataDirectory } from '../../dataDirectory';
import type { VendorInfo } from './catalog';
import { login as runLogin, subscriptionDetail as readSubscriptionDetail, type Notify } from './login';
import { createSourceStore, notifyProviderSourceChange, type Source, type SourceStore } from './sources';

// One vendor: its credential list, and which credential each runtime is on.
// Nothing here knows a wire protocol or a model name. The participant walks
// the list and starts runtimes; it reports where each one landed so the
// sidebar can show the source in use.

export interface Provider {
  readonly vendor: VendorInfo;
  readonly sources: SourceStore;
  // What this vendor is reaching for: the source a given runtime is on, the
  // one the most recent runtime started on, or the preferred one before any
  // runtime. This is the row the sidebar shows.
  activeSource(runtimeId?: string): Source | null;
  // The participant calls this when it starts a runtime on a source.
  markActive(runtimeId: string, source: Source): void;
  // And this when that runtime is gone.
  clearActive(runtimeId: string): void;
  login(notify: Notify, signal?: AbortSignal): Promise<string>;
  subscriptionDetail(profile: string, signal?: AbortSignal): Promise<string>;
}

export function createProvider(options: { vendor: VendorInfo }): Provider {
  const { vendor } = options;
  const sources = createSourceStore(vendor);
  // Scoped to the data directory a runtime was started under: a test that
  // points SIRUS_DATA_DIR elsewhere must not see another directory's choice.
  const active = new Map<string, { directory: string; sourceId: string }>();
  let lastRuntime: string | null = null;

  // A change to the list invalidates every per-runtime choice.
  sources.onChange(() => {
    active.clear();
    lastRuntime = null;
  });

  const activeSource = (runtimeId?: string): Source | null => {
    const available = sources.list();
    const id = runtimeId ?? lastRuntime;
    const entry = id ? active.get(id) : undefined;
    const latest = entry && entry.directory === dataDirectory()
      ? available.find(source => source.id === entry.sourceId) : undefined;
    return latest ?? available[0] ?? null;
  };

  return {
    vendor,
    sources,
    activeSource,
    markActive: (runtimeId, source) => {
      const directory = dataDirectory();
      const previous = active.get(runtimeId);
      const changed = lastRuntime !== runtimeId
        || previous?.directory !== directory || previous.sourceId !== source.id;
      active.set(runtimeId, { directory, sourceId: source.id });
      lastRuntime = runtimeId;
      if (changed) notifyProviderSourceChange();
    },
    clearActive: runtimeId => {
      if (!active.delete(runtimeId)) return;
      if (lastRuntime === runtimeId) lastRuntime = null;
      notifyProviderSourceChange();
    },
    login: (notify, signal) => runLogin(vendor.id, sources, notify, signal),
    subscriptionDetail: (profile, signal) => readSubscriptionDetail(vendor.id, profile, signal),
  };
}
