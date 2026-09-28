import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  DEFAULT_PARTICIPANT,
  isPlanCall,
  planEntriesOf,
  type ImageBlock,
  type Message,
  type MessageBlock,
  type PlanEntry,
  type ToolCallBlock,
} from '../../agent_runtime/types';
import { Session, type SessionSnapshot } from '../../agent_runtime/session';
import { readClipboard, removeStoredImage } from '../../images';
import { Box, Text, measureElement, renderToString, useApp, useBoxMetrics, useInput, useStdout, type DOMElement } from 'ink';
import { theme } from '../styles/theme';
import { singleLine, terminalText } from '../terminal/text';
import { HORSE } from '../branding/horse';
import { ChatHistory, PlanChecklist, thoughtHeading, toolLine } from './ChatMessage';
import { useClickable } from '../interaction/clickable';
import { Spinner } from './Spinner';
import { InputBar, createInputDraftState, type InputDraftState, type InputMode } from './InputBar';
import { AgentTabs, type AgentActivity } from './AgentTabs';
import { AgentHistory, type HistoryPosition } from './AgentHistory';
import { InputFeedback } from './InputRows';
import {
  commandMenu,
  commandRegistry,
  executeCommand,
  isSirusCommand,
  parseCommandLine,
} from '../../commands/registry';
import type { CommandMenuEntry, CommandMenuItem } from '../../commands/types';
import { parseMouseWheel } from '../interaction/mouse';
import { SIDEBAR_WIDTH } from '../Sidebar';
import { useSelectionRegion } from '../interaction/useTextSelection';
import type { Feedback } from '../../commands/feedback';
import { participantColorMap, type ParticipantColors } from '../MentionText';
import { isAbortError, TurnCancelledError } from '../../abort';
import {
  getPermissionsVersion,
  pendingApprovals,
  resolveApproval,
  subscribePermissions,
} from '../../agent_runtime/permissions/approvals';
import {
  getQuestionsVersion,
  pendingQuestions,
  resolveQuestion,
  subscribeQuestions,
} from '../../agent_runtime/permissions/questions';
import { allProviders } from '../../agent_runtime/providers';
import { onProviderChange } from '../../agent_runtime/providers/sources';
import { copyToClipboard } from '../terminal/clipboard';
import { nextPermissionMode } from '../../agent_runtime/permissions/policy';
import { getSubagentsVersion, subscribeSubagents } from '../../agent_runtime/tools/subagents';

export function ChatHeader({ session, activity = new Map(), width = 100, onSelect }: {
  session: Session;
  activity?: ReadonlyMap<string, AgentActivity>;
  width?: number;
  onSelect?: (name: string) => void;
}) {
  const participants = session.getParticipants();
  const desired = 2 + participants.reduce((sum, participant) => sum + Math.min(24, participant.name.length + 2), 0) + participants.length - 1;
  const tabWidth = Math.max(12, Math.min(desired, width - 4, Math.floor(width * 0.6)));
  return (
    <Box paddingLeft={3} paddingRight={1} justifyContent="space-between" alignItems="center" flexShrink={0} height={1}>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text wrap="truncate-middle">
          <Text color={theme.textMuted}>{terminalText(session.getName()).toUpperCase()}</Text>
          <Text color={theme.textSubtle} dimColor> {session.getDirectory()}</Text>
        </Text>
      </Box>
      <AgentTabs participants={participants} selected={session.getSelectedParticipant()}
        activity={activity} colors={participantColorMap(participants)} width={tabWidth} onSelect={onSelect} />
    </Box>
  );
}

interface AgentView {
  history: HistoryPosition;
  draft: InputDraftState;
  attachments: ImageBlock[];
  feedback: Feedback | null;
  reset: number;
  seen: string;
}
const agentViews = new WeakMap<Session, Map<string, AgentView>>();
function viewsFor(session: Session): Map<string, AgentView> {
  let views = agentViews.get(session);
  if (!views) { views = new Map(); agentViews.set(session, views); }
  for (const participant of session.getParticipants()) {
    if (!views.has(participant.name)) views.set(participant.name, {
      history: { offset: 0, height: 0 }, draft: createInputDraftState(), attachments: [], feedback: null, reset: 0,
      seen: activityStamp(session.getMessages(participant.name)),
    });
  }
  return views;
}
function activityStamp(messages: readonly Message[]): string {
  const last = [...messages].reverse().find(message => message.role === 'assistant' && !message.hidden);
  return last ? `${last.seq}:${last.content.length}:${last.content.reduce((length, block) =>
    length + (block.type === 'text' || block.type === 'thought' ? block.text.length : block.type === 'tool_call' ? block.status.length : 0), 0)}` : '';
}

