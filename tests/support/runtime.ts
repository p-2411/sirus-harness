import {
  boundRuntimes,
  type PromptInput,
  type Runtime,
  type RuntimeOptions,
  type RuntimeUpdate,
} from '../../src/agent_runtime/runtime/runtime';
import type { ContextUsage } from '../../src/agent_runtime/usage';

// One scripted turn: what a vendor would stream for this prompt. Emit updates
// as they would arrive and return when the turn ends; throw to fail it.
export type ScriptedTurn = (
  input: PromptInput,
  emit: (update: RuntimeUpdate) => void,
  options: RuntimeOptions,
  signal: AbortSignal,
) => Promise<void> | void;

export interface ScriptedBinding {
  // Every start of this model's runtime, in order, with the options it got.
  starts: RuntimeOptions[];
  runtimes: ScriptedRuntime[];
}

export interface ScriptedRuntime extends Omit<Runtime, 'context' | 'model'> {
  context: ContextUsage | null;
  model: string;
  disposed: boolean;
  prompts: PromptInput[];
  permissionMode: string;
  thinkingLevel: string;
}

// The turn each model currently runs. Read at prompt time, so rebinding a
// model mid-test also changes what its warm runtimes do next.
const turns = new Map<string, ScriptedTurn>();

// Binds a scripted runtime to a model id so sessions run without an agent
// process. Unbind in afterEach.
export function bindScriptedRuntime(model: string, turn: ScriptedTurn): ScriptedBinding {
  const binding: ScriptedBinding = { starts: [], runtimes: [] };
  turns.set(model, turn);
  boundRuntimes[model] = options => {
    binding.starts.push(options);
    const runtime: ScriptedRuntime = {
      vendor: options.vendor,
      model: options.model,
      modes: [],
      context: null,
      disposed: false,
      prompts: [],
      permissionMode: options.permissionMode,
      thinkingLevel: options.thinkingLevel,
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
        await Promise.race([
          current(input, update => {
            if (update.type === 'context') runtime.context = update.usage;
            options.onUpdate(update);
          }, options, signal),
          aborted,
        ]);
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
      dispose() {
        runtime.disposed = true;
      },
    };
    binding.runtimes.push(runtime);
    return runtime;
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
