import { spawn } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';

// Editor settings commonly include arguments and quoted paths. Parse those
// without passing either the draft or the temporary filename through a shell.
function editorArguments(command: string): string[] {
  const arguments_: string[] = [];
  let value = '';
  let quote = '';
  let started = false;
  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    if (character === '\\' && quote !== "'") {
      const next = command[index + 1];
      if (next === undefined) throw new Error('The editor command ends with an incomplete escape.');
      if (quote === '"' && !['$', '`', '"', '\\', '\n'].includes(next)) {
        value += character;
      } else {
        if (next !== '\n') value += next;
        index++;
      }
      started = true;
    } else if (quote) {
      if (character === quote) quote = '';
      else value += character;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) arguments_.push(value);
      value = '';
      started = false;
    } else {
      value += character;
      started = true;
    }
  }
  if (quote) throw new Error('The editor command has an unclosed quote.');
  if (started) arguments_.push(value);
  if (!arguments_[0]) throw new Error('Set VISUAL or EDITOR to an editor command.');
  return arguments_;
}

export async function editInExternalEditor(
  text: string,
  suspendTerminal: (callback: () => Promise<void>) => Promise<void>,
): Promise<string> {
  const [command, ...args] = editorArguments(process.env.VISUAL || process.env.EDITOR || 'vi');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sirus-editor-'));
  const file = path.join(directory, 'draft.md');
  try {
    await writeFile(file, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await suspendTerminal(() => new Promise<void>((resolve, reject) => {
      const editor = spawn(command!, [...args, file], { stdio: 'inherit' });
      editor.once('error', error => reject(new Error(`Could not open editor: ${error.message}`)));
      editor.once('close', (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(signal ? `Editor stopped by ${signal}.` : `Editor exited with status ${code}.`));
      });
    }));
    return await readFile(file, 'utf8');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
