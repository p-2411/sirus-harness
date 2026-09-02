import crypto from 'crypto';
import os from 'os';
import path from 'path';
import type { ToolCallBlock } from '../data/data';
import { abortReason, throwIfAborted } from '../abort';
import { judgeShellCommand, type JudgeVerdict } from './judge';

// The permission gate every model-requested tool call passes through, in
// runTool, whatever transport asked for it. Three modes:
//   ask    — ask for approval: deterministic; reads pass, everything else prompts
//   auto   — auto approve: reads and ordinary writes pass, sensitive operations
//            prompt, and a cheap model judges shell commands the rules cannot place
//   bypass — bypass permissions: everything passes, nothing is classified

export type PermissionMode = 'ask' | 'auto' | 'bypass';

export const PERMISSION_MODES: readonly PermissionMode[] = ['ask', 'auto', 'bypass'];

export const PERMISSION_MODE_NAMES: Record<PermissionMode, string> = {
  ask: 'ask for approval',
  auto: 'auto approve',
  bypass: 'bypass permissions',
};

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'auto';

export function parsePermissionMode(value: unknown): PermissionMode | null {
  return value === 'ask' || value === 'auto' || value === 'bypass' ? value : null;
}

export function nextPermissionMode(mode: PermissionMode): PermissionMode {
  return PERMISSION_MODES[(PERMISSION_MODES.indexOf(mode) + 1) % PERMISSION_MODES.length];
}

export type ToolClass = 'read' | 'write' | 'sensitive' | 'unsure';

export type Requester = { participant: string } | { subagent: string };

// Who is asking, under which session's mode. `mode` is a live lookup so a
// mode change applies to the next call of every participant and subagent of
// the session.
export interface PermissionContext {
  sessionId: string;
  mode: () => PermissionMode;
  requester: Requester;
  model: string;
}

export type ApprovalDecision = 'allow' | 'allow-session' | 'deny';

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  requester: Requester;
  call: ToolCallBlock;
  toolClass: ToolClass;
  // why this prompt appeared, shown beside the tool name
  reason: string;
  // what the user is approving, one item per line
  detail: string[];
  // the allowance "allow for this session" would record; null when the
  // operation is sensitive and allowances cannot cover it
  allowanceKey: string | null;
}

export function describeRequester(requester: Requester): string {
  return 'participant' in requester ? `@${requester.participant}` : `subagent ${requester.subagent}`;
}

// ---------------------------------------------------------------------------
// Classification

const READ_TOOLS = new Set([
  'ReadFile', 'SearchFiles',
  'SaveMemory', 'GetMemory', 'SearchMemories', 'DeleteMemory',
  'CheckAgent', 'ListAgents', 'CancelAgent',
  'WebSearch', 'FetchURL',
]);

function strictest(classes: readonly ToolClass[]): ToolClass {
  const order: ToolClass[] = ['read', 'write', 'unsure', 'sensitive'];
  let result: ToolClass = 'read';
  for (const candidate of classes) {
    if (order.indexOf(candidate) > order.indexOf(result)) result = candidate;
  }
  return result;
}

function resolveInside(directory: string, target: string): boolean {
  const root = path.resolve(directory);
  const resolved = target.startsWith('~')
    ? path.resolve(os.homedir(), target.slice(1).replace(/^[\\/]/, ''))
    : path.resolve(root, target);
  return resolved === root || resolved.startsWith(root + path.sep);
}

export function classifyToolCall(call: ToolCallBlock, directory: string): ToolClass {
  if (READ_TOOLS.has(call.name)) return 'read';
  switch (call.name) {
    case 'WriteFile':
    case 'EditFile': {
      const target = typeof call.arguments.path === 'string' ? call.arguments.path : '';
      return target && resolveInside(directory, target) ? 'write' : 'sensitive';
    }
    case 'SpawnAgent':
      return 'write';
    case 'RunShell':
      return typeof call.arguments.command === 'string'
        ? classifyShellCommand(call.arguments.command, directory)
        : 'unsure';
    default:
      // an unknown tool fails as unknown before it can do anything
      return 'read';
  }
}

