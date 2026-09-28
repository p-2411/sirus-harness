import { homedir } from 'node:os';
import { marked } from 'marked';
import type { Session } from '../agent_runtime/session';
import { DEFAULT_PARTICIPANT, type Message, type ToolCallBlock } from '../agent_runtime/types';
import { describeRequester, pendingApprovals, type Requester } from '../agent_runtime/permissions/approvals';
import { pendingQuestions } from '../agent_runtime/permissions/questions';
import { PERMISSION_MODE_NAMES } from '../agent_runtime/permissions/policy';
import { VENDOR_INFO, vendorOf } from '../agent_runtime/providers/catalog';
import { turnPhase } from '../frontend/chat/Chat';
import { visibleContent } from '../frontend/chat/ChatMessage';
import { historyParts } from '../frontend/chat/history';
import { approvalDetail } from '../frontend/chat/ApprovalPrompt';
import { contextGauge, shownThinkingLevel } from '../frontend/chat/StatusRow';
import { editPreview, failureDetail, outputText, planText, stopLabel, toolLine, type DiffLine } from '../frontend/chat/toolCalls';

// The frames the phone draws, protocol v1 as the remote control spec has it.
// Sirus shapes everything here, in the TUI's own words, so the app only
// draws what it is given.

export interface Block {
  kind: 'paragraph' | 'heading' | 'code' | 'quote' | 'list' | 'rule';
  text?: string;
  level?: number;
  language?: string;
  items?: string[];
  ordered?: boolean;
}

export interface Row {
  id: string;
  kind: 'user' | 'assistant' | 'tool' | 'notice' | 'compaction';
  author: string;
  to?: string[];
  blocks?: Block[];
  tool?: { title: string; kind: string; state: 'running' | 'done' | 'failed' | 'declined' | 'cancelled'; detail: Block[] };
  time?: number;
}

export interface ViewFrame {
  type: 'view';
  sessionId: string;
  participant: string;
  reset: boolean;
  header: {
    participants: { name: string; model: string; vendor?: string; working: boolean; needsYou: boolean }[];
    status: { participant: string; thought: string; startedAt: number } | null;
    queued: number;
    permissionMode: string;
    // The rest of the TUI's status row for the participant on view: what
    // the vendor made of the mode, the context gauge, the thinking level.
    modeNotice: string | null;
    context: ReturnType<typeof contextGauge> | null;
    thinking: string | null;
  };
  rows: Row[];
  removed: string[];
  requests: Record<string, unknown>[];
}

// The conversation the phone gets is the end of it.
const ROW_LIMIT = 200;
// A tool row's detail is a glance, not the output.
const DETAIL_LINES = 12;

// Streaming re-renders the same text every frame; lexing it once is enough.
const lexed = new Map<string, Block[]>();
const LEXED_LIMIT = 1000;

// Markdown split into blocks by marked's lexer, each holding inline markdown
// only, which is all the app renders itself. A table keeps its columns as
// code; anything else the lexer knows is a paragraph of its source.
export function markdownBlocks(text: string): Block[] {
  const cached = lexed.get(text);
  if (cached) return cached;
  const blocks = marked.lexer(text).flatMap((token): Block[] => {
    switch (token.type) {
      case 'space': case 'def': return [];
      case 'heading': return [{ kind: 'heading', text: token.text, level: token.depth }];
      case 'code': return [{ kind: 'code', text: token.text, ...(token.lang ? { language: token.lang } : {}) }];
      case 'blockquote': return [{ kind: 'quote', text: token.text.trim() }];
      case 'list': return [{ kind: 'list', items: token.items.map((item: { text: string }) => item.text), ordered: token.ordered }];
      case 'hr': return [{ kind: 'rule' }];
      case 'table': return [{ kind: 'code', text: token.raw.trim() }];
      case 'paragraph': return [{ kind: 'paragraph', text: token.text }];
      default: return token.raw.trim() ? [{ kind: 'paragraph', text: token.raw.trim() }] : [];
    }
  });
  if (lexed.size >= LEXED_LIMIT) lexed.clear();
  lexed.set(text, blocks);
  return blocks;
}

function codeBlock(lines: readonly string[]): Block[] {
  return lines.length ? [{ kind: 'code', text: lines.join('\n') }] : [];
}

// Lines of a change or a failure, marked the way the approval card marks them.
function diffLines(lines: readonly DiffLine[]): string[] {
  return lines.map(line => line.sign === ' ' ? line.text : `${line.sign} ${line.text}`);
}

function toolState(call: ToolCallBlock): NonNullable<Row['tool']>['state'] {
  return stopLabel(call) ?? (call.status === 'completed' ? 'done' : 'running');
}

// What a tool row shows under its title: why it failed, the change it made,
// the plan it set, or the end of what a command printed.
function toolDetail(call: ToolCallBlock, directory: string): Block[] {
  if (call.status === 'failed' && !call.outcome) return codeBlock(diffLines(failureDetail(call)));
  const diff = editPreview(call, DETAIL_LINES, directory);
  if (diff.length) return codeBlock(diffLines(diff));
  const plan = planText(call);
  if (plan) return codeBlock(plan.split('\n'));
  if (call.kind !== 'execute') return [];
  const output = outputText(call).trimEnd();
  return codeBlock(output ? output.split('\n').slice(-DETAIL_LINES) : []);
}

