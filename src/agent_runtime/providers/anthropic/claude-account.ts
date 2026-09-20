import {
  query,
  type Query,
  type SDKControlGetUsageResponse,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { abortable, throwIfAborted } from '../../../abort';
import { SIRUS_CLIENT_ID } from '../../../version';
import { subscriptionEnvironment } from '../profiles';

// How much of a Claude subscription is left. Conversations run over ACP,
// which carries no allowance figures, so this is the one file that still
// imports the Agent SDK: its usage control request, sent on a query that
// never receives a prompt and is closed as soon as it has answered.
// `@anthropic-ai/claude-agent-sdk` stays a pinned dependency for this file
// alone. The login itself is `claude auth login` in `../login.ts`.

type ClaudeUsageQuery = Pick<Query, 'close' | 'initializationResult'> & Partial<Pick<
  Query, 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'
>>;

interface ClaudeUsageDependencies {
  createQuery: (options: Parameters<typeof query>[0]) => ClaudeUsageQuery;
  timeoutMs?: number;
  environment?: () => NodeJS.ProcessEnv;
}

// Dependency injection keeps tests isolated from the SDK's process launcher.
export function createClaudeSubscriptionUsageReader({
  createQuery,
  timeoutMs = 15_000,
  environment = () => subscriptionEnvironment('claude'),
}: ClaudeUsageDependencies): (signal?: AbortSignal) => Promise<SDKControlGetUsageResponse> {
  return async signal => {
    throwIfAborted(signal);
    const controller = new AbortController();
    const cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Claude usage request timed out')), timeoutMs);
    let current: ClaudeUsageQuery | undefined;
    let finishInput: (() => void) | undefined;
    try {
      // An empty *finished* stream closes CLI stdin. Hold this stream open
      // until the control request finishes, without ever yielding a prompt.
      const finished = new Promise<void>(resolve => { finishInput = resolve; });
      async function* emptyInput(): AsyncGenerator<SDKUserMessage> { await finished; }
      current = createQuery({
        prompt: emptyInput(),
        options: {
          abortController: controller,
          tools: [],
          mcpServers: {},
          strictMcpConfig: true,
          settingSources: [],
          settings: { disableAllHooks: true },
          persistSession: false,
          env: { ...environment(), CLAUDE_AGENT_SDK_CLIENT_APP: SIRUS_CLIENT_ID },
        },
      });
      const readUsage = current.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if (typeof readUsage !== 'function') {
        throw new Error('This Claude SDK version does not support subscription usage');
      }
      await abortable(current.initializationResult(), controller.signal);
      throwIfAborted(controller.signal);
      return await abortable(readUsage.call(current), controller.signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      finishInput?.();
      current?.close();
    }
  };
}

export function readClaudeSubscriptionUsage(signal?: AbortSignal, profile = 'default'): Promise<SDKControlGetUsageResponse> {
  return createClaudeSubscriptionUsageReader({
    createQuery: query,
    environment: () => subscriptionEnvironment('claude', profile),
  })(signal);
}