// ---------------------------------------------------------------------------
// Shell commands

interface SimpleCommand {
  words: string[];
  // file targets of > and >> redirections
  writes: string[];
  // true when this command reads the previous command's output
  piped: boolean;
}

const OPERATORS = ['||', '&&', '|', ';', '\n'];

// Splits a command line into simple commands on pipes, chains and newlines,
// keeping quoted strings intact. Returns null for anything with subshells,
// command substitution, grouping or backgrounding: too much to reason about.
export function splitShellCommand(command: string): SimpleCommand[] | null {
  const commands: SimpleCommand[] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let piped = false;
  let quote: '"' | "'" | null = null;
  const finishWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const finishCommand = (nextPiped: boolean) => {
    finishWord();
    if (words.length > 0) commands.push(toSimpleCommand(words, piped));
    words = [];
    piped = nextPiped;
  };

  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (quote) {
      if (character === quote) {
        quote = null;
      } else if (character === '\\' && quote === '"' && index + 1 < command.length) {
        word += command[++index];
      } else {
        word += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      inWord = true;
      continue;
    }
    if (character === '\\' && index + 1 < command.length) {
      word += command[++index];
      inWord = true;
      continue;
    }
    if (character === '$' && command[index + 1] === '(') return null;
    if (character === '`' || character === '(' || character === ')' || character === '{' || character === '}') return null;
    const operator = OPERATORS.find(candidate => command.startsWith(candidate, index));
    if (operator) {
      finishCommand(operator === '|');
      index += operator.length - 1;
      continue;
    }
    if (character === '&') {
      // >&2, 2>&1 and &> are redirections; a lone & backgrounds, which we do not follow
      if (word.endsWith('>') || word.endsWith('<') || command[index + 1] === '>') {
        word += character;
        inWord = true;
        continue;
      }
      return null;
    }
    if (character === ' ' || character === '\t') {
      finishWord();
      continue;
    }
    word += character;
    inWord = true;
  }
  if (quote) return null;
  finishCommand(false);
  return commands;
}

const REDIRECT = /^(\d*)(>>|>\|?|<|&>)(.*)$/;

function toSimpleCommand(tokens: readonly string[], piped: boolean): SimpleCommand {
  const words: string[] = [];
  const writes: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const match = REDIRECT.exec(token);
    if (!match) {
      words.push(token);
      continue;
    }
    const operator = match[2];
    let target = match[3];
    if (target === '' && index + 1 < tokens.length) target = tokens[++index];
    // >&2 and 2>&1 duplicate descriptors rather than touching files
    if (target.startsWith('&') || operator === '<' || DEVICES.has(target)) continue;
    writes.push(target);
  }
  // FOO=bar cmd: leading environment assignments are not the command
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  return { words, writes, piped };
}

const DEVICES = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/stdin']);

