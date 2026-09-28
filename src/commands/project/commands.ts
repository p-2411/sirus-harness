import { chmodSync, closeSync, existsSync, fstatSync, linkSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { CommandSpec } from '../types';

// The commands that work on the project with the agents, for either vendor.
// Each is sent as the user's own message: the chat shows `/init` or
// `/review`, and the addressed participant receives the full prompt
// (`nativePrompt` in `runtime/commands.ts`), the way both vendors' own
// terminals send theirs.

const IMPORT_LINE = '@AGENTS.md';

// Claude Code reads CLAUDE.md, which imports another file with an `@path`
// line; Codex reads AGENTS.md. Once AGENTS.md exists, CLAUDE.md has to import
// it, whatever the agent made of that part of the prompt. Returns what it did.
function importAgentsFromClaude(directory: string): 'created' | 'added' | 'present' | 'no-agents' {
  if (!existsSync(join(directory, 'AGENTS.md'))) return 'no-agents';
  const claude = join(directory, 'CLAUDE.md');
  let original: Stats | undefined;
  try {
    original = lstatSync(claude);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (original && !original.isFile()) throw new Error('CLAUDE.md must be a regular file, not a symlink or special file.');
  let text = '';
  if (original) {
    const fd = openSync(claude, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.dev !== original.dev || opened.ino !== original.ino) {
        throw new Error('CLAUDE.md changed while reading it. Run /init again.');
      }
      text = readFileSync(fd, 'utf8');
    } finally {
      closeSync(fd);
    }
  }
  if (text.split(/\r?\n/).some(line => line.trim() === IMPORT_LINE)) return 'present';
  // Replace the directory entry atomically: a link swapped in during the
  // write is replaced as a link, never followed to its target.
  const temporary = join(directory, `.CLAUDE.md-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, original ? `${IMPORT_LINE}\n\n${text}` : `${IMPORT_LINE}\n`, {
      flag: 'wx', mode: original ? original.mode & 0o777 : 0o666,
    });
    if (original) {
      chmodSync(temporary, original.mode & 0o777);
      const current = lstatSync(claude);
      if (!current.isFile() || current.dev !== original.dev || current.ino !== original.ino) {
        throw new Error('CLAUDE.md changed while updating it. Run /init again.');
      }
      renameSync(temporary, claude);
      return 'added';
    }
    linkSync(temporary, claude);
    return 'created';
  } finally {
    try { unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function sendPrompt(text: string, context: Parameters<CommandSpec['run']>[1]): Promise<void> {
  if (!context.sendPrompt) throw new Error(`${text.split(' ')[0]} is not available here.`);
  return context.sendPrompt(text);
}

export const initCommand: CommandSpec = {
  name: 'init',
  args: '[instructions]',
  description: 'write AGENTS.md for this project, with a CLAUDE.md that imports it',
  run: async (args, context) => {
    await sendPrompt(['/init', ...args].join(' '), context);
    const directory = context.session.getDirectory();
    const result = importAgentsFromClaude(directory);
    if (result === 'no-agents') return { kind: 'warning', text: 'The agent did not write AGENTS.md; nothing was imported into CLAUDE.md.' };
    return {
      kind: 'success',
      text: result === 'present' ? 'AGENTS.md is written, and CLAUDE.md imports it.'
        : result === 'created' ? 'AGENTS.md is written; CLAUDE.md now imports it.'
          : 'AGENTS.md is written; CLAUDE.md now imports it at the top.',
    };
  },
};

export const reviewCommand: CommandSpec = {
  name: 'review',
  args: '[instructions]',
  description: 'review the uncommitted changes, or what the instructions say',
  run: (args, context) => sendPrompt(['/review', ...args].join(' '), context),
};
