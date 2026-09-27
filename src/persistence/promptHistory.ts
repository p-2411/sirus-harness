import { createHash } from 'crypto';
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'fs';
import path from 'path';
import { dataDirectory } from '../dataDirectory';

function historyPath(directory: string): string {
  let resolved = path.resolve(directory);
  try {
    resolved = realpathSync(resolved);
  } catch {
    // A project that was moved or deleted still has its own history.
  }
  const key = createHash('sha256').update(resolved).digest('hex');
  return path.join(dataDirectory(), 'prompt-history', `${key}.jsonl`);
}

export function readPromptHistory(directory: string): string[] {
  try {
    const lines = readFileSync(historyPath(directory), 'utf8').split('\n');
    const history: string[] = [];
    for (let index = lines.length - 1; index >= 0 && history.length < 1_000; index--) {
      try {
        const text: unknown = JSON.parse(lines[index]!);
        if (typeof text === 'string' && text.trim()) history.push(text);
      } catch {
        // A partial or damaged record does not hide the remaining prompts.
      }
    }
    return history.reverse();
  } catch {
    return [];
  }
}

export function appendPromptHistory(directory: string, text: string): void {
  if (!text.trim()) return;
  try {
    const file = historyPath(directory);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // Append each JSON record in one write, so concurrent windows never replace
    // one another's history. Escaped newlines keep multiline prompts together.
    appendFileSync(file, `${JSON.stringify(text)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // An unwritable data directory must not prevent sending a prompt.
  }
}