// Always a prompt in auto approve: deleting, permissions, processes,
// privilege, disks, the machine itself.
const SENSITIVE_COMMANDS = new Set([
  'rm', 'chmod', 'kill', 'pkill', 'killall',
  'sudo', 'doas', 'su', 'dd', 'mkfs', 'diskutil', 'shutdown', 'reboot', 'halt',
  'launchctl', 'systemctl', 'crontab',
]);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh']);
const INTERPRETERS = new Set(['python', 'python3', 'node', 'perl', 'ruby', 'deno', 'tsx', 'ts-node']);
// Commands that only report; with a redirection they become writes.
const READ_ONLY_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'ag',
  'find', 'fd', 'wc', 'pwd', 'echo', 'printf', 'which', 'type', 'date', 'whoami',
  'stat', 'file', 'tree', 'du', 'df', 'sort', 'uniq', 'cut', 'awk', 'diff', 'jq',
  'true', 'false', 'test', '[', 'basename', 'dirname', 'realpath', 'readlink',
  'tr', 'column', 'nl', 'strings', 'md5', 'shasum', 'sha256sum', 'md5sum', 'xxd', 'od',
  'uname', 'id', 'hostname', 'ps', 'lsof', 'netstat', 'ping', 'dig', 'nslookup', 'host',
  'sleep', 'time', 'env', 'printenv', 'export', 'set', 'unset', 'alias', 'history',
  'man', 'help', 'tput', 'clear', 'seq', 'yes', 'xargs', 'comm', 'paste', 'join',
  'ifconfig', 'sw_vers', 'arch', 'nproc', 'sysctl', 'ulimit', 'wc', 'cal', 'bc',
]);
// Commands that change files they are pointed at, so a target outside the
// project is sensitive; inside it they go to the judge like everything else.
const PATH_WRITERS = new Set([
  'rmdir', 'mv', 'cp', 'mkdir', 'touch', 'ln', 'chown', 'tee', 'sed',
  'install', 'rsync', 'truncate', 'unzip', 'tar', 'zip', 'gzip', 'gunzip', 'patch',
]);
const NETWORK_WRITE_FLAGS = new Set([
  '-X', '--request', '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode',
  '-F', '--form', '-T', '--upload-file', '--json',
]);
// Files the model should not be reading on its own.
const SECRET_PATHS = ['.ssh', '.aws', '.gnupg', '.config/gh', '.netrc', '.npmrc', '.pypirc', '.docker/config.json'];

function homePath(...segments: string[]): string {
  return path.join(os.homedir(), ...segments);
}

// Where a command may write without asking: the project and scratch space.
function isWritableTarget(directory: string, target: string): boolean {
  if (DEVICES.has(target)) return true;
  if (resolveInside(directory, target)) return true;
  return resolveInside(os.tmpdir(), target) || resolveInside('/tmp', target) || resolveInside('/private/tmp', target);
}

function isSecretPath(target: string): boolean {
  const resolved = target.startsWith('~')
    ? path.resolve(os.homedir(), target.slice(1).replace(/^[\\/]/, ''))
    : path.resolve(target);
  return SECRET_PATHS.some(secret => {
    const full = homePath(secret);
    return resolved === full || resolved.startsWith(full + path.sep);
  });
}

// Words that name files or directories, so the directory checks apply.
function pathCandidates(words: readonly string[]): string[] {
  const candidates: string[] = [];
  for (const word of words) {
    const value = word.includes('=') && word.startsWith('-') ? word.slice(word.indexOf('=') + 1) : word;
    if (!value || value === '-' || value === '--') continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) continue; // a URL
    if (value.startsWith('/') || value.startsWith('~') || value.split('/').includes('..')) candidates.push(value);
  }
  return candidates;
}

function gitSubcommand(words: readonly string[]): { name: string; rest: string[] } | null {
  let index = 1;
  while (index < words.length && words[index].startsWith('-')) {
    if (words[index] === '-C' || words[index] === '-c') index++; // takes a value
    index++;
  }
  if (index >= words.length) return null;
  return { name: words[index], rest: words.slice(index + 1) };
}

