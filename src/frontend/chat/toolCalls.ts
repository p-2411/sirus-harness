import path from 'path';
import { singleLine } from '../terminal/text';
import { toolRegistry } from '../../agent_runtime/tools';
import type { ToolCallBlock, ToolCallDiff, ToolKind } from '../../agent_runtime/types';

// How a tool call reads, wherever it is shown: the line that names it in the
// transcript, on an approval prompt, in the turn status and in a
// notification; the change it made, as numbered lines; why it failed; and a
// run of calls summed up in a phrase. Everything here is text; the rows that
// show it are in `ChatMessage`.

// ── Naming a call ────────────────────────────────────────────────────────

// The verb a row leads with, from ACP's kind, unless the vendor's title
// carries one already. Thinking, mode changes and other tools have none:
// their titles are all they say.
const TOOL_VERBS: Record<ToolKind, string> = {
  read: 'Read',
  edit: 'Edit',
  delete: 'Delete',
  move: 'Move',
  search: 'Search',
  execute: 'Run',
  think: '',
  fetch: 'Fetch',
  switch_mode: '',
  other: '',
};

// Titles that open with a verb of their own: Claude's "Read src/app.ts",
// "Write notes.txt" and "Find `*.ts`", Codex's "Read file 'x'", "Search for
// 'q'", "List files" and "Web search: q". The kind's verb would say it twice.
const TITLE_VERB = /^(?:read|edit|editing|write|writing|run|search|searching|find|fetch|grep|list|view|open|load|delete|move|create|update|get|apply|preparing|web search)\b/i;

// What a file change is called before the vendor says which file: Codex's
// "Editing files" and "Edit files", Claude's bare "Edit".
const UNNAMED_EDIT = /^(?:editing files|edit files|edit|preparing file…?)$/i;

// A tool the vendor reached over MCP, under its MCP name: Claude's
// `mcp__server__tool`, codex-acp's `mcp.server.tool`.
const MCP_TITLE = /^mcp(?:__(.+?)__|\.([^.\s]+)\.)(\S+)$/;

// The name Sirus's own MCP server goes by (`sirusMcpServerEntry`).
const SIRUS_SERVER = 'sirus';

// The reviewer codex-acp runs in auto mode reports each review as a call of
// its own, under this id.
const REVIEW_ID = 'guardian_assessment:';

type NamedCall = Pick<ToolCallBlock, 'kind' | 'title'> & Partial<Pick<ToolCallBlock, 'id' | 'input' | 'content' | 'locations'>>;

export interface CallLabel {
  verb: string;
  subject: string;
}

function relative(text: string, directory?: string): string {
  return directory ? text.split(`${directory}${path.sep}`).join('') : text;
}

// The arguments of an MCP call: codex-acp wraps them with the server and the
// tool's name, Claude sends them as they are.
export function callArguments(call: Pick<ToolCallBlock, 'input'>): Record<string, unknown> {
  const input = call.input;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return {};
  const wrapped = input as { server?: unknown; tool?: unknown; arguments?: unknown };
  if (typeof wrapped.server === 'string' && typeof wrapped.tool === 'string') {
    const args = wrapped.arguments;
    return args !== null && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
  }
  return input as Record<string, unknown>;
}

// The plan a call puts up for approval: Claude's ExitPlanMode. Null for
// anything else.
export function planText(call: Pick<ToolCallBlock, 'kind' | 'input'>): string | null {
  const input = call.input;
  if (call.kind !== 'switch_mode' || input === null || typeof input !== 'object' || !('plan' in input)) return null;
  return typeof input.plan === 'string' && input.plan.trim() ? input.plan.trim() : null;
}

