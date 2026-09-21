import {
  boundRuntimes,
  type ForkOptions,
  type PromptInput,
  type Runtime,
  type RuntimeOptions,
  type RuntimeUpdate,
} from '../../src/agent_runtime/runtime/runtime';
import type { ContextUsage } from '../../src/agent_runtime/usage';

// One scripted turn: what a vendor would stream for this prompt. Emit updates
// as they would arrive and return when the turn ends; throw to fail it. The
// runtime running the turn is the last argument, so a turn can watch itself
// being steered (see `onSteer`).
export type ScriptedTurn = (
  input: PromptInput,
  emit: (update: RuntimeUpdate) => void,
  options: RuntimeOptions,
  signal: AbortSignal,
  runtime: ScriptedRuntime,
) => Promise<void> | void;

export interface ScriptedBinding {
  // Every start of this model's runtime, in order, with the options it got.
  starts: RuntimeOptions[];
  // Every fork taken of one of them, in order, with the options it got. The
  // forked runtime itself is the matching entry appended to `runtimes`.
  forks: ForkOptions[];
  runtimes: ScriptedRuntime[];
}

export interface ScriptedRuntime extends Omit<Runtime, 'context' | 'model' | 'fork'> {
  context: ContextUsage | null;
  model: string;
  disposed: boolean;
  prompts: PromptInput[];
  permissionMode: string;
  thinkingLevel: string;
  // Every text `steer` took, in order.
  steers: string[];
  // Called by `steer` while the prompt is still running, so a scripted turn
  // can react to being steered: set it from inside the turn, on the runtime
  // the turn was handed, and emit whatever the vendor would have folded into
  // its output.
  onSteer?: (text: string) => void;
  // A fork runs the same scripted turn as the runtime it came from, but with
  // the fork's options laid over that runtime's, so a test can tell a worker
  // by its `systemPrompt` or `mcpServer`. Untracked, like the real one.
  fork(options: ForkOptions): Promise<ScriptedRuntime>;
}

// The turn each model currently runs. Read at prompt time, so rebinding a
// model mid-test also changes what its warm runtimes do next.
const turns = new Map<string, ScriptedTurn>();

// One runtime of the bound model: the one the session started, or one forked
// from it. A fork differs only in the options it answers from.
function scriptedRuntime(model: string, options: RuntimeOptions, binding: ScriptedBinding): ScriptedRuntime {
  // Whether a prompt is in flight, which is all `steer` needs to know.
  let running = false;
  const runtime: ScriptedRuntime = {
    vendor: options.vendor,
    model: options.model,
    modes: [],
    context: null,
    disposed: false,
    prompts: [],
    permissionMode: options.permissionMode,
    thinkingLevel: options.thinkingLevel,
    steers: [],
    async prompt(input, signal) {
      runtime.prompts.push(input);
      if (signal.aborted) throw signal.reason;
      // Like the ACP client: the turn is over the moment the signal fires,
      // whatever the scripted turn is still waiting on.
      const aborted = new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      const current = turns.get(model);
      if (!current) throw new Error(`No scripted turn bound for ${model}`);
      running = true;
      try {
        await Promise.race([
          current(input, update => {
            if (update.type === 'context') runtime.context = update.usage;
            options.onUpdate(update);
          }, options, signal, runtime),
          aborted,
        ]);
      } finally {
        running = false;
      }
      if (signal.aborted) throw signal.reason;
      return { stopReason: 'end_turn' };
    },
    async setPermissionMode(mode) {
      runtime.permissionMode = mode;
      return { modeId: mode, kind: null };
    },
    async setModel(model) {
      runtime.model = model;
      return true;
    },
    async setThinkingLevel(level) {
      runtime.thinkingLevel = level;
    },
    async fork(forked) {
      if (runtime.disposed) throw new Error(`The scripted ${model} runtime was disposed`);
      binding.forks.push(forked);
      return scriptedRuntime(model, { ...options, ...forked }, binding);
    },
    async steer(text) {
      if (runtime.disposed) throw new Error(`The scripted ${model} runtime was disposed`);
      if (!running) throw new Error(`The scripted ${model} runtime is not running a prompt`);
      runtime.steers.push(text);
      runtime.onSteer?.(text);
    },
    dispose() {
      runtime.disposed = true;
    },
  };
  binding.runtimes.push(runtime);
  return runtime;
}

// Binds a scripted runtime to a model id so sessions run without an agent
// process. Unbind in afterEach.
export function bindScriptedRuntime(model: string, turn: ScriptedTurn): ScriptedBinding {
  const binding: ScriptedBinding = { starts: [], forks: [], runtimes: [] };
  turns.set(model, turn);
  boundRuntimes[model] = options => {
    binding.starts.push(options);
    return scriptedRuntime(model, options, binding);
  };
  return binding;
}

export function unbindRuntime(model: string): void {
  delete boundRuntimes[model];
  turns.delete(model);
}

// A turn that says one thing.
export function textTurn(text: string): ScriptedTurn {
  return (_input, emit) => { emit({ type: 'text', text }); };
}
