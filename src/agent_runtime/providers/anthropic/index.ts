import { createProvider } from '../provider';
import { apiTransport } from './api';
import { subscriptionTransport, claudeSubscriptionTransport } from './claude-subscription';

export const AnthropicProvider = createProvider({
  vendor: 'claude',
  judgeModel: 'claude-haiku-4.5',
  apiKey: { env: 'ANTHROPIC_API', owner: 'Anthropic' },
  api: apiTransport,
  subscription: subscriptionTransport,
  subscriptionFor: claudeSubscriptionTransport,
});
