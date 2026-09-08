import { VENDOR_INFO } from '../catalog';
import { createProvider } from '../provider';
import { apiTransport } from './api';
import { codexSubscriptionTransport, disposeCodexRuntimes } from './codex-subscription';

export const OpenAIProvider = createProvider({
  vendor: VENDOR_INFO.gpt,
  api: apiTransport,
  subscriptionFor: codexSubscriptionTransport,
  dispose: disposeCodexRuntimes,
});
