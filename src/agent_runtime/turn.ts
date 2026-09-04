import { TurnCancelledError } from '../abort';
import type { SessionAgent } from './agent';
import type { PermissionContext } from './permissions/permissions';
import type { Message, MessageBlock } from './types';

export interface TurnOptions {
  // Where the turn runs: the session's directory, or the owner's for a
  // subagent. Tools and provider prompts are rooted here.
  directory: string;
  // An outer signal the turn follows: when it aborts, the turn aborts. The
  // turn's own signal is what providers and tools watch.
  signal?: AbortSignal;
  // A host-generated user turn used when another participant mentioned this
  // agent. It is sent to the provider but is not persisted in chat history.
  turnPrompt?: string;
  // The gate every tool call of this turn goes through. Absent only for
  // direct programmatic callers (tests); every session and subagent run
  // passes one.
  permissions?: PermissionContext;
  // This system prompt instead of Sirus's, for one-shot questions such as
  // the permission judge.
  systemPrompt?: string;
  // Whether the model may call tools. Off for one-shot questions.
  tools?: boolean;
}

// The state of one agent's turn: who is speaking, how to stop it, and the
// assistant message as it stands right now. The provider writes the request
// it has in flight, the agent loop files finished rounds and tool results,
// and anyone may read the combined content at any time or wait on changes().
//
// One signal owns the complete turn, including every provider continuation
// and every host-side tool it starts. It fires when the outer signal does,
// when cancel() is called, or when the consumer of changes() walks away.
export class TurnContext {
  readonly agent: SessionAgent;
  readonly directory: string;
  readonly signal: AbortSignal;
  readonly turnPrompt?: string;
  readonly permissions?: PermissionContext;
  readonly systemPrompt?: string;
  readonly tools: boolean;
  // Settles with the completed message, or with whatever ended the turn.
  readonly result: Promise<Message>;

  // Rounds that are over: earlier provider responses and tool results.
  private committed: MessageBlock[] = [];
  // The provider request in flight, replaced wholesale on every update.
  private live: readonly MessageBlock[] = [];
  private settled = false;
  private changed = false;
  private wake: (() => void) | null = null;
  private resolveResult!: (message: Message) => void;
  private rejectResult!: (error: unknown) => void;
  private readonly controller = new AbortController();
  private unfollow: (() => void) | null = null;

  constructor(agent: SessionAgent, options: TurnOptions) {
    this.agent = agent;
    this.directory = options.directory;
    this.signal = this.controller.signal;
    if (options.signal) this.follow(options.signal);
    if (options.turnPrompt) this.turnPrompt = options.turnPrompt;
    if (options.permissions) this.permissions = options.permissions;
    if (options.systemPrompt) this.systemPrompt = options.systemPrompt;
    this.tools = options.tools ?? true;
    this.result = new Promise<Message>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    // Callers that await the agent loop directly see its error there; the
    // promise here must not also surface as an unhandled rejection.
    this.result.catch(() => {});
  }

  get content(): MessageBlock[] {
    return [...this.committed, ...this.live];
  }

  get message(): Message {
    return { role: 'assistant', content: this.content };
  }

  get done(): boolean {
    return this.settled;
  }

  // Provider: the current request looks like this now. Each call carries the
  // complete request so far, so a skipped call loses nothing.
  updateStream(content: readonly MessageBlock[]): void {
    if (this.settled || this.signal.aborted) return;
    this.live = [...content];
    this.notify();
  }

  // Agent loop: these blocks are final. The in-flight request is folded in.
  commit(blocks: readonly MessageBlock[]): void {
    if (this.settled) return;
    this.committed.push(...blocks);
    this.live = [];
    this.notify();
  }

  finish(): Message {
    const message = this.message;
    if (this.settled) return message;
    this.settle();
    this.resolveResult(message);
    return message;
  }

  fail(error: unknown): void {
    if (this.settled) return;
    this.settle();
    this.rejectResult(error);
  }

  // Stops the turn: the provider request, any running tool, and the loop
  // between them all see the signal. The loop then settles result with it.
  cancel(reason: Error = new TurnCancelledError()): void {
    if (this.settled || this.signal.aborted) return;
    this.controller.abort(reason);
  }

  // Yields the latest snapshot whenever the turn has changed since the last
  // pull, then ends once the turn is settled. Latest-wins: several writes
  // between two pulls surface as one snapshot. Meant for a single consumer.
  //
  // A consumer that stops iterating before the turn is over no longer wants
  // its output, so leaving the loop early cancels the turn.
  async *changes(): AsyncGenerator<Message, void, undefined> {
    try {
      while (true) {
        if (this.changed) {
          this.changed = false;
          yield this.message;
          continue;
        }
        if (this.settled) return;
        await new Promise<void>(resolve => { this.wake = resolve; });
      }
    } finally {
      if (!this.settled) this.cancel();
    }
  }

  private follow(outer: AbortSignal): void {
    if (outer.aborted) {
      this.controller.abort(outer.reason);
      return;
    }
    const onAbort = () => this.controller.abort(outer.reason);
    outer.addEventListener('abort', onAbort, { once: true });
    this.unfollow = () => outer.removeEventListener('abort', onAbort);
  }

  private settle(): void {
    this.settled = true;
    this.unfollow?.();
    this.unfollow = null;
    this.wake?.();
    this.wake = null;
  }

  private notify(): void {
    this.changed = true;
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}
