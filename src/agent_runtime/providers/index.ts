import type { Message } from '../types';
import type { TurnContext } from '../turn';
import { AnthropicProvider } from './anthropic/index';
import { OpenAIProvider } from './openai/index';
import { VENDORS, isKnownModel, modelIds, vendorOf, type Vendor } from './catalog';
import type { Provider, Response, Transport } from './provider';
import { onProviderSourceChange } from './sources';

// Which provider answers for a model, and the handful of process-wide
// operations that apply to all of them. The catalog (`catalog.ts`), the
// credential list (`sources.ts`) and one vendor's composition (`provider.ts`)
// are imported directly by their consumers; only the registry lives here.

const providers: Record<Vendor, Provider> = {
  claude: AnthropicProvider,
  gpt: OpenAIProvider,
};

// What a turn needs from whatever serves its model.
export interface ModelRunner {
  getResponse: (messages: readonly Message[], turn: TurnContext) => Promise<Response>;
  resetRuntime: (runtimeId: string) => void;
}

// A transport bound directly to a model id, bypassing the catalog and its
// vendor. Nothing in the app binds one; the test suite binds scripted
// transports here so the agent loop can run without a network.
export interface ModelBinding {
  getResponse: Transport['getResponse'];
  resetRuntime?: (runtimeId: string) => void;
}

export const boundTransports: Record<string, ModelBinding> = {};

export function providerFor(vendor: Vendor): Provider {
  return providers[vendor];
}

export function allProviders(): Provider[] {
  return VENDORS.map(vendor => providers[vendor]);
}

// Every model this process can actually run: the catalog's, plus anything
// bound above.
export function servesModel(model: string): boolean {
  return isKnownModel(model) || model in boundTransports;
}

export function servableModelIds(): string[] {
  return [...modelIds(), ...Object.keys(boundTransports)];
}

export function providerForModel(model: string): ModelRunner {
  // The catalog wins: a real model always resolves to its vendor, so a test
  // binding can only serve a model id the catalog does not know.
  const vendor = vendorOf(model);
  if (vendor) return providers[vendor];
  const bound = boundTransports[model];
  if (bound) {
    return {
      getResponse: bound.getResponse,
      resetRuntime: runtimeId => bound.resetRuntime?.(runtimeId),
    };
  }
  throw new Error(`No provider serves model: ${model}`);
}

export const onProviderChange = onProviderSourceChange;

// After a change every provider-side conversation has baked in, such as the
// system prompt: every agent starts afresh on its next turn.
export function resetAllRuntimes(): void {
  for (const provider of allProviders()) provider.resetAllRuntimes();
}

// Provider subprocesses outlive individual turns; this is the one call that
// tears every one of them down.
export function disposeAll(): void {
  for (const provider of allProviders()) provider.dispose();
}
