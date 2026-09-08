import { VENDOR_INFO } from '../catalog';
import { createProvider } from '../provider';
import { apiTransport } from './api';
import { claudeSubscriptionTransport, disposeClaudeRuntimes } from './claude-subscription';

export const AnthropicProvider = createProvider({
  vendor: VENDOR_INFO.claude,
  api: apiTransport,
  subscriptionFor: claudeSubscriptionTransport,
  dispose: disposeClaudeRuntimes,
});