const GIT_READ_ONLY = new Set([
  'status', 'diff', 'log', 'show', 'rev-parse', 'blame', 'ls-files', 'describe',
  'remote', 'shortlog', 'reflog', 'cat-file', 'grep', 'worktree', 'ls-remote',
  'config', 'rev-list', 'name-rev', 'for-each-ref', 'show-ref', 'count-objects',
  'diff-tree', 'ls-tree', 'var', 'version', 'help', 'check-ignore', 'bisect',
]);
// Discarding work, rewriting shared history and publishing are the prompts;
// inspection is a read; everything else that touches the repository goes to
// the judge.
function classifyGit(words: readonly string[]): ToolClass {
  const sub = gitSubcommand(words);
  if (!sub) return 'read';
  const { name, rest } = sub;
  if (name === 'push') return rest.includes('--dry-run') || rest.includes('-n') ? 'read' : 'sensitive';
  if (name === 'clean') return rest.includes('-n') || rest.includes('--dry-run') ? 'read' : 'sensitive';
  if (name === 'reset' && rest.includes('--hard')) return 'sensitive';
  if ((name === 'checkout' || name === 'restore') && (rest.includes('--') || rest.includes('.'))) return 'sensitive';
  if (name === 'restore' && !rest.includes('--staged')) return 'sensitive';
  if (name === 'branch') {
    if (rest.some(word => word === '-D' || word === '--delete' || word === '-M')) return 'sensitive';
    return rest.every(word => word.startsWith('-')) ? 'read' : 'unsure';
  }
  if (name === 'stash') return rest[0] === 'drop' || rest[0] === 'clear' ? 'sensitive' : rest[0] === 'list' || rest[0] === 'show' ? 'read' : 'unsure';
  if (name === 'remote') return rest.length === 0 || rest[0] === '-v' || rest[0] === 'show' || rest[0] === 'get-url' ? 'read' : 'unsure';
  if (name === 'tag') return rest.length === 0 || rest[0] === '-l' || rest[0] === '--list' ? 'read' : 'unsure';
  if (name === 'worktree') return rest[0] === 'remove' || rest[0] === 'prune' ? 'sensitive' : rest[0] === 'list' ? 'read' : 'unsure';
  if (name === 'config') return rest.some(word => word === '--global' || word === '--system') ? 'sensitive' : rest.length <= 1 || rest[0].startsWith('--get') || rest[0] === '--list' || rest[0] === '-l' ? 'read' : 'unsure';
  if (name === 'bisect') return rest[0] === 'log' || rest[0] === 'view' ? 'read' : 'unsure';
  if (GIT_READ_ONLY.has(name)) return 'read';
  return 'unsure';
}

function classifySimpleCommand(command: SimpleCommand, directory: string): ToolClass {
  const { words, writes, piped } = command;
  if (words.length === 0) return writes.length > 0 ? 'write' : 'read';
  const name = path.basename(words[0]);
  const rest = words.slice(1);
  const arguments_ = rest.filter(word => !word.startsWith('-'));
  const flags = rest.filter(word => word.startsWith('-'));

  // rule 1: sensitive
  if (SENSITIVE_COMMANDS.has(name)) return 'sensitive';
  if (SHELLS.has(name) && piped) return 'sensitive';
  if (piped && INTERPRETERS.has(name) && rest.length === 0) return 'sensitive';
  if (name === 'git' && classifyGit(words) === 'sensitive') return 'sensitive';
  if (pathCandidates(rest).some(isSecretPath)) return 'sensitive';
  for (const target of writes) {
    if (!isWritableTarget(directory, target)) return 'sensitive';
  }
  const editsInPlace = name === 'sed' && flags.some(flag => flag === '-i' || /^-[a-zA-Z]*i/.test(flag));
  if (PATH_WRITERS.has(name) && (name !== 'sed' || editsInPlace)) {
    const targets = name === 'cp' || name === 'mv' || name === 'ln' || name === 'rsync' || name === 'install'
      ? arguments_.slice(-1) // the destination is what changes
      : arguments_;
    for (const target of [...pathCandidates(targets), ...pathCandidates(flags)]) {
      if (!isWritableTarget(directory, target)) return 'sensitive';
    }
  }

  // rule 2: read-only, provided nothing is redirected into a file
  if (writes.length > 0) return 'unsure';
  if (name === 'git') return classifyGit(words);
  if (name === 'sed') return editsInPlace ? 'unsure' : 'read';
  if (name === 'cd') return arguments_.length === 0 || resolveInside(directory, arguments_[0]) ? 'read' : 'unsure';
  if (name === 'curl') return flags.some(flag => NETWORK_WRITE_FLAGS.has(flag)) ? 'unsure' : 'read';
  if (READ_ONLY_COMMANDS.has(name)) return 'read';

  // rule 3: everything else is the judge's call
  return 'unsure';
}

export function classifyShellCommand(command: string, directory: string): ToolClass {
  if (!command.trim()) return 'read';
  const commands = splitShellCommand(command);
  if (!commands) return 'unsure';
  return strictest(commands.map(simple => classifySimpleCommand(simple, directory)));
}

