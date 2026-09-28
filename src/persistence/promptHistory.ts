import { createHash } from 'crypto';
import { appendFileSync, closeSync, constants, fstatSync, mkdirSync, openSync, readSync, realpathSync } from 'fs';
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
  let descriptor: number;
  try { descriptor = openSync(historyPath(directory), constants.O_RDONLY | constants.O_NONBLOCK); }
  catch { return []; }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) return [];
    const history: string[] = [];
    const fragments: Buffer[] = [];
    const accept = (start: Buffer) => {
      try {
        const line = Buffer.concat([start, ...fragments.reverse()]).toString('utf8');
        const text: unknown = JSON.parse(line);
        if (typeof text === 'string' && text.trim()) history.push(text);
      } catch {
        // A partial or damaged record does not hide the remaining prompts.
      }
      fragments.length = 0;
    };
    const chunk = Buffer.alloc(64 * 1024);
    let position = stat.size;
    while (position > 0 && history.length < 1_000) {
      const length = Math.min(chunk.length, position);
      position -= length;
      const bytes = readSync(descriptor, chunk, 0, length, position);
      if (bytes !== length) break;
      let end = bytes;
      for (let index = bytes - 1; index >= 0; index--) {
        if (chunk[index] !== 10) continue;
        accept(chunk.subarray(index + 1, end));
        if (history.length === 1_000) break;
        end = index;
      }
      if (history.length < 1_000 && end > 0) fragments.push(Buffer.from(chunk.subarray(0, end)));
    }
    if (position === 0 && history.length < 1_000 && fragments.length) accept(Buffer.alloc(0));
    return history.reverse();
  } catch {
    return [];
  } finally {
    closeSync(descriptor);
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
