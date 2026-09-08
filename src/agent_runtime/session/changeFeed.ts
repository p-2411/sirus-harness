// The session's notification plumbing: who is listening, the two version
// counters the UI reads, and the throttle that keeps streamed partials from
// re-rendering the transcript on every chunk.

// A provider publishes a partial for every streamed chunk and each one
// re-renders the transcript, so partials reach listeners at most this often
// (the first one immediately) to keep the event loop free for input.
const STREAM_NOTIFY_MS = 50;

export class ChangeFeed {
  private readonly listeners = new Set<() => void>();
  private mutations = 0;
  private assistantMutations = 0;
  private streamNotify: ReturnType<typeof setTimeout> | null = null;
  private lastStreamNotify = 0;

  // Assistant activity is session activity too; the owner of the session
  // clock decides what recording that means.
  constructor(private readonly onAssistantActivity: () => void = () => {}) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // monotonic mutation counter — a cheap referentially-stable snapshot for
  // useSyncExternalStore, since messages is mutated in place
  get version(): number {
    return this.mutations;
  }

  get assistantVersion(): number {
    return this.assistantMutations;
  }

  notify(): void {
    if (this.streamNotify) {
      clearTimeout(this.streamNotify);
      this.streamNotify = null;
    }
    this.lastStreamNotify = Date.now();
    this.mutations++;
    for (const listener of this.listeners) {
      listener();
    }
  }

  notifyAssistantActivity(): void {
    this.assistantMutations++;
    this.onAssistantActivity();
    this.notify();
  }

  notifyStreaming(): void {
    if (this.streamNotify) return;
    const wait = STREAM_NOTIFY_MS - (Date.now() - this.lastStreamNotify);
    if (wait <= 0) {
      this.notifyAssistantActivity();
      return;
    }
    this.streamNotify = setTimeout(() => {
      this.streamNotify = null;
      this.notifyAssistantActivity();
    }, wait);
    this.streamNotify.unref?.();
  }
}
