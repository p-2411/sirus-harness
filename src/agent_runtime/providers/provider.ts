import { createHash } from 'crypto';
import { dataDirectory } from '../../dataDirectory';
import type { Message, MessageBlock, ToolResultBlock, Usage } from '../types';
import type { TurnContext } from '../turn';
import type { VendorInfo } from './catalog';
import { runWithFallback, type FallbackAttempt } from './fallback';
import { login as runLogin, subscriptionDetail as readSubscriptionDetail, type Notify } from './login';
import { createSourceStore, notifyProviderSourceChange, type Source, type SourceStore } from './sources';

// One request path bound to one credential. Everything above a transport —
// the source list, the fallback loop, the registry — is vendor-agnostic; a
// transport is the only place that knows a vendor's wire protocol.

export interface Response {
  content: MessageBlock[];
  stop_reason: 'end_turn' | 'tool_use';
  continueWithToolResults?: (toolResults: readonly ToolResultBlock[]) => Promise<Response>;
  // The tokens this response cost, when the provider reports them. A
  // transport that ran the whole turn itself reports the turn's total.
  usage?: Usage;
}

export interface Transport {
  // 'host': the transport returns tool_use and the host runs the tools through
  // turn.toolbox, then calls the continuation.
  // 'delegated': the transport runs the host's tools itself through
  // turn.toolbox and never returns tool_use. Work it completed before a
  // failure has really happened, which is what the fallback loop must carry
  // into a retry rather than repeat.
  readonly toolExecution: 'host' | 'delegated';
  getResponse: (messages: readonly Message[], turn: TurnContext) => Promise<Response>;
  // Transports that keep state per agent runtime drop it here.
  resetRuntime?: (runtimeId: string) => void;
  resetAllRuntimes?: () => void;
  dispose?: () => void;
}

// One vendor, composed: its credential list, one transport per credential,
// and the fallback policy over them. Nothing here knows a wire protocol or a
// model name.

export interface Provider {
  readonly vendor: VendorInfo;
  getResponse: (messages: readonly Message[], turn: TurnContext) => Promise<Response>;
  readonly sources: SourceStore;
  // What this vendor is reaching for: the source a given agent runtime is
  // using, the one the most recent request started on, or the preferred one
  // before any request. This is the row the sidebar shows.
  activeSource: (runtimeId?: string) => Source | null;
  login: (notify: Notify, signal?: AbortSignal) => Promise<string>;
  subscriptionDetail: (profile: string, signal?: AbortSignal) => Promise<string>;
  resetRuntime: (runtimeId: string) => void;
  resetAllRuntimes: () => void;
  dispose: () => void;
}

export interface ProviderOptions {
  vendor: VendorInfo;
  // The API transport is handed the key lookup rather than finding the key
  // itself, so it knows nothing about vendors or storage.
  api: (requireApiKey: () => string) => Transport;
  subscriptionFor: (profile: string) => Transport;
  // Vendor-wide teardown beyond the transports this provider built, for a
  // vendor whose runtimes are shared process-wide.
  dispose?: () => void;
}

// A cache key that identifies the credential without carrying it.
function fingerprint(source: Source): string {
  return source.kind === 'api'
    ? createHash('sha256').update(source.key).digest('hex').slice(0, 16)
    : source.profile;
}

export function createProvider(options: ProviderOptions): Provider {
  const { vendor } = options;
  const sources = createSourceStore(vendor);
  const transports = new Map<string, { sourceId: string; directory: string; transport: Transport }>();
  // A successful source stays first for the rest of that agent's runtime.
  const sticky = new Map<string, string>();
  const active = new Map<string, { directory: string; sourceId: string }>();
  let lastRuntime: string | null = null;

  const transportFor = (source: Source): Transport => {
    const directory = dataDirectory();
    const key = `${directory}|${source.id}|${fingerprint(source)}`;
    let entry = transports.get(key);
    if (!entry) {
      // Capture the key in this transport; concurrent turns cannot swap
      // credentials underneath each other.
      const transport = source.kind === 'api'
        ? options.api(() => source.key)
        : options.subscriptionFor(source.profile);
      entry = { sourceId: source.id, directory, transport };
      transports.set(key, entry);
    }
    return entry.transport;
  };

  const release = (transport: Transport): void => {
    if (transport.dispose) transport.dispose();
    else transport.resetAllRuntimes?.();
  };

  // A change to the list invalidates every per-runtime choice, and retires the
  // transports of sources that are gone.
  sources.onChange(() => {
    sticky.clear();
    active.clear();
    lastRuntime = null;
    const live = new Set(sources.list().map(source => source.id));
    const directory = dataDirectory();
    for (const [key, entry] of transports) {
      if (live.has(entry.sourceId) && entry.directory === directory) continue;
      transports.delete(key);
      release(entry.transport);
    }
  });

  const activeSource = (runtimeId?: string): Source | null => {
    const available = sources.list();
    const id = runtimeId ?? lastRuntime;
    const entry = id ? active.get(id) : undefined;
    const latest = entry && entry.directory === dataDirectory()
      ? available.find(source => source.id === entry.sourceId) : undefined;
    return latest ?? available[0] ?? null;
  };

  const markActive = (runtimeId: string, source: Source): void => {
    const directory = dataDirectory();
    const previous = active.get(runtimeId);
    const changed = lastRuntime !== runtimeId
      || previous?.directory !== directory || previous.sourceId !== source.id;
    active.set(runtimeId, { directory, sourceId: source.id });
    lastRuntime = runtimeId;
    if (changed) notifyProviderSourceChange();
  };

  return {
    vendor,
    sources,
    activeSource,
    getResponse: (messages, turn) => {
      const attempts: FallbackAttempt[] = sources.list()
        .map(source => ({ source, transport: transportFor(source) }));
      return runWithFallback({
        attempts,
        messages,
        turn,
        sticky,
        owner: vendor.displayName,
        onSourceUsed: source => markActive(turn.agent.runtimeId, source),
      });
    },
    login: (notify, signal) => runLogin(vendor.id, sources, notify, signal),
    subscriptionDetail: (profile, signal) => readSubscriptionDetail(vendor.id, profile, signal),
    resetRuntime: runtimeId => {
      sticky.delete(runtimeId);
      if (active.delete(runtimeId)) {
        if (lastRuntime === runtimeId) lastRuntime = null;
        notifyProviderSourceChange();
      }
      for (const entry of transports.values()) entry.transport.resetRuntime?.(runtimeId);
    },
    resetAllRuntimes: () => {
      sticky.clear();
      active.clear();
      lastRuntime = null;
      notifyProviderSourceChange();
      for (const entry of transports.values()) entry.transport.resetAllRuntimes?.();
      transports.clear();
    },
    dispose: () => {
      sticky.clear();
      active.clear();
      lastRuntime = null;
      for (const entry of transports.values()) release(entry.transport);
      transports.clear();
      options.dispose?.();
    },
  };
}