// The word "allow for this session" keys on: the directory for file writes,
// the leading command for shell, the tool itself for spawning.
export function allowanceKeyFor(call: ToolCallBlock, directory: string): string | null {
  switch (call.name) {
    case 'WriteFile':
    case 'EditFile': {
      const target = typeof call.arguments.path === 'string' ? call.arguments.path : '';
      return target ? `write:${path.dirname(path.resolve(directory, target))}` : null;
    }
    case 'RunShell': {
      const command = typeof call.arguments.command === 'string' ? call.arguments.command : '';
      const first = splitShellCommand(command)?.[0]?.words[0];
      return first ? `shell:${path.basename(first)}` : null;
    }
    case 'SpawnAgent':
      return 'tool:SpawnAgent';
    default:
      return `tool:${call.name}`;
  }
}

// ---------------------------------------------------------------------------
// Prompt detail

const DETAIL_LINES = 6;

function previewLines(text: string, prefix: string = ''): string[] {
  const lines = text.split('\n');
  const shown = lines.slice(0, DETAIL_LINES).map(line => `${prefix}${line}`);
  if (lines.length > DETAIL_LINES) shown.push(`${prefix}… ${lines.length - DETAIL_LINES} more line${lines.length - DETAIL_LINES === 1 ? '' : 's'}`);
  return shown;
}

export function describeToolCall(call: ToolCallBlock, directory: string): string[] {
  const args = call.arguments;
  switch (call.name) {
    case 'WriteFile': {
      const target = path.resolve(directory, String(args.path ?? ''));
      return [target, ...previewLines(String(args.content ?? ''), '  ')];
    }
    case 'EditFile': {
      const target = path.resolve(directory, String(args.path ?? ''));
      return [
        target,
        ...previewLines(String(args.old_text ?? ''), '  - '),
        ...previewLines(String(args.new_text ?? ''), '  + '),
      ];
    }
    case 'RunShell':
      return previewLines(String(args.command ?? ''), '$ ');
    case 'SpawnAgent': {
      const prompt = String(args.prompt ?? '');
      return [`${String(args.model ?? '')}: ${prompt.length > 120 ? `${prompt.slice(0, 120)}…` : prompt}`];
    }
    default: {
      const text = JSON.stringify(args);
      return [text.length > 200 ? `${text.slice(0, 200)}…` : text];
    }
  }
}

// ---------------------------------------------------------------------------
// Store: pending prompts, judge activity, per-session allowances

interface PendingEntry {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
  reject: (error: Error) => void;
}

const pending: PendingEntry[] = [];
const allowances = new Map<string, Set<string>>();
const verdicts = new Map<string, JudgeVerdict>();
const checking = new Set<string>();
const judgeCache = new Map<string, Map<string, JudgeVerdict>>();
const listeners = new Set<() => void>();
let version = 0;

function notifyListeners(): void {
  version++;
  for (const listener of listeners) listener();
}

export function subscribePermissions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Monotonic counter for useSyncExternalStore; the queue is mutated in place.
export function getPermissionsVersion(): number {
  return version;
}

export function pendingApprovals(sessionId?: string): ApprovalRequest[] {
  return pending
    .map(entry => entry.request)
    .filter(request => sessionId === undefined || request.sessionId === sessionId);
}

export function resolveApproval(id: string, decision: ApprovalDecision): boolean {
  const index = pending.findIndex(entry => entry.request.id === id);
  if (index === -1) return false;
  const [entry] = pending.splice(index, 1);
  if (decision === 'allow-session' && entry.request.allowanceKey) {
    let keys = allowances.get(entry.request.sessionId);
    if (!keys) {
      keys = new Set();
      allowances.set(entry.request.sessionId, keys);
    }
    keys.add(entry.request.allowanceKey);
  }
  notifyListeners();
  entry.resolve(decision);
  return true;
}

export function sessionAllowances(sessionId: string): string[] {
  return [...(allowances.get(sessionId) ?? [])];
}

export function clearSessionAllowances(sessionId: string): void {
  if (allowances.delete(sessionId)) notifyListeners();
}

// A judge verdict recorded for a tool call, so the transcript can show it.
export function judgeVerdictFor(callId: string): JudgeVerdict | undefined {
  return verdicts.get(callId);
}

