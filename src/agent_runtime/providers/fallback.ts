import { isAbortError, throwIfAborted } from '../../abort';
import type { Message } from '../types';
import type { TurnContext } from '../turn';
import { maskApiKey, type Source } from './sources';
import type { Response, Transport } from './provider';

// One turn against an ordered list of ways to reach a vendor: try them in
// order, carry finished work across a failure, and stop the moment the turn
// is cancelled. Nothing here knows about vendors, storage or model names.

export interface FallbackAttempt {
  source: Source;
  transport: Transport;
}

export interface FallbackOptions {
  // The candidates in preference order; the head is tried first.
  attempts: readonly FallbackAttempt[];
  messages: readonly Message[];
  turn: TurnContext;
  // Source id per agent runtime: a source that worked stays first for the
  // rest of that runtime, and concurrent runtimes never disturb each other.
  sticky: Map<string, string>;
  // Called as each attempt starts, so the caller can show what is in use.
  onSourceUsed?: (source: Source) => void;
  // The vendor's name, as it appears in the exhaustion message.
  owner: string;
}

export async function runWithFallback(options: FallbackOptions): Promise<Response> {
  const { attempts, messages, turn, sticky, onSourceUsed, owner } = options;
  throwIfAborted(turn.signal);
  const failed = new Set<string>();
  const failures: string[] = [];
  const execute = async (
    input: readonly Message[],
    resumeSource?: string,
    resume?: () => Promise<Response>,
  ): Promise<Response> => {
    const candidates = attempts.filter(attempt => !failed.has(attempt.source.id));
    const previous = resumeSource ?? sticky.get(turn.agent.runtimeId);
    candidates.sort((a, b) => Number(b.source.id === previous) - Number(a.source.id === previous));
    if (!candidates.length && !failures.length) {
      throw new Error(`No ${owner} API key. Run /login to sign in or paste a key.`);
    }
    let history = input;
    for (const { source, transport } of candidates) {
      throwIfAborted(turn.signal);
      const before = turn.content.length;
      try {
        onSourceUsed?.(source);
        const response = await (source.id === resumeSource && resume ? resume() : transport.getResponse(history, turn));
        sticky.set(turn.agent.runtimeId, source.id);
        const continuation = response.continueWithToolResults;
        const responseHistory = history;
        return continuation ? {
          ...response,
          continueWithToolResults: results => execute([
            ...responseHistory,
            { role: 'assistant', content: [...response.content, ...results] },
            { role: 'user', content: [{ type: 'text', text: 'Continue using the tool results above. Do not repeat completed work.' }] },
          ], source.id, () => continuation(results)),
        } : response;
      } catch (error) {
        throwIfAborted(turn.signal);
        if (isAbortError(error)) throw error;
        failed.add(source.id);
        transport.resetRuntime?.(turn.agent.runtimeId);
        const partial = turn.content.slice(before);
        // Completed tool work must travel with the retry so it isn't repeated.
        // An unresolved call has an unknown outcome: don't execute it again.
        const calls = partial.filter(block => block.type === 'tool_call');
        const delegated = transport.toolExecution === 'delegated';
        if (delegated && calls.some(call => !partial.some(block => block.type === 'tool_result' && block.callId === call.id))) throw error;
        turn.updateStream([]);
        if (delegated && calls.length) {
          turn.commit(partial);
          history = [...history, { role: 'assistant', content: partial }, { role: 'user', content: [{
            type: 'text', text: 'The previous source failed. Continue from the completed work above without repeating those tools.',
          }] }];
        }
        const detail = error instanceof Error ? error.message : String(error);
        const safe = attempts.reduce((text, item) => item.source.kind === 'api'
          ? text.replaceAll(item.source.key, maskApiKey(item.source.key)) : text, detail);
        failures.push(`${source.kind === 'api' ? `API ${maskApiKey(source.key)}` : `subscription ${source.label ?? source.id}`}: ${safe}`);
      }
    }
    throw new Error(`All ${owner} sources failed (${failures.length}): ${failures.join('; ')}`);
  };
  return execute(messages);
}
