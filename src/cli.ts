#!/usr/bin/env bun

import { realpathSync, statSync } from 'fs';
import path from 'path';
import packageManifest from '../package.json';
import { parsePermissionMode, type PermissionMode } from './agent_runtime/permissions/policy';
import type { SessionSnapshot } from './agent_runtime/session';

export const USAGE = `Usage: sirus [directory] [prompt] [options]

Open a fresh draft in the current directory, or an existing directory supplied first.
Other positional text is a prompt and starts a new conversation.

  -c, --continue           Continue the latest conversation in this directory
  -r, --resume [query]     Open the session picker, or match a session name or id
  -p, --print              Run one prompt, print its reply and exit (also reads stdin)
      --model <model>      Set the default participant's model
      --permission-mode <ask|auto|bypass>
                           Set the session's permission mode
  -v, --version            Print the installed version
  -h, --help               Show this help

Use -- before a prompt beginning with a dash. Print mode declines requests that
need interactive approval or answers. Use --resume <query> with --print.`;

export interface CliOptions {
  directory: string | null;
  help: boolean;
  version: boolean;
  continueSession: boolean;
  // Empty string opens the picker; null means no resume flag.
  resume: string | null;
  prompt: string | null;
  print: boolean;
  model: string | null;
  permissionMode: PermissionMode | null;
}

export function parseCliArguments(args: readonly string[], currentDirectory: string = process.cwd()): CliOptions {
  const options: CliOptions = {
    directory: null, help: false, version: false, continueSession: false,
    resume: null, prompt: null, print: false, model: null, permissionMode: null,
  };
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') {
      positional.push(...args.slice(index + 1));
      break;
    }
    const equals = argument.startsWith('--') ? argument.indexOf('=') : -1;
    const flag = equals === -1 ? argument : argument.slice(0, equals);
    const inline = equals === -1 ? undefined : argument.slice(equals + 1);
    const value = (): string => {
      const next = inline ?? args[++index];
      if (!next || next.startsWith('-')) throw new Error(`${flag} requires a value.`);
      return next;
    };
    if (inline !== undefined && !['--model', '--permission-mode', '--resume'].includes(flag)) {
      throw new Error(`Unknown option: ${argument}`);
    }
    switch (flag) {
      case '-h': case '--help': options.help = true; break;
      case '-v': case '--version': options.version = true; break;
      case '-c': case '--continue': options.continueSession = true; break;
      case '-p': case '--print': options.print = true; break;
      case '-r': case '--resume':
        options.resume = inline ?? (args[index + 1] && !args[index + 1].startsWith('-') ? args[++index] : '');
        break;
      case '--model': options.model = value(); break;
      case '--permission-mode': {
        const mode = value();
        options.permissionMode = parsePermissionMode(mode);
        if (!options.permissionMode) throw new Error(`Unknown permission mode: ${mode}. Use ask, auto or bypass.`);
        break;
      }
      default:
        if (argument.startsWith('-')) throw new Error(`Unknown option: ${argument}`);
        positional.push(argument);
    }
  }
  if (options.help || options.version) return options;
  if (options.continueSession && options.resume !== null) throw new Error('Use either --continue or --resume.');
  if (options.print && options.resume === '') throw new Error('--print requires a name or id after --resume.');

  let directory = currentDirectory;
  if (positional[0]) {
    const candidate = path.resolve(currentDirectory, positional[0]);
    // An existing directory preserves the original positional-directory form.
    // Everything else, including a file path, is useful prompt text.
    try {
      if (statSync(candidate).isDirectory()) {
        directory = candidate;
        positional.shift();
      }
    } catch { /* Not an existing directory: this is a prompt. */ }
  }
  options.directory = realpathSync(directory);
  options.prompt = positional.length ? positional.join(' ') : null;
  return options;
}