// One entry of the history as rows: a tool row per call, and a row for each
// run of prose between them. A row's id is its entry's key and its place in
// the entry, which stays put while the entry streams, since blocks only ever
// arrive at the end. Thoughts, images and the files a prompt mentioned are
// left out, as the TUI leaves them out of the conversation.
function rowsOf(message: Message, key: string, directory: string): Row[] {
  const author = message.role === 'user' ? 'you' : message.participant ?? DEFAULT_PARTICIPANT;
  const time = message.startedAt ?? message.finishedAt;
  const common = { author, ...(message.role === 'user' ? { to: message.to ?? [] } : {}), ...(time !== undefined ? { time } : {}) };
  const rows: Row[] = [];
  let prose: { kind: Row['kind']; text: string[] } | null = null;
  const flush = () => {
    if (prose) rows.push({ id: `${key}:${rows.length}`, kind: prose.kind, ...common, blocks: markdownBlocks(prose.text.join('\n\n')) });
    prose = null;
  };
  const add = (kind: Row['kind'], text: string) => {
    if (prose?.kind !== kind) flush();
    prose ??= { kind, text: [] };
    prose.text.push(text);
  };
  for (const block of visibleContent(message.content)) {
    if (block.type === 'text' && !block.filePath) add(message.role, block.text);
    else if (block.type === 'notice') add('notice', [block.title, block.description].filter(Boolean).join('\n\n'));
    else if (block.type === 'compaction') add('compaction', block.summary?.trim() || 'Conversation compacted.');
    else if (block.type === 'tool_call') {
      flush();
      rows.push({ id: `${key}:${rows.length}`, kind: 'tool', ...common, tool: {
        title: toolLine(block, undefined, directory), kind: block.kind, state: toolState(block), detail: toolDetail(block, directory),
      } });
    }
  }
  flush();
  return rows;
}

// The participant a request is waiting on: its own, or for a worker's, the
// participant that spawned the worker.
export function requestOwner(session: Session, requester: Requester): string | undefined {
  return 'participant' in requester ? requester.participant
    : session.getWorkers().find(worker => worker.id === requester.subagent)?.owner;
}

function requestsOf(session: Session): Record<string, unknown>[] {
  const approvals = pendingApprovals(session.getId()).map(request => ({
    id: request.id, kind: 'approval', requester: describeRequester(request.requester),
    title: toolLine(request.toolCall, undefined, session.getDirectory()),
    detail: codeBlock(approvalDetail(request.toolCall)),
    options: request.options.map(option => ({ id: option.optionId, label: option.name, kind: option.kind })),
  }));
  const questions = pendingQuestions(session.getId()).map(request => ({
    id: request.id, kind: 'question', requester: describeRequester(request.requester),
    message: request.message, fields: request.fields,
  }));
  return [...approvals, ...questions];
}

// Whether an approval or question is waiting on this participant or its workers.
function needsYou(session: Session, participant: string): boolean {
  return [...pendingApprovals(session.getId()), ...pendingQuestions(session.getId())]
    .some(request => requestOwner(session, request.requester) === participant);
}

// What the TUI's status line says while the participant works.
function statusOf(session: Session, participant: string, messages: readonly Message[]): ViewFrame['header']['status'] {
  if (!session.isParticipantWorking(participant)) return null;
  const waiting = (requests: readonly { requester: Requester }[]) =>
    requests.some(request => requestOwner(session, request.requester) === participant);
  const thought = waiting(pendingApprovals(session.getId())) ? 'waiting for your approval'
    : waiting(pendingQuestions(session.getId())) ? 'waiting for your answer'
    : session.isCompacting() ? 'compacting context'
    : turnPhase(messages, session.getDirectory());
  return { participant, thought, startedAt: session.getActiveTurnStartedAt() ?? Date.now() };
}

// The whole view of one participant's conversation. The listener sends the
// difference from what the phone already has.
export function viewOf(session: Session, participant: string): ViewFrame {
  const messages = session.getMessages(participant).filter(message => !message.hidden);
  const directory = session.getDirectory();
  const contextUsage = session.getContextUsage(participant);
  return {
    type: 'view', sessionId: session.getId(), participant, reset: false,
    header: {
      participants: session.getParticipants().map(agent => {
        const vendor = vendorOf(agent.model);
        return {
          name: agent.name, model: agent.model, ...(vendor ? { vendor: VENDOR_INFO[vendor].displayName } : {}),
          working: session.isParticipantWorking(agent.name) || session.hasWorkingWorkers(agent.name), needsYou: needsYou(session, agent.name),
        };
      }),
      status: statusOf(session, participant, messages),
      queued: session.getQueuedMessageCount(),
      permissionMode: PERMISSION_MODE_NAMES[session.getPermissionMode()],
      modeNotice: session.getModeNotice(participant),
      context: contextUsage ? contextGauge(contextUsage) : null,
      thinking: shownThinkingLevel(session, participant) ?? null,
    },
    rows: historyParts(messages).flatMap(part => rowsOf(part.message, part.key, directory)).slice(-ROW_LIMIT),
    removed: [],
    requests: requestsOf(session),
  };
}

// A directory under the home directory as `~/…`; only a leading match counts.
function homeRelative(directory: string): string {
  const home = homedir();
  return directory === home || directory.startsWith(`${home}/`) ? `~${directory.slice(home.length)}` : directory;
}

// A session as the sessions list shows it. `status` and `assistantVersion`
// are what the TUI's sidebar marks come from: the phone applies the same
// rules, unread included, for the session it has open.
export function sessionEntry(session: Session) {
  return {
    id: session.getId(), name: session.getName(),
    directory: homeRelative(session.getDirectory()),
    status: session.getStatus(),
    // A running worker counts, as in the TUI's sidebar and header.
    working: session.getStatus() === 'working' || session.hasWorkingWorkers(),
    needsYou: pendingApprovals(session.getId()).length + pendingQuestions(session.getId()).length > 0,
    lastActivity: session.getLastActivity(),
    assistantVersion: session.getAssistantVersion(),
  };
}
