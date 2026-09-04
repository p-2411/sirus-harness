import { AnthropicProvider } from './anthropic/index';
import { OpenAIProvider } from './openai/index';
import type { ModelStrategy } from '../chat';
import { type Provider, type Vendor } from './provider';

export { AnthropicProvider, OpenAIProvider };
export {
  VENDORS,
  parseVendor,
  type ApiKey,
  type AuthStatus,
  type Provider,
  type RequestSource,
  type Vendor,
} from './provider';

const providers: Record<Vendor, Provider> = {
  claude: AnthropicProvider,
  gpt: OpenAIProvider,
};

export const modelStrategies: Record<string, ModelStrategy> = {
  'gpt-5.6-luna': OpenAIProvider,
  'gpt-5.6-terra': OpenAIProvider,
  'gpt-5.6-sol': OpenAIProvider,
  'claude-opus-5': AnthropicProvider,
  'claude-sonnet-5': AnthropicProvider,
  'claude-haiku-4.5': AnthropicProvider,
  'claude-fable-5-1': AnthropicProvider,
};

// The window a model is assumed to have when its provider does not say. The
// direct APIs report token counts but not the window, so these figures drive
// the context gauge on that path; a subscription runtime's own figure wins.
const ASSUMED_CONTEXT_WINDOWS: Record<Vendor, number> = {
  claude: 200_000,
  gpt: 400_000,
};

export function contextWindowFor(model: string): number | undefined {
  const strategy = modelStrategies[model];
  const vendor = (Object.keys(providers) as Vendor[]).find(candidate => providers[candidate] === strategy);
  return vendor ? ASSUMED_CONTEXT_WINDOWS[vendor] : undefined;
}

export function resolveStrategy(model: string): ModelStrategy {
  const strategy = modelStrategies[model];
  if (!strategy) {
    throw new Error(`Model strategy not found for model: ${model}`);
  }
  return strategy;
}

export function providerFor(vendor: Vendor): Provider {
  return providers[vendor];
}

export function modelsFor(vendor: Vendor): string[] {
  const provider = providerFor(vendor);
  return Object.entries(modelStrategies)
    .filter(([, strategy]) => strategy === provider)
    .map(([model]) => model);
}

// After a change that every provider-side conversation has baked in, such as
// the system prompt: every agent starts afresh on its next turn.
export function resetAllRuntimes(): void {
  for (const provider of Object.values(providers)) provider.resetAllRuntimes?.();
}