// The user's earlier prompts, oldest first, without immediate repeats, for
// the input bar's ↑/↓ recall.
export function promptHistory(messages: readonly Message[]): string[] {
  const prompts: string[] = [];
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const text = message.content
      .filter(block => block.type === 'text')
      .filter(block => !block.filePath)
      .map(block => block.text)
      .join('\n')
      .trim();
    if (text && prompts[prompts.length - 1] !== text) prompts.push(text);
  }
  return prompts;
}

// The latest plan replaces the previous one, including when it clears the
// list. Reading the record also makes restored sessions and rewinds agree.
export function currentPlans(
  messages: readonly Message[],
  participants: readonly { name: string }[],
): { participant: string; entries: PlanEntry[] }[] {
  const latest = new Map<string, PlanEntry[]>();
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    const name = (message.participant ?? DEFAULT_PARTICIPANT).toLocaleLowerCase();
    if (latest.has(name)) continue;
    for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex--) {
      const block = message.content[blockIndex];
      if (block.type !== 'tool_call' || !isPlanCall(block)) continue;
      latest.set(name, planEntriesOf(block));
      break;
    }
  }
  return participants.flatMap(({ name }) => {
    const entries = latest.get(name.toLocaleLowerCase());
    // Unfinished tasks stay between turns; finishing the list hides it now.
    return entries?.some(entry => entry.status !== 'completed') ? [{ participant: name, entries }] : [];
  });
}

// Room for a tool title in the status line before it is cut.
const PHASE_TITLE_LENGTH = 40;

function turnThought(messages: readonly Message[]): string | null {
  const last = messages.at(-1);
  if (last?.role !== 'assistant') return null;
  const tail = last.content.at(-1);
  if (tail?.type !== 'thought' || !tail.text.trim()) return null;
  if (last.content.some(block => block.type === 'tool_call' && block.status !== 'completed' && block.status !== 'failed')) return null;
  return tail.text;
}