export function isAwaitingJudge(callId: string): boolean {
  return checking.has(callId);
}

export function isAwaitingApproval(callId: string): boolean {
  return pending.some(entry => entry.request.call.id === callId);
}

export const DECLINED_PREFIX = 'The user declined to allow';

export function isDeclinedResult(result: string): boolean {
  return result.startsWith(DECLINED_PREFIX);
}

function requestApproval(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
  throwIfAborted(signal);
  return new Promise<ApprovalDecision>((resolve, reject) => {
    const entry: PendingEntry = { request, resolve, reject };
    const onAbort = () => {
      const index = pending.indexOf(entry);
      if (index !== -1) pending.splice(index, 1);
      notifyListeners();
      reject(abortReason(signal!));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    entry.resolve = decision => {
      signal?.removeEventListener('abort', onAbort);
      resolve(decision);
    };
    pending.push(entry);
    notifyListeners();
  });
}

async function judge(
  call: ToolCallBlock,
  directory: string,
  context: PermissionContext,
  signal?: AbortSignal,
): Promise<JudgeVerdict> {
  const command = String(call.arguments.command ?? '');
  const cached = judgeCache.get(context.sessionId)?.get(command);
  if (cached) {
    verdicts.set(call.id, cached);
    notifyListeners();
    return cached;
  }
  checking.add(call.id);
  notifyListeners();
  let verdict: JudgeVerdict;
  try {
    verdict = await judgeShellCommand(command, directory, context.model, signal);
  } finally {
    checking.delete(call.id);
  }
  let cache = judgeCache.get(context.sessionId);
  if (!cache) {
    cache = new Map();
    judgeCache.set(context.sessionId, cache);
  }
  cache.set(command, verdict);
  verdicts.set(call.id, verdict);
  notifyListeners();
  return verdict;
}

// Returns null when the call may run, or the error text for the model when
// the user declined. Throws the abort reason if the turn is cancelled while
// a prompt or the judge is outstanding.
export async function authorizeToolCall(
  call: ToolCallBlock,
  directory: string,
  context: PermissionContext,
  signal?: AbortSignal,
): Promise<string | null> {
  const mode = context.mode();
  if (mode === 'bypass') return null;

  let toolClass = classifyToolCall(call, directory);
  if (toolClass === 'read') return null;
  if (mode === 'auto' && toolClass === 'write') return null;

  let reason: string;
  if (mode === 'auto' && toolClass === 'unsure') {
    const verdict = await judge(call, directory, context, signal);
    throwIfAborted(signal);
    if (verdict === 'approve') return null;
    toolClass = 'sensitive';
    reason = 'judge: sensitive';
  } else {
    reason = toolClass === 'sensitive' ? sensitiveReason(call, directory) : toolClass;
  }

  const allowanceKey = toolClass === 'sensitive' ? null : allowanceKeyFor(call, directory);
  if (allowanceKey && allowances.get(context.sessionId)?.has(allowanceKey)) return null;

  const decision = await requestApproval({
    id: crypto.randomUUID(),
    sessionId: context.sessionId,
    requester: context.requester,
    call,
    toolClass,
    reason,
    detail: describeToolCall(call, directory),
    allowanceKey,
  }, signal);
  if (decision === 'deny') {
    return `${DECLINED_PREFIX} ${call.name} (${describeToolCall(call, directory)[0]}). Do not retry it; explain what you wanted to do or ask the user.`;
  }
  return null;
}

function sensitiveReason(call: ToolCallBlock, directory: string): string {
  if (call.name === 'WriteFile' || call.name === 'EditFile') return 'sensitive: outside the session directory';
  if (call.name === 'RunShell') {
    const culprit = splitShellCommand(String(call.arguments.command ?? ''))
      ?.find(simple => classifySimpleCommand(simple, directory) === 'sensitive');
    return culprit && culprit.words.length > 0 ? `sensitive: ${culprit.words.slice(0, 2).join(' ')}` : 'sensitive';
  }
  return 'sensitive';
}