function firstLine(text: string): string {
  return text.split('\n').map(line => line.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '';
}

// A review's own report, "Status: Denied\nAction: shell rm -rf build", read
// back into a line.
function reviewLabel(call: NamedCall): CallLabel {
  const report = (call.content ?? []).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
  const field = (name: string) => new RegExp(`^${name}: (.*)$`, 'm').exec(report)?.[1]?.trim() ?? '';
  const status = field('Status').toLowerCase() || 'in progress';
  return { verb: '', subject: `Auto-review ${status}${field('Action') ? `: ${field('Action')}` : ''}` };
}

export function isReview(call: Pick<ToolCallBlock, 'id'>): boolean {
  return call.id.startsWith(REVIEW_ID);
}

// A review nobody needs to read: one that approved the action, which then
// shows as a row of its own, or one still under way.
export function isRoutineReview(call: Pick<ToolCallBlock, 'id' | 'status'>): boolean {
  return isReview(call) && call.status !== 'failed';
}

// The files a change touched, for a vendor title that names none.
function changedFiles(call: NamedCall, directory?: string): string {
  const paths = [...new Set([
    ...(call.content ?? []).flatMap(block => block.type === 'diff' ? [block.path] : []),
    ...(call.locations ?? []).map(location => location.path),
  ])].map(file => relative(file, directory));
  if (paths.length <= 1) return paths[0] ?? '';
  return `${paths[0]} and ${paths.length - 1} more file${paths.length === 2 ? '' : 's'}`;
}

// How a call is named: Sirus's own tools by the label they give themselves,
// other MCP tools by server and tool, a plan by its heading, and anything
// else by the kind's verb and the vendor's title, with paths inside the
// session's directory made relative to it.
export function callLabel(call: NamedCall, directory?: string): CallLabel {
  const title = relative(singleLine(call.title), directory);
  const mcp = MCP_TITLE.exec(title);
  if (mcp) {
    const server = mcp[1] ?? mcp[2]!;
    const tool = mcp[3]!;
    const own = server === SIRUS_SERVER ? toolRegistry.find(candidate => candidate.name === tool) : undefined;
    if (own) return own.label(callArguments(call));
    return { verb: '', subject: `${server} - ${tool} (MCP)` };
  }
  const plan = planText(call);
  if (plan !== null) return { verb: '', subject: `Plan: ${firstLine(plan)}` };
  if (call.id && isReview({ id: call.id })) return reviewLabel(call);
  const verb = TOOL_VERBS[call.kind];
  if (call.kind === 'edit' && UNNAMED_EDIT.test(title)) {
    const files = changedFiles(call, directory);
    if (files) return { verb, subject: files };
  }
  if (!verb || TITLE_VERB.test(title)) return { verb: '', subject: title };
  return { verb, subject: title };
}

// The whole line as one string, for the callers with no row to lay it out:
// the approval prompt, the turn status and the desktop notification name a
// call the way the transcript does. `limit` cuts what the call acts on where
// the caller has less room than a row.
export function toolLine(call: NamedCall, limit?: number, directory?: string): string {
  const { verb, subject } = callLabel(call, directory);
  const shown = limit !== undefined && subject.length > limit ? `${subject.slice(0, limit - 1)}…` : subject;
  return singleLine([verb, shown].filter(Boolean).join(' ')) || 'Tool call';
}

// A live call describes an action, while its transcript row names the call.
// Only change verbs whose continuous form is unambiguous; a noun title keeps
// the ordinary "running" prefix.
const ACTIVITY_VERBS: Record<string, string> = {
  apply: 'applying', cancel: 'cancelling', check: 'checking', create: 'creating',
  delete: 'deleting', edit: 'editing', fetch: 'fetching', find: 'finding',
  get: 'getting', grep: 'grepping', list: 'listing', load: 'loading',
  message: 'messaging', move: 'moving', open: 'opening', read: 'reading',
  run: 'running', save: 'saving', search: 'searching', start: 'starting',
  update: 'updating', view: 'viewing', wait: 'waiting', write: 'writing',
};

export function runningToolLine(call: NamedCall, limit?: number, directory?: string): string {
  const line = toolLine(call, limit, directory);
  if (/^Web search\b/i.test(line)) return `searching the web${line.slice('Web search'.length)}`;
  const first = /^([A-Za-z]+)\b/.exec(line)?.[1];
  const doing = first && ACTIVITY_VERBS[first.toLowerCase()];
  if (doing) return `${doing}${line.slice(first.length)}`;
  if (/^(?:editing|preparing|searching|writing)\b/i.test(line)) return line.replace(/^./, char => char.toLowerCase());
  return `running ${line}`;
}

// A call's arguments as readable lines, a long value over several: what an
// approval prompt and an opened row show when there is nothing better.
export function argumentLines(call: Pick<ToolCallBlock, 'input'>): string[] {
  const input = call.input;
  if (input === undefined || input === null) return [];
  if (typeof input !== 'object' || Array.isArray(input)) {
    return (typeof input === 'string' ? input : JSON.stringify(input) ?? String(input)).split('\n');
  }
  return Object.entries(callArguments(call)).flatMap(([name, value]) => {
    if (value === undefined || value === '' || value === null) return [];
    const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
    return text.includes('\n') ? [`${name}:`, ...text.split('\n').map(line => `  ${line}`)] : [`${name}: ${text}`];
  });
}

// ── What a file change did ───────────────────────────────────────────────

export interface DiffLine {
  // A note, not a line of the file, is marked '…': a gap between hunks, a
  // file's name, or how much was left out.
  sign: '+' | '-' | ' ' | '…';
  text: string;
  // The line's number: the old file's for a removed line, the new file's
  // otherwise. Absent where the vendor gave no position, and on notes.
  line?: number;
}

// Unchanged lines kept around each change, as both vendors show a hunk.
const DIFF_CONTEXT = 3;

// Past this many changed lines the middle of a file is taken as replaced
// whole; a rewrite that large reads the same either way.
const MAX_EDIT_DISTANCE = 1000;

// How many lines of a change a row shows before saying how many are left.
export const DIFF_PREVIEW_LINES = 20;

type LineEdit = '=' | '-' | '+';

function linesOf(text: string | null): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  // A final newline ends the last line; it does not start another.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// The fewest lines removed and added that turn `a` into `b`, by Myers' O(ND)
// algorithm. Null past MAX_EDIT_DISTANCE.
function shortestEdit(a: readonly string[], b: readonly string[]): LineEdit[] | null {
  const max = Math.min(a.length + b.length, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  // frontier[offset + k]: how far along `a` the furthest path on diagonal k
  // has reached. Each round's frontier is kept to walk the path back.
  const frontier = new Int32Array(2 * max + 3);
  const rounds: Int32Array[] = [];
  const fromBelow = (current: Int32Array, d: number, k: number) =>
    k === -d || (k !== d && current[offset + k - 1]! < current[offset + k + 1]!);
  for (let d = 0; d <= max; d++) {
    rounds.push(frontier.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = fromBelow(frontier, d, k) ? frontier[offset + k + 1]! : frontier[offset + k - 1]! + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) { x++; y++; }
      frontier[offset + k] = x;
      if (x < a.length || y < b.length) continue;
      const edits: LineEdit[] = [];
      for (let round = d; round >= 0; round--) {
        const previous = rounds[round]!;
        const diagonal = x - y;
        const down = fromBelow(previous, round, diagonal);
        const fromX = previous[offset + (down ? diagonal + 1 : diagonal - 1)]!;
        const fromY = fromX - (down ? diagonal + 1 : diagonal - 1);
        while (x > fromX && y > fromY) { edits.push('='); x--; y--; }
        if (round > 0) edits.push(down ? '+' : '-');
        x = fromX;
        y = fromY;
      }
      return edits.reverse();
    }
  }
  return null;
}

// The lines both ends share are set aside first, which leaves the ordinary
// edit a small middle to compare.
function lineEdits(a: readonly string[], b: readonly string[]): LineEdit[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const middle = shortestEdit(a.slice(start, endA), b.slice(start, endB))
    ?? [...Array<LineEdit>(endA - start).fill('-'), ...Array<LineEdit>(endB - start).fill('+')];
  return [...Array<LineEdit>(start).fill('='), ...middle, ...Array<LineEdit>(a.length - endA).fill('=')];
}

// Diffs are immutable once recorded, and a row asks for its edits on every
// paint, so each diff is compared once.
const editCache = new WeakMap<ToolCallDiff, LineEdit[]>();

function editsOf(diff: ToolCallDiff): LineEdit[] {
  let edits = editCache.get(diff);
  if (!edits) {
    edits = lineEdits(linesOf(diff.oldText), linesOf(diff.newText));
    editCache.set(diff, edits);
  }
  return edits;
}

export function diffsOf(call: Pick<ToolCallBlock, 'content'>): ToolCallDiff[] {
  return call.content.filter((block): block is ToolCallDiff => block.type === 'diff');
}

// Lines added and removed by a file change, compared line by line: a vendor
// sends the text before and after, whole files from Codex and hunks with
// their context from Claude, and neither counts as changed. Null for a call
// that changed no file.
export function editCounts(call: Pick<ToolCallBlock, 'content'>): { added: number; removed: number } | null {
  const diffs = diffsOf(call);
  if (diffs.length === 0) return null;
  let added = 0;
  let removed = 0;
  for (const edit of diffs.flatMap(editsOf)) {
    if (edit === '+') added++;
    else if (edit === '-') removed++;
  }
  return { added, removed };
}

// One diff as numbered lines: each change with the unchanged lines around
// it, and a gap marker where more unchanged lines were left out.
function hunkLines(diff: ToolCallDiff, oldStart: number | undefined): DiffLine[] {
  const before = linesOf(diff.oldText);
  const after = linesOf(diff.newText);
  const edits = editsOf(diff);
  const near = edits.map(() => false);
  edits.forEach((edit, index) => {
    if (edit === '=') return;
    for (let at = Math.max(0, index - DIFF_CONTEXT); at <= Math.min(edits.length - 1, index + DIFF_CONTEXT); at++) near[at] = true;
  });
  const lines: DiffLine[] = [];
  let oldAt = 0;
  let newAt = 0;
  let skipped = false;
  const number = (start: number | undefined, at: number) => start === undefined ? {} : { line: start + at };
  edits.forEach((edit, index) => {
    if (near[index]) {
      if (skipped && lines.length > 0) lines.push({ sign: '…', text: '' });
      skipped = false;
      if (edit === '-') lines.push({ sign: '-', text: before[oldAt]!, ...number(oldStart, oldAt) });
      else lines.push({ sign: edit === '+' ? '+' : ' ', text: after[newAt]!, ...number(diff.line, newAt) });
    } else {
      skipped = true;
    }
    if (edit !== '+') oldAt++;
    if (edit !== '-') newAt++;
  });
  return lines;
}

// The change a call made, as both vendors show one: numbered lines, removed
// and added, with a little of what surrounds them. A call that touched more
// than one file names each; `limit` cuts the preview and says how much is
// left. Empty for anything that changed no file.
export function editPreview(call: Pick<ToolCallBlock, 'content'>, limit?: number, directory?: string): DiffLine[] {
  const diffs = diffsOf(call);
  const files = new Set(diffs.map(diff => diff.path));
  const lines: DiffLine[] = [];
  // How far each file's new numbering has run ahead of its old by the start
  // of the next hunk: the lines its earlier hunks added less those removed.
  const shift = new Map<string, number>();
  for (const diff of diffs) {
    const seen = shift.get(diff.path);
    if (files.size > 1 && seen === undefined) lines.push({ sign: '…', text: relative(diff.path, directory) });
    else if (seen !== undefined) lines.push({ sign: '…', text: '' });
    const offset = seen ?? 0;
    lines.push(...hunkLines(diff, diff.line === undefined ? undefined : diff.line - offset));
    shift.set(diff.path, offset + linesOf(diff.newText).length - linesOf(diff.oldText).length);
  }
  if (limit === undefined || lines.length <= limit) return lines;
  const hidden = lines.length - limit;
  return [...lines.slice(0, limit), { sign: '…', text: `${hidden} more line${hidden === 1 ? '' : 's'}` }];
}

// ── What a call produced ─────────────────────────────────────────────────

// The text a call produced: its text content, or its raw output when that is
// text, a shell result (codex-acp's `formatted_output`), or an MCP result
// (its text content, or its error).
export function outputText(call: Pick<ToolCallBlock, 'content' | 'output'>): string {
  const text = call.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
  if (text) return text;
  const output = call.output;
  if (typeof output === 'string') return output;
  if (output === null || typeof output !== 'object') return '';
  const value = output as { formatted_output?: unknown; result?: unknown; error?: unknown };
  if (typeof value.formatted_output === 'string') return value.formatted_output;
  const error = value.error as { message?: unknown } | string | null | undefined;
  if (typeof error === 'string') return error;
  if (typeof error?.message === 'string') return error.message;
  const content = (value.result as { content?: unknown } | null | undefined)?.content;
  return Array.isArray(content)
    ? content.flatMap(item => typeof item?.text === 'string' ? [item.text as string] : []).join('\n')
    : '';
}

// The exit code a shell call ended with, when the vendor said.
function exitCode(call: Pick<ToolCallBlock, 'output'>): number | null {
  const output = call.output as { exit_code?: unknown } | null | undefined;
  return typeof output?.exit_code === 'number' ? output.exit_code : null;
}

// How many lines of a failure's output a row shows, from the end.
const FAILURE_TAIL_LINES = 8;

// Why a call failed, the way the vendors' terminals say it: the exit code of
// a command, when there was one, and the end of what the call printed or the
// error it raised. Claude fences an error's text and wraps a tool's own
// complaint in <tool_use_error>; both go.
export function failureDetail(call: Pick<ToolCallBlock, 'content' | 'output'>): DiffLine[] {
  const text = outputText(call).trim()
    .replace(/^```[^\n]*\n([\s\S]*?)\n?```$/, '$1').trim()
    .replace(/^<tool_use_error>([\s\S]*?)<\/tool_use_error>$/, '$1').trim();
  const lines = text ? text.split('\n') : [];
  const tail = lines.slice(-FAILURE_TAIL_LINES);
  const code = exitCode(call);
  return [
    ...(code !== null && !/^exit code \d+/i.test(lines[0] ?? '') ? [{ sign: ' ' as const, text: `Exit code ${code}` }] : []),
    ...(lines.length > tail.length ? [{ sign: '…' as const, text: `${lines.length - tail.length} earlier lines` }] : []),
    ...tail.map(line => ({ sign: ' ' as const, text: line })),
  ];
}

// ── A run of calls ───────────────────────────────────────────────────────

// How a group of calls is summed up, kind by kind: "Read 2 files, edited 1
// file", or while they run, "Reading 2 files, editing 1 file". MCP tools are
// tools whatever kind the vendor gave them.
type RunKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'tool';

const RUN_WORDS: Record<RunKind, { done: string; doing: string; one: string; many: string }> = {
  read: { done: 'read', doing: 'reading', one: 'file', many: 'files' },
  edit: { done: 'edited', doing: 'editing', one: 'file', many: 'files' },
  delete: { done: 'deleted', doing: 'deleting', one: 'file', many: 'files' },
  move: { done: 'moved', doing: 'moving', one: 'file', many: 'files' },
  search: { done: 'searched for', doing: 'searching for', one: 'pattern', many: 'patterns' },
  execute: { done: 'ran', doing: 'running', one: 'command', many: 'commands' },
  fetch: { done: 'fetched', doing: 'fetching', one: 'page', many: 'pages' },
  tool: { done: 'used', doing: 'using', one: 'tool', many: 'tools' },
};

function runKind(call: Pick<ToolCallBlock, 'kind' | 'title'>): RunKind {
  if (MCP_TITLE.test(singleLine(call.title))) return 'tool';
  switch (call.kind) {
    case 'think': case 'switch_mode': case 'other': return 'tool';
    default: return call.kind;
  }
}

export function finished(call: Pick<ToolCallBlock, 'status'>): boolean {
  return call.status === 'completed' || call.status === 'failed';
}

// How a call ended, when it did not end well: declined, cancelled, or
// failed. Null for one that completed or has not ended.
export function stopLabel(call: Pick<ToolCallBlock, 'status' | 'outcome'>): 'declined' | 'cancelled' | 'failed' | null {
  if (call.outcome) return call.outcome;
  return call.status === 'failed' ? 'failed' : null;
}

export function groupSummary(calls: readonly ToolCallBlock[]): string {
  const kinds = new Map<RunKind, ToolCallBlock[]>();
  for (const call of calls) {
    const kind = runKind(call);
    kinds.set(kind, [...(kinds.get(kind) ?? []), call]);
  }
  const phrase = [...kinds].map(([kind, members]) => {
    const words = RUN_WORDS[kind];
    const verb = members.every(finished) ? words.done : words.doing;
    return `${verb} ${members.length} ${members.length === 1 ? words.one : words.many}`;
  }).join(', ');
  const stops = new Map<string, number>();
  for (const call of calls) {
    const stop = stopLabel(call);
    if (stop) stops.set(stop, (stops.get(stop) ?? 0) + 1);
  }
  const tail = [...stops].map(([label, count]) => `${count} ${label}`).join(', ');
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}${tail ? ` · ${tail}` : ''}`;
}