// What the agents are up to, read off the end of the timeline: the tool call
// the turn is waiting on, text arriving, or nothing visible yet.
export function turnPhase(messages: readonly Message[]): string {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return 'thinking';
  const running = [...last.content]
    .reverse()
    .find((block): block is ToolCallBlock =>
      block.type === 'tool_call' && block.status !== 'completed' && block.status !== 'failed');
  if (running) return `running ${toolLine(running, PHASE_TITLE_LENGTH)}`;
  const tail = last.content[last.content.length - 1];
  if (tail?.type === 'text' && tail.text) return 'writing';
  const thought = turnThought(messages);
  if (thought) {
    const { title, body } = thoughtHeading(thought);
    return title ?? body.replace(/\s+/g, ' ');
  }
  return 'thinking';
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

// A turn whose runtime has said nothing for this long says so, since a
// vendor that has stalled looks the same as one that is thinking.
const QUIET_NOTICE_MS = 60_000;

// The line at the foot of the history while a turn runs: what the agents are
// doing, or that they are waiting on the user, and for how long.
export function TurnStatus({ messages, awaitingApproval, awaitingAnswer, compacting, startedAt, quietFor }: {
  messages: readonly Message[];
  awaitingApproval: boolean;
  awaitingAnswer: boolean;
  compacting: boolean;
  startedAt: number;
  // Read on every tick: how long the runtimes have been silent.
  quietFor: () => number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const waitingOnUser = awaitingApproval || awaitingAnswer;
  const thought = waitingOnUser || compacting ? null : turnThought(messages);
  const last = messages.at(-1);
  const thoughtKey = thought && last ? `${last.seq}:${last.content.length}` : null;
  const [expandedThought, setExpandedThought] = useState<string | null>(null);
  const expanded = thoughtKey !== null && expandedThought === thoughtKey;
  const toggleThought = useCallback(() => setExpandedThought(expanded ? null : thoughtKey), [expanded, thoughtKey]);
  const phaseRef = useRef<DOMElement>(null);
  useClickable(phaseRef, toggleThought);
  const phase = awaitingApproval ? 'waiting for your approval'
    : awaitingAnswer ? 'waiting for your answer'
    : compacting ? 'compacting context'
      : turnPhase(messages);
  const quiet = waitingOnUser || compacting ? 0 : quietFor();
  return (
    <Box flexDirection="column" paddingX={3} marginBottom={1}>
      <Box>
        <Box flexShrink={0}><Spinner /></Box>
        <Box ref={phaseRef} flexShrink={1} minWidth={0}>
          <Text color={waitingOnUser ? theme.pending : theme.textSubtle} wrap="truncate-end">  {phase}</Text>
        </Box>
        <Box flexShrink={0}>
          <Text color={theme.textSubtle} dimColor> · {formatElapsed(now - startedAt)}</Text>
        </Box>
      </Box>
      {expanded && thought && (
        <Box paddingLeft={3}><Text color={theme.textSubtle}>{thoughtHeading(thought).body}</Text></Box>
      )}
      {quiet >= QUIET_NOTICE_MS && (
        <Text color={theme.pending} wrap="truncate-end">  no output for {formatElapsed(quiet)} · esc to cancel</Text>
      )}
    </Box>
  );
}

// Long command output borrows the history area, leaving the editor available.
// Its scroll position is independent from the conversation underneath it.
function CommandFeedbackPanel({ feedback, participantColors, sidebarWidth, paused }: {
  feedback: Feedback;
  participantColors: ParticipantColors;
  sidebarWidth: number;
  paused: boolean;
}) {
  const viewportRef = useRef<DOMElement>(null);
  const contentRef = useRef<DOMElement>(null);
  const { height: viewportHeight } = useBoxMetrics(viewportRef);
  const { height: contentHeight } = useBoxMetrics(contentRef);
  const [offset, setOffset] = useState(0);
  const maxScroll = Math.max(0, contentHeight - viewportHeight);
  const pageSize = Math.max(1, viewportHeight - 2);
  const visibleOffset = Math.min(offset, maxScroll);
  const text = useCallback(() => {
    const width = contentRef.current ? measureElement(contentRef.current).width : 0;
    if (width <= 0) return [];
    return renderToString(
      <InputFeedback feedback={feedback} participantColors={participantColors} />,
      { columns: width },
    ).split('\n');
  }, [feedback, participantColors]);
  useSelectionRegion(viewportRef, { follows: contentRef, text });

  useInput((input, key) => {
    if (paused) return;
    const wheel = parseMouseWheel(input);
    if (wheel && wheel.column > sidebarWidth) {
      setOffset(Math.max(0, Math.min(maxScroll, visibleOffset + (wheel.direction === 'up' ? -3 : 3))));
    } else if (key.pageUp) {
      setOffset(Math.max(0, visibleOffset - pageSize));
    } else if (key.pageDown) {
      setOffset(Math.min(maxScroll, visibleOffset + pageSize));
    } else if (key.ctrl && key.home) {
      setOffset(0);
    } else if (key.ctrl && key.end) {
      setOffset(maxScroll);
    }
  });

  return (
    <Box flexDirection="column" flexGrow={1} minHeight={0}>
      <Box ref={viewportRef} position="relative" flexGrow={1} minHeight={0} overflow="hidden">
        <Box ref={contentRef} position="absolute" top={-visibleOffset} width="100%" flexDirection="column" flexShrink={0}>
          <InputFeedback feedback={feedback} participantColors={participantColors} />
        </Box>
      </Box>
      <Box paddingX={3} height={1} flexShrink={0}>
        <Text color={theme.textSubtle}>pgup / pgdn · ctrl+home / end · esc closes</Text>
      </Box>
    </Box>
  );
}

export default function Chat({ currSession, onStartSession, sidebarWidth = SIDEBAR_WIDTH, onNewSession, onOpenSession, onResumeSession, onArchiveSession, onDeleteSession, active = true }: {
  currSession: Session;
  active?: boolean;
  onNewSession?: () => void;
  onOpenSession?: (snapshot: SessionSnapshot) => void;
  onResumeSession?: (query?: string) => void;
  onArchiveSession?: () => void;
  onDeleteSession?: () => void;
  sidebarWidth?: number;
  onStartSession?: (session: Session) => void;
}) {
  // Subscribe to the session: any mutation (append, setModel) bumps its
  // version and re-renders, so model and messages are read fresh below.
  useSyncExternalStore(
    (cb) => currSession.subscribe(cb),
    () => currSession.getVersion(),
  );
  useSyncExternalStore(subscribeSubagents, getSubagentsVersion);
  // A hidden entry belongs to the runtimes alone: a worker's report is in its
  // owner's record, but the user reads it under the SpawnAgent row that
  // started the worker, not as a message of its own.
  const selected = currSession.getSelectedParticipant();
  const views = viewsFor(currSession);
  const view = views.get(selected)!;
  const messages = currSession.getMessages(selected).filter(message => !message.hidden);
  const [, refreshView] = useState(0);
  const repaintView = () => refreshView(version => version + 1);
  useEffect(() => { view.seen = activityStamp(messages); }, [selected, currSession.getVersion()]);
  const participants = currSession.getParticipants();
  const participantColors = participantColorMap(participants);

  const [hasCredentials, setHasCredentials] = useState(() => allProviders().some(provider => provider.sources.list().length > 0));
  useEffect(() => onProviderChange(() => setHasCredentials(allProviders().some(provider => provider.sources.list().length > 0))), []);
  const [showTasks, setShowTasks] = useState(true);
  const plans = currentPlans(messages, participants.filter(participant => participant.name === selected));
  const [commandIsLoading, setCommandIsLoading] = useState(false);
  const [imageIsLoading, setImageIsLoading] = useState(false);
  const isWorking = currSession.isParticipantWorking(selected);
  const inputIsBusy = commandIsLoading || isWorking;
  const feedback = view.feedback;
  const setFeedback = (feedback: Feedback | null) => { view.feedback = feedback; repaintView(); };
  const notice = currSession.getNotice();
  useEffect(() => {
    if (!notice || notice.participant !== selected) return;
    const { severity, title, description } = notice.notice;
    setFeedback({
      kind: severity === 'error' || severity === 'warning' ? severity : 'info',
      text: `@${notice.participant}: ${singleLine([title, description].filter(Boolean).join(' · '))}`,
    });
  }, [notice, selected]);
  const panelFeedback = feedback?.panel ? feedback : null;
  const [inputMode, setInputMode] = useState<InputMode>({ type: 'text' });
  const [inputOverlay, setInputOverlay] = useState(false);
  // Draft attachments remain with their agent when the selected tab changes.
  const attachments = view.attachments;
  const replaceAttachments = (images: ImageBlock[]) => { view.attachments = images; repaintView(); };
  const attachImage = (image: ImageBlock) => replaceAttachments([...view.attachments, image]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const [name, saved] of views) {
        for (const image of saved.attachments) removeStoredImage(image);
        if (saved.attachments.length) {
          const text = [...currSession.getInputContent(name)].filter(character => !saved.draft.images.paths.has(character)).join('');
          currSession.setInputContent(text, name);
        }
        saved.attachments = [];
        saved.draft.images.paths.clear();
        saved.draft.images.seen = null;
      }
    };
  }, []);
  const pasteClipboard = () => {
    if (imageIsLoading) return;
    setImageIsLoading(true);
    return readClipboard()
      .then(content => {
        if (typeof content === 'string') return mounted.current ? content : undefined;
        if (!mounted.current) {
          removeStoredImage(content);
          return;
        }
        attachImage(content);
      })
      .catch((caught: unknown) => {
        if (mounted.current) setFeedback({ kind: 'error', text: caught instanceof Error ? caught.message : 'Could not read the clipboard.' });
      })
      .finally(() => { if (mounted.current) setImageIsLoading(false); });
  };
  const removeAttachment = (image: ImageBlock) => {
    removeStoredImage(image);
    replaceAttachments(view.attachments.filter(item => item.path !== image.path));
  };
  const queued = currSession.getQueuedMessageCount();
  const history = promptHistory(messages);
  // Only the selected agent and its workers can take over this input. Other
  // agents advertise their pending requests in the header.
  useSyncExternalStore(subscribePermissions, getPermissionsVersion);
  // A question an agent asks waits behind the approvals.
  useSyncExternalStore(subscribeQuestions, getQuestionsVersion);
  const belongsToSelected = (requester: { participant: string } | { subagent: string }) =>
    'participant' in requester ? requester.participant === selected
      : currSession.getWorkers().find(worker => worker.id === requester.subagent)?.owner === selected;
  const allApprovals = pendingApprovals(currSession.getId());
  const allQuestions = pendingQuestions(currSession.getId());
  const approvals = allApprovals.filter(request => belongsToSelected(request.requester));
  const questions = allQuestions.filter(request => belongsToSelected(request.requester));
  const activity = new Map<string, AgentActivity>(participants.map(participant => {
    const needsAttention = [...allApprovals, ...allQuestions].some(({ requester }) =>
      'participant' in requester ? requester.participant === participant.name
        : currSession.getWorkers().find(worker => worker.id === requester.subagent)?.owner === participant.name);
    return [participant.name, needsAttention ? 'attention' : currSession.isParticipantWorking(participant.name) ? 'working'
      : participant.name !== selected && views.get(participant.name)!.seen !== activityStamp(currSession.getMessages(participant.name)) ? 'unread' : 'idle'];
  }));
  const selectAgent = (name: string) => {
    if (inputOverlay || inputMode.type !== 'text' || commandIsLoading) return;
    currSession.selectParticipant(name);
  };
  const moveAgent = (direction: -1 | 1) => {
    const index = participants.findIndex(participant => participant.name === selected);
    selectAgent(participants[Math.max(0, Math.min(participants.length - 1, index + direction))].name);
  };
  const effectiveInputMode: InputMode = inputMode.type !== 'text' ? inputMode
    : approvals.length > 0
      ? {
        type: 'approval',
        request: approvals[0],
        waiting: approvals.length - 1 + questions.length,
        requesterName: 'subagent' in approvals[0].requester
          ? currSession.getWorkers().find(worker => worker.id === (approvals[0].requester as { subagent: string }).subagent)?.name
          : undefined,
        onDecide: (decision, guidance) => {
          const request = approvals[0];
          resolveApproval(request.id, decision);
          if (!guidance) return;
          void Promise.resolve().then(async () => {
            if ('subagent' in request.requester) await currSession.messageWorker(request.requester.subagent, guidance);
            else await currSession.sendMessage({ role: 'user', to: [request.requester.participant], content: [{ type: 'text', text: guidance }] });
          }).catch((caught: unknown) => {
            setFeedback({ kind: 'error', text: caught instanceof Error ? caught.message : 'Could not deliver feedback.' });
          });
        },
      }
      : questions.length > 0
        ? {
          type: 'question',
          request: questions[0],
          waiting: questions.length - 1,
          onAnswer: answer => { resolveQuestion(questions[0].id, answer); },
        }
        : inputMode;
  // shift+tab is /permissions <next mode>, sent down the same path as typing it
  const cyclePermissionMode = () => {
    send(`/permissions ${nextPermissionMode(currSession.getPermissionMode())}`);
  };
  const followLatest = () => { view.reset++; repaintView(); };
  const commandAbort = useRef<AbortController | null>(null);
  useEffect(() => () => { commandAbort.current?.abort(new TurnCancelledError()); }, []);
  const { stdout } = useStdout();
  const { exit } = useApp();

  useInput((input, key) => {
    if (!inputOverlay && key.ctrl && input === 't' && plans.length > 0) setShowTasks(shown => !shown);
  }, { isActive: active });

  // A command with choices (like /login) turns the input bar into a
  // picker; the chosen item runs as if the user had typed it. An item that
  // still needs a value asks for it in the bar and hands it over as one final
  // argument, so a key or a message containing spaces survives whole and a
  // secret is never echoed into the input.
  const openMenu = (items: readonly CommandMenuEntry[]) => {
    const close = () => setInputMode({ type: 'text' });
    const choose = (item: CommandMenuItem) => {
      const asked = item.secret ?? item.input;
      if (!asked) {
        close();
        send(item.command);
        return;
      }
      const { name, args } = parseCommandLine(item.command);
      setInputMode({
        type: 'entry',
        prompt: asked.prompt,
        masked: item.secret !== undefined,
        onSubmit: value => {
          close();
          runCommand(name, [...args, value]);
        },
        onCancel: close,
      });
    };
    setInputMode({ type: 'menu', items, onSelect: choose, onCancel: close });
  };

  // The one path a command takes, however it was started: its menu opens if
  // it has one for these arguments, and otherwise it runs. commandAbort is
  // only ever written once we know a command is async (below) — a sync
  // command (e.g. shift+tab's /permissions, fired while /login is still
  // awaiting the browser) must never touch, let alone clear, another
  // command's still-live abort handle. A typed command also hands over its
  // arguments as they were typed.
  const runCommand = (command: string, args: readonly string[], recipient = selected, argumentText?: string) => {
    // Agent-specific pickers bake their destination into the resulting command.
    if (['model', 'thinking', 'effort', 'fast'].includes(command)
      && (args.length === 0 || (args.length === 1 && !args[0].startsWith('@') && args[0] !== 'subagent'))) {
      args = [`@${recipient}`, ...args];
    }
    setFeedback(null);
    let menu: CommandMenuEntry[] | null;
    try {
      // Args may carry a secret (see openMenu) — never let it reach a menu label.
      menu = commandMenu(command, args, currSession);
    } catch (e) {
      setFeedback({ kind: 'error', text: e instanceof Error ? e.message : 'Something went wrong.' });
      return;
    }
    if (menu) {
      openMenu(menu);
      return;
    }
    const controller = new AbortController();
    let result;
    try {
      result = executeCommand(command, args, {
        session: currSession,
        participant: recipient,
        notify: text => setFeedback({ kind: 'info', text }),
        attachImage,
        exit: () => { currSession.setInputContent(''); exit(); },
        newSession: onNewSession,
        openSession: onOpenSession,
        resumeSession: onResumeSession,
        archiveSession: onArchiveSession,
        deleteSession: onDeleteSession,
        copy: copyToClipboard,
        confirm: text => new Promise<boolean>(resolve => {
          setFeedback({ kind: 'warning', text, panel: true });
          const finish = (accepted: boolean) => {
            controller.signal.removeEventListener('abort', cancelled);
            setInputMode({ type: 'text' });
            setFeedback(null);
            resolve(accepted);
          };
          const cancelled = () => finish(false);
          controller.signal.addEventListener('abort', cancelled, { once: true });
          setInputMode({
            type: 'menu',
            items: [
              { type: 'item', key: 'cancel', label: 'Cancel', command: '' },
              { type: 'item', key: 'confirm', label: 'Confirm', command: '' },
            ],
            onSelect: item => finish(item.key === 'confirm'),
            onCancel: cancelled,
          });
        }),
        signal: controller.signal,
        argumentText,
      });
    } catch (e) {
      setFeedback({ kind: 'error', text: e instanceof Error ? e.message : 'Something went wrong.' });
      return;
    }
    if (result instanceof Promise) {
      // a long-running command (browser login) holds the input like a turn
      // does; only now is the controller stored, so escape can cancel it.
      commandAbort.current = controller;
      setCommandIsLoading(true);
      result
        .then(outcome => { if (outcome) setFeedback(outcome); })
        .catch((caught: unknown) => {
          setFeedback(isAbortError(caught)
            ? null
            : { kind: 'error', text: caught instanceof Error ? caught.message : 'Something went wrong.' });
        })
        .finally(() => {
          // Guard against a newer async command having taken over the ref
          // since this one started.
          if (commandAbort.current === controller) commandAbort.current = null;
          setCommandIsLoading(false);
        });
    } else if (result) {
      setFeedback(result);
    }
  };

  // A command leaves any attachments waiting for the next real message.
  // Commands are exactly what the background queue leaves for a mounted Chat.
  const send = (text: string, images: readonly ImageBlock[] = [], content?: MessageBlock[], recipient = selected, to?: readonly string[]): boolean => {
    const commandName = /^\/(\S+)/.exec(text)?.[1];
    const immediate = commandName && ['model', 'thinking', 'effort', 'fast', 'status', 'usage', 'permissions', 'agents', 'tasks'].includes(commandName);
    const routed = currSession.messageForParticipant({ role: 'user', ...(to?.length ? { to: [...to] } : {}),
      content: content ?? [...images, { type: 'text', text }] }, recipient);
    const targetsBusy = routed.to?.some(name => currSession.isParticipantWorking(name)) ?? false;
    const taskCommand = commandName && commandRegistry.some(spec => spec.name === commandName);
    if ((targetsBusy || commandAbort.current || (taskCommand && currSession.getStatus() === 'working')) && !immediate) {
      queue(text, images, content, recipient);
      return true;
    }
    // A Sirus command runs here. Anything else that starts with a slash, an
    // agent's own command or a name nobody knows, goes out as a message and
    // the agent's harness makes of it what it will.
    const command = isSirusCommand(text, currSession.getNativeCommands(recipient))
      ? parseCommandLine(text)
      : null;
    if (command && commandRegistry.some(spec => spec.name === command.name)) {
      runCommand(command.name, command.args, recipient, command.rest);
    } else {
      // Images sit where the draft placed them. The session stamps the
      // entry's seq when it enters the transcript.
      const msg = routed;
      followLatest();
      setFeedback(null);
      // Chat is remounted per session (key={session id}), so if the user
      // navigates away mid-request the unmounted Chat no longer repaints its
      // history. The session-owned status still updates its sidebar row.
      const previousLength = currSession.getMessages().length;
      const previousDraft = currSession.getInputContent(recipient);
      const turn = currSession.sendMessage(msg);
      // Validation can reject a turn before its user message is appended.
      // Keep those images available so the user can correct the prompt.
      if ((currSession.getMessages().length > previousLength || currSession.getQueuedMessages().some(item => item.images?.some(image => images.some(sent => sent.path === image.path)))) && images.length > 0) {
        const sentPaths = new Set(images.map(image => image.path));
        replaceAttachments(view.attachments.filter(image => !sentPaths.has(image.path)));
      }
      // A startup draft becomes a real sidebar session only after the turn is
      // valid and sendMessage has appended its user message.
      if (!currSession.isEmpty()) onStartSession?.(currSession);
      turn
        .catch((caught: unknown) => {
          if (currSession.getMessages().length === previousLength && !currSession.getInputContent(recipient)) {
            currSession.setInputContent(previousDraft, recipient);
          }
          setFeedback(isAbortError(caught)
            ? null
            : { kind: 'error', text: caught instanceof Error ? caught.message : 'Something went wrong.' });
        });
    }
    return true;
  }

  const queue = (text: string, images: readonly ImageBlock[] = [], content?: MessageBlock[], recipient = selected) => {
    const message = currSession.messageForParticipant({ role: 'user', content: content ?? [{ type: 'text', text }] }, recipient);
    currSession.queueMessage(text, images, content, message.to);
    const paths = new Set(images.map(image => image.path));
    replaceAttachments(view.attachments.filter(image => !paths.has(image.path)));
  };
  const interrupt = (): boolean => {
    if (currSession.getStatus() !== 'working' && !commandAbort.current) return false;
    currSession.cancel();
    commandAbort.current?.abort(new TurnCancelledError());
    return true;
  };
  const escape = () => {
    setFeedback(null);
    if (panelFeedback) {
      setFeedback(null);
      return;
    }
    interrupt();
  };

  const sendNow = (text = '', images: readonly ImageBlock[] = [], content?: MessageBlock[]) => {
    if (currSession.getStatus() !== 'working' && !commandAbort.current && currSession.getQueuedMessageCount() === 0) {
      if (text || images.length) send(text, images, content);
      return;
    }
    if (text || images.length) queue(text, images, content);
    commandAbort.current?.abort(new TurnCancelledError());
    void currSession.deliverQueuedMessages();
  };

  // Queued messages live on the session so they survive switching away and
  // back. Send one at a time as soon as that session is free again.
  useEffect(() => {
    if (!active || inputIsBusy || imageIsLoading || currSession.getStatus() === 'working'
      || queued === 0 || effectiveInputMode.type !== 'text') return;
    const next = currSession.shiftQueuedPrompt();
    if (next !== undefined) {
      send(next.text, next.images, next.content ? [...next.content] : undefined, next.to?.[0] ?? selected, next.to);
    }
  }, [currSession, active, inputIsBusy, imageIsLoading, queued, effectiveInputMode.type]);

  const historyContent = (
    <>
      {messages.length === 0 && !isWorking && (
        <Box flexDirection="column" alignItems="center">
          {
            // art lines stay left-aligned inside their own box so the
            // center alignment of the parent can't shear the drawing
            <Box flexDirection="column" marginBottom={1} position="static">
              {HORSE.map((line, i) => (
                <Text key={i} color={theme.highlight}>{line}</Text>
              ))}
            </Box>
          }
          <Text color={theme.textMuted}>{hasCredentials ? 'What shall we build?' : 'Welcome to Sirus.'}</Text>
          {!hasCredentials && <Text color={theme.textMuted}>Use /login to connect a Claude or ChatGPT subscription, or add an API key.</Text>}
        </Box>
      )}
      <ChatHistory
        messages={messages}
        participants={participants}
        sessionId={currSession.getId()}
        participantColors={participantColors}
        isMessageLive={message => currSession.isMessageLive(message)}
        hideThoughtFor={isWorking ? messages.at(-1)?.seq : undefined}
      />
      {isWorking && (
        <TurnStatus
          messages={messages}
          awaitingApproval={approvals.length > 0}
          awaitingAnswer={questions.length > 0}
          compacting={currSession.isCompacting()}
          startedAt={currSession.getActiveTurnStartedAt() ?? Date.now()}
          quietFor={() => currSession.getTurnQuietFor(selected)}
        />
      )}
    </>
  );

  return (
    <Box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0} height="100%" minHeight={0}>
      <ChatHeader session={currSession} activity={activity}
        width={(stdout.columns ?? 80) - sidebarWidth} onSelect={active ? selectAgent : undefined} />
      {/* marginLeft -1 lets the rule start in the sidebar border's cell with a
          ├ junction, so the two lines meet instead of leaving a half-cell gap */}
      <Box marginLeft={-1} flexShrink={0}>
        <Text color={theme.border} wrap="truncate">{'├' + '─'.repeat(Math.max(0, (stdout.columns ?? 80) - sidebarWidth))}</Text>
      </Box>
      {/* The absolutely positioned history moves only inside this clipped
          viewport, so scrolling cannot overwrite the header or divider. */}
      {panelFeedback && (
        <CommandFeedbackPanel
          key={panelFeedback.text}
          feedback={panelFeedback}
          participantColors={participantColors}
          sidebarWidth={sidebarWidth}
          paused={inputOverlay}
        />
      )}
      <AgentHistory key={`history:${selected}`} position={view.history} active={active && !inputOverlay}
        hidden={Boolean(panelFeedback)} sidebarWidth={sidebarWidth} empty={messages.length === 0 && !isWorking} reset={view.reset}>
        {historyContent}
      </AgentHistory>
      {showTasks && plans.length > 0 && (
        <Box paddingX={3} marginBottom={1} flexDirection="column" flexShrink={0}>
          {plans.map(plan => (
            <Box key={plan.participant} flexDirection="column">
              {plans.length > 1 && <Text color={participantColors.get(plan.participant.toLocaleLowerCase())}>@{plan.participant}</Text>}
              <PlanChecklist entries={plan.entries} />
            </Box>
          ))}
        </Box>
      )}
      {active && <InputBar
        key={`input:${selected}`}
        recipient={selected}
        draftState={view.draft}
        onSelectAgent={participants.length > 1 ? moveAgent : undefined}
        send={send}
        inputContent={currSession.getInputContent(selected)}
        setInputContent={inputContent => currSession.setInputContent(inputContent, selected)}
        disabled={inputIsBusy}
        feedback={panelFeedback ? null : feedback}
        participants={participants}
        workers={currSession.getWorkers().filter(worker => worker.owner === selected)}
        directory={currSession.getDirectory()}
        mode={effectiveInputMode}
        permissionMode={currSession.getPermissionMode()}
        modeNotice={currSession.getModeNotice(selected)}
        onCyclePermissionMode={cyclePermissionMode}
        onEscape={escape}
        onRewind={() => send('/rewind')}
        onInterrupt={interrupt}
        onExit={() => exit()}
        onExitHint={() => {
          setInputMode({ type: 'text' });
          setFeedback({ kind: 'info', text: 'ctrl+c again to exit' });
        }}
        attachments={attachments}
        onPasteClipboard={pasteClipboard}
        onAttachImage={attachImage}
        onOverlayChange={setInputOverlay}
        onRemoveAttachment={removeAttachment}
        model={participants.find(participant => participant.name === selected)!.model}
        thinkingLevel={currSession.getThinkingLevel(selected)}
        history={history}
        queuedMessages={currSession.getQueuedMessages().filter(message => !message.to?.length || message.to.includes(selected))}
        onSendNow={sendNow}
        onTakeQueued={ids => currSession.takeQueuedMessages(ids)}
        contextUsage={currSession.getContextUsage(selected)}
        nativeCommands={() => currSession.getNativeCommands()}
        tasksVisible={plans.length > 0 ? showTasks : undefined}
      />}
    </Box>
  );
}
