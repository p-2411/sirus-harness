import { resolveStrategy } from './chat';
import { vendorOf } from './subscriptions';

// The auto-approve judge: one tool-less request to the cheapest model of the
// same provider as the participant, through whatever credential that provider is
// using, answering with a single word. Anything unexpected counts as sensitive.

export type JudgeVerdict = 'approve' | 'sensitive';

export const JUDGE_MODELS = {
  claude: 'claude-haiku-4.5',
  gpt: 'gpt-5.6-luna',
} as const;

export const JUDGE_TIMEOUT_MS = 10_000;

export interface JudgePrompt {
  system: string;
  user: string;
}

export function judgeModelFor(model: string): string | null {
  const vendor = vendorOf(model);
  return vendor ? JUDGE_MODELS[vendor] : null;
}

export function judgePrompt(command: string, directory: string): JudgePrompt {
  return {
    system: [
      'You classify shell commands that an AI coding agent wants to run in the working directory',
      `${directory}.`,
      'Answer with exactly one word: approve or sensitive.',
      'A command is sensitive if it destroys or overwrites data, touches paths outside the working directory,',
      'writes to the network (pushes, uploads, sends messages), escalates privileges, or controls processes',
      '(kills, signals, restarts services). Building, testing, installing project dependencies, formatting,',
      'committing, writing files inside the working directory, and reading are approve.',
    ].join(' '),
    user: `Command:\n${command}`,
  };
}

export function parseVerdict(answer: string): JudgeVerdict {
  return /^\s*approve\b/i.test(answer) ? 'approve' : 'sensitive';
}

function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('judge timed out')), ms);
  const onAbort = () => controller.abort(signal!.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    release: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

export async function judgeShellCommand(
  command: string,
  directory: string,
  model: string,
  signal?: AbortSignal,
): Promise<JudgeVerdict> {
  const judgeModel = judgeModelFor(model);
  if (!judgeModel) return 'sensitive';
  let strategy;
  try {
    strategy = resolveStrategy(judgeModel);
  } catch {
    return 'sensitive';
  }
  if (!strategy.judge) return 'sensitive';
  const timed = withTimeout(signal, JUDGE_TIMEOUT_MS);
  try {
    const answer = await strategy.judge(judgePrompt(command, directory), judgeModel, timed.signal);
    return parseVerdict(answer);
  } catch (error) {
    // the turn's own cancellation must still cancel the turn
    if (signal?.aborted) throw error;
    return 'sensitive';
  } finally {
    timed.release();
  }
}
