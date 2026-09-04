import { createProvider } from '../provider';
import { apiTransport } from './api';
import { subscriptionTransport, codexSubscriptionTransport } from './codex-subscription';

export const OpenAIProvider = createProvider({
  vendor: 'gpt',
  judgeModel: 'gpt-5.6-luna',
  apiKey: { env: 'OPENAI_SECRET', owner: 'OpenAI' },
  api: apiTransport,
  subscription: subscriptionTransport,
  subscriptionFor: codexSubscriptionTransport,
});
