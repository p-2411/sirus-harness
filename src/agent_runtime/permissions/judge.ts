import crypto from 'crypto';
import { modelStrategies } from '../chat';
import { SessionAgent } from '../agent';
import type { Message } from '../types';

// The auto-approve judge: one tool-less turn of the cheapest model of the
// same provider as the participant, through whatever credential that provider
// is using, answering with a single word. Anything unexpected counts as
// sensitive.

export type JudgeVerdict = 'approve' | 'sensitive';

export const JUDGE_TIMEOUT_MS = 10_000;

export interface JudgePrompt {
  system: string;
  user: string;
}

export function judgeModelFor(model: string): string | null {
  return modelStrategies[model]?.judgeModel ?? null;
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

function textOf(message: Message): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');
}

export async function judgeShellCommand(
  command: string,
  directory: string,
  model: string,
  signal?: AbortSignal,
): Promise<JudgeVerdict> {
  const judgeModel = judgeModelFor(model);
  if (!judgeModel) return 'sensitive';
  const prompt = judgePrompt(command, directory);
  // A throwaway agent: no permissions because it has no tools, its own runtime
  // id so nothing of the participant's provider session is touched.
  const judge = new SessionAgent({
    name: 'judge',
    model: judgeModel,
    runtimeId: `judge/${crypto.randomUUID().slice(0, 8)}`,
  });
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(new Error('judge timed out')), JUDGE_TIMEOUT_MS);
  try {
    const turn = judge.respond([{ role: 'user', content: [{ type: 'text', text: prompt.user }] }], {
      directory,
      signal: signal ? AbortSignal.any([signal, timer.signal]) : timer.signal,
      systemPrompt: prompt.system,
      tools: false,
    });
    return parseVerdict(textOf(await turn.result));
  } catch (error) {
    // the turn's own cancellation must still cancel the turn
    if (signal?.aborted) throw error;
    return 'sensitive';
  } finally {
    clearTimeout(timeout);
  }
}