export function resolveResumeSelection(
  snapshots: readonly SessionSnapshot[],
  options: Pick<CliOptions, 'directory' | 'continueSession' | 'resume'>,
): SessionSnapshot | null {
  if (options.continueSession) {
    const latest = snapshots.filter(snapshot => snapshot.directory === options.directory && !snapshot.archived)
      .sort((a, b) => (b.updatedAt ?? b.conversationStartedAt ?? 0) - (a.updatedAt ?? a.conversationStartedAt ?? 0))[0];
    return latest ?? null;
  }
  if (!options.resume) return null;
  const query = options.resume.toLowerCase();
  const exactId = snapshots.find(snapshot => snapshot.id.toLowerCase() === query);
  if (exactId) return exactId;
  const exactNames = snapshots.filter(snapshot => snapshot.name.toLowerCase() === query);
  const matches = exactNames.length ? exactNames : snapshots.filter(snapshot =>
    snapshot.id.toLowerCase().startsWith(query) || snapshot.name.toLowerCase().includes(query));
  if (matches.length === 0) throw new Error(`No session matches "${options.resume}".`);
  if (matches.length > 1) throw new Error(`Several sessions match "${options.resume}". Use a session id or --resume to pick one.`);
  return matches[0];
}

export async function runPrint(
  options: CliOptions,
  prompt: string,
  write: (text: string) => void = text => { process.stdout.write(text); },
): Promise<void> {
  if (!prompt.trim()) throw new Error('--print requires a prompt argument or piped input.');
  const [{ Session, DEFAULT_MODEL }, persistence, permissions, questions, { textOf }] = await Promise.all([
    import('./agent_runtime/session'), import('./persistence'), import('./agent_runtime/permissions/approvals'),
    import('./agent_runtime/permissions/questions'), import('./agent_runtime/types'),
  ]);
  const saved = persistence.loadSessionSnapshots(undefined, options.directory!);
  const snapshot = resolveResumeSelection(saved.snapshots, options);
  const session = snapshot ? Session.fromSnapshot(snapshot) : new Session({
    directory: options.directory!, model: options.model ?? persistence.loadSirusModelPreference() ?? DEFAULT_MODEL,
    name: prompt.trim().slice(0, 80),
  });
  session.setArchived(false);
  if (options.model) session.changeParticipantModel(session.toSnapshot().defaultModel.name, options.model);
  if (options.permissionMode) session.setPermissionMode(options.permissionMode);
  const lastSeq = session.getMessages().at(-1)?.seq ?? -1;
  const unsubscribe = session.subscribe(() => {
    if (!session.isEmpty()) persistence.saveSessionSnapshot(session.toSnapshot());
  });
  const interrupt = () => { process.exitCode = 130; session.cancel(); };
  const terminate = () => { process.exitCode = 143; session.cancel(); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  const stopPermissions = permissions.subscribePermissions(() => {
    for (const request of permissions.pendingApprovals(session.getId())) permissions.resolveApproval(request.id, 'deny');
  });
  const stopQuestions = questions.subscribeQuestions(() => {
    for (const request of questions.pendingQuestions(session.getId())) questions.resolveQuestion(request.id, { action: 'decline' });
  });
  try {
    await session.sendMessage({ role: 'user', content: [{ type: 'text', text: prompt }] });
    const reply = session.getMessages().filter(message => message.seq > lastSeq && message.role === 'assistant' && !message.hidden)
      .map(textOf).filter(Boolean).join('\n\n');
    if (reply) write(`${reply}\n`);
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    unsubscribe();
    stopPermissions();
    stopQuestions();
    await session.dispose();
    if (!session.isEmpty()) {
      persistence.saveSessionSnapshot(session.toSnapshot());
      persistence.saveSessionMetadata([...saved.snapshots.map(item => item.id), session.getId()], session.getId());
    }
  }
}

export async function runCli(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseCliArguments(args);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (options.version) {
    process.stdout.write(`${packageManifest.version}\n`);
    return;
  }
  if (options.model) {
    const { servesModel } = await import('./agent_runtime/providers');
    if (!servesModel(options.model)) throw new Error(`Unknown model: ${options.model}. Use /model to see available models.`);
  }
  process.chdir(options.directory!);
  if (options.print) {
    const input = options.prompt ?? (!process.stdin.isTTY ? await Bun.stdin.text() : '');
    try {
      await runPrint(options, input);
    } finally {
      const [{ disposeAllRuntimes }, { stopSirusMcpServer }, { closeAllMemoryStores }] = await Promise.all([
        import('./agent_runtime/runtime/runtime'), import('./agent_runtime/tools/server'), import('./memory/store'),
      ]);
      disposeAllRuntimes();
      stopSirusMcpServer();
      closeAllMemoryStores();
    }
    return;
  }
  const { startFrontend } = await import('./frontend/index');
  startFrontend(options);
}

if (import.meta.main) {
  runCli().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`sirus: ${message}\n`);
    if (!process.exitCode) process.exitCode = 1;
  });
}
