import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  if (!existsSync(claude)) {
    writeFileSync(claude, `${IMPORT_LINE}\n`);
    return 'created';
  }
  const text = readFileSync(claude, 'utf8');
  if (text.split(/\r?\n/).some(line => line.trim() === IMPORT_LINE)) return 'present';
  writeFileSync(claude, `${IMPORT_LINE}\n\n${text}`);
  return 'added';
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
