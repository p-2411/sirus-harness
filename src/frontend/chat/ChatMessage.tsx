import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
	INTERRUPTED_SEVERITY,
	isPlanCall,
	planEntriesOf,
	type CompactionBlock,
	type ImageBlock,
	type Message,
	type MessageBlock,
	type NoticeBlock,
	type PlanEntry,
	type TextBlock,
	type ThoughtBlock,
	type ToolCallBlock,
	type ToolCallStatus,
} from '../../agent_runtime/types';
import { Box, Text, type DOMElement } from 'ink';
import { theme } from '../styles/theme';
import { Markdown } from '../markdown/Markdown';
import { WrappedText } from '../markdown/blockRenderers';
import { describeImage } from '../../images';
import { describeAttachment } from '../../fileMentions';
import { formatTokens } from '../../agent_runtime/usage';
import { MentionText, participantColor, type ParticipantColors } from '../MentionText';
import { useClickable } from '../interaction/clickable';
import {
	findSubagentByCall,
	getSubagentsVersion,
	subscribeSubagents,
	type SubagentRun,
	type SubagentStatus,
} from '../../agent_runtime/tools/subagents';
import { INTERRUPTED_REASON } from '../../agent_runtime/tools/subagents/report';
import { historyParts } from './history';
import { workerAge } from '../../commands/agents/behavior';
import {
	getPermissionsVersion,
	isAwaitingApproval,
	subscribePermissions,
} from '../../agent_runtime/permissions/approvals';
import {
	argumentLines,
	callArguments,
	callLabel,
	diffsOf,
	DIFF_PREVIEW_LINES,
	editCounts,
	editPreview,
	failureDetail,
	finished,
	groupSummary,
	isRoutineReview,
	outputText,
	singleLine,
	stopLabel,
	toolLine,
	type DiffLine,
} from './toolCalls';

export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

// Ink measures a tab as zero columns, so a truncated line can still carry
// tabs the terminal expands past the row's edge and wraps into the sidebar.
function expandTabs(text: string): string {
	return text.replace(/\t/g, '    ');
}

const OUTPUT_PREVIEW_LINES = 8;

function diffLines(sign: '+' | '-' | ' ', text: string): DiffLine[] {
	if (!text) return [];
	const lines = text.split('\n');
	const shown: DiffLine[] = lines.slice(0, OUTPUT_PREVIEW_LINES).map(line => ({ sign, text: line }));
	const hidden = lines.length - OUTPUT_PREVIEW_LINES;
	if (hidden > 0) shown.push({ sign: '…', text: `${hidden} more line${hidden === 1 ? '' : 's'}` });
	return shown;
}

// A SpawnAgent call is a Sirus tool the vendor reports as kind `other` under
// its own title. Its row is the worker's anchor in the history: it follows
// the run it started rather than the call, and carries the run's report once
// there is one.
function isSpawnAgent(call: ToolCallBlock): boolean {
	return /(?:^|[^A-Za-z0-9])SpawnAgent\s*$/.test(call.title);
}

// The report the session put on the call when the worker it started ended.
// The call's own content is the handle the vendor was given back, which is
// not what the user came to read.
function spawnReport(call: ToolCallBlock): string {
	return typeof call.output === 'string' ? call.output.trim() : '';
}

// What the call produced: its text content, or failing that its raw output.
export function outputPreview(call: ToolCallBlock): DiffLine[] {
	return diffLines(' ', outputText(call));
}

// What a row reveals when opened: why the call failed, when it failed on its
// own; otherwise the change it made, then what it produced, and when there is
// neither, its arguments. Long values are cut the way a diff is.
export function callDetail(call: ToolCallBlock, directory?: string): DiffLine[] {
	if (stopLabel(call) === 'failed') {
		const failure = failureDetail(call);
		if (failure.length > 0) return failure;
	}
	const change = editPreview(call, DIFF_PREVIEW_LINES, directory);
	// A change's diff says what it did. The vendor's raw word that it did
	// ("The file … has been updated") adds nothing; a note in its content can.
	const produced = change.length > 0
		? diffLines(' ', call.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'))
		: outputPreview(call);
	const lines = [...change, ...produced];
	if (lines.length > 0) return lines;
	const input = argumentLines(call);
	return diffLines(' ', input.join('\n'));
}

interface ToolRun {
	type: 'tool_run';
	calls: ToolCallBlock[];
}

// An agent's plan, with its checklist behind a compact update row.
interface PlanSegment {
	type: 'plan';
	call: ToolCallBlock;
}

export type MessageSegment = MessageBlock | ToolRun | PlanSegment;

// A call that is part of a run of ordinary tool calls, which a group folds
// away behind a summary of the run. A SpawnAgent call is not: its row is a
// worker's anchor, showing the run's status and carrying its report, so it
// keeps a row of its own however many calls sit beside it. Plan updates
// also stand alone so each checklist can be opened where it happened.
function groupable(block: MessageBlock): block is ToolCallBlock {
	return block.type === 'tool_call' && !isSpawnAgent(block) && !isPlanCall(block);
}

// What of a reply the chat shows: everything, in the order it came, except a
// thought with nothing in it, which would be a blank row, and a routine review
// by Codex's reviewer, whose approved action shows as a row of its own.
export function visibleContent(content: readonly MessageBlock[]): MessageBlock[] {
	return content.filter(block => block.type === 'thought'
		? block.text.trim() !== ''
		: block.type !== 'tool_call' || !isRoutineReview(block));
}

/** Collapse only adjacent tool calls, and only two or more of them. */
export function messageSegments(content: readonly MessageBlock[]): MessageSegment[] {
	const segments: MessageSegment[] = [];
	for (let index = 0; index < content.length;) {
		const block = content[index];
		if (block.type === 'tool_call' && isPlanCall(block)) {
			segments.push({ type: 'plan', call: block });
			index++;
			continue;
		}
		if (!groupable(block)) {
			segments.push(block);
			index++;
			continue;
		}
		const calls: ToolCallBlock[] = [];
		while (index < content.length && groupable(content[index])) {
			calls.push(content[index] as ToolCallBlock);
			index++;
		}
		if (calls.length > 1) segments.push({ type: 'tool_run', calls });
		else segments.push(...calls);
	}
	return segments;
}

const PLAN_MARKS: Record<PlanEntry['status'], { mark: string; color: string }> = {
	completed: { mark: '✔', color: theme.success },
	in_progress: { mark: '▸', color: theme.accent },
	pending: { mark: '○', color: theme.textSubtle },
};

// Every step with its state, the step in hand picked out, shared by the
// pinned plan and the checklist a transcript row reveals.
export function PlanChecklist({ entries }: { entries: readonly PlanEntry[] }) {
	return (
		<Box flexDirection="column">
			{entries.map((entry, index) => (
				<Box key={index}>
					<Box width={2} flexShrink={0}>
						<Text color={PLAN_MARKS[entry.status].color}>{PLAN_MARKS[entry.status].mark}</Text>
					</Box>
					<Text
						color={entry.status === 'in_progress' ? theme.text : theme.textMuted}
						bold={entry.status === 'in_progress'}
						strikethrough={entry.status === 'completed'}
					>
						{entry.content}
					</Text>
				</Box>
			))}
		</Box>
	);
}

function isActivity(segment: MessageSegment | undefined): boolean {
	return segment !== undefined && ['tool_call', 'tool_run', 'plan', 'notice', 'thought'].includes(segment.type);
}

function PlanRow({ call }: { call: ToolCallBlock }) {
	const [expanded, setExpanded] = useState(false);
	const toggle = useCallback(() => setExpanded(current => !current), []);
	const ref = useRef<DOMElement>(null);
	const hovered = useClickable(ref, toggle);
	const entries = planEntriesOf(call);
	const done = entries.filter(entry => entry.status === 'completed').length;
	return (
		<Box flexDirection="column" paddingX={1}>
			<Box ref={ref}>
				<Text color={hovered ? theme.accentSoft : theme.textMuted} wrap="truncate-end">
					{'  '}Updated plan · {done} of {entries.length} done
				</Text>
			</Box>
			{expanded && (
				<Box marginLeft={4}>
					<PlanChecklist entries={entries} />
				</Box>
			)}
		</Box>
	);
}

function NoticeRow({ block }: { block: NoticeBlock }) {
	const color = block.severity === 'warning' ? theme.pending
		: block.severity === 'error' || block.severity === INTERRUPTED_SEVERITY ? theme.danger : theme.textMuted;
	return (
		<Box paddingX={1}>
			<Text color={color} dimColor wrap="truncate-end">
				{'  '}{singleLine(block.title)}{block.description ? ` · ${singleLine(block.description)}` : ''}
			</Text>
		</Box>
	);
}

// The dot on that row is the run's: amber while the worker works, green once
// it is done, red if it failed, muted when it was stopped or the process it
// lived in ended. A run from an earlier process left no record, so its dot
// stays neutral.
type SubagentIndicator = SubagentStatus | 'unknown';

const subagentColors: Record<SubagentIndicator, string> = {
	working: theme.pending,
	done: theme.success,
	failed: theme.danger,
	cancelled: theme.textMuted,
	interrupted: theme.textMuted,
	unknown: theme.textSubtle,
};

// The worker this call started, and how its row should read. The record
// carries what the call never did: the model it got, its id and its branch.
function useSubagentRun(call: ToolCallBlock, sessionId?: string): {
	run?: SubagentRun;
	status: SubagentIndicator;
} {
	useSyncExternalStore(subscribeSubagents, getSubagentsVersion);
	const run = sessionId === undefined ? undefined : findSubagentByCall(call.id, sessionId);
	if (run) return { run, status: run.status };
	if (call.status === 'failed') return { status: 'failed' };
	return { status: call.status === 'completed' ? 'unknown' : 'working' };
}

// Whether the call is waiting on the user's approval now. What they decided
// is the call's own `outcome`, which outlives the prompt and the process.
function useAwaitingApproval(call: ToolCallBlock, sessionId?: string): boolean {
	useSyncExternalStore(subscribePermissions, getPermissionsVersion);
	return sessionId !== undefined && isAwaitingApproval(call.id, sessionId);
}

const statusColors: Record<ToolCallStatus, string> = {
	pending: theme.textSubtle,
	in_progress: theme.textSubtle,
	completed: theme.toolIndicator,
	failed: theme.danger,
};

const stopColors = { declined: theme.danger, cancelled: theme.textMuted, failed: theme.danger } as const;

// One line for one call: status dot, what it did, and for a change it made
// the lines added and removed; then how it ended, when it did not end well.
// Truncated at the row's width.
function ToolSummary({ call, indent = '', hovered = false, sessionId, directory }: {
	sessionId?: string;
	directory?: string;
	call: ToolCallBlock;
	indent?: string;
	hovered?: boolean;
}) {
	const awaiting = useAwaitingApproval(call, sessionId);
	const stop = stopLabel(call);
	const color = call.outcome === 'cancelled' ? theme.textMuted : statusColors[call.status];
	const { verb, subject } = callLabel(call, directory);
	// Counts are for a change that was made; a declined one wrote nothing.
	const counts = call.status === 'completed' ? editCounts(call) : null;
	return (
		<Text wrap="truncate-end">
			<Text color={color}>{indent}●</Text>
			{verb && <Text color={hovered ? theme.textMuted : theme.textSubtle}> {verb}</Text>}
			{subject && <Text color={hovered && !verb ? theme.textMuted : theme.textSubtle} dimColor={!!verb}> {subject}</Text>}
			{counts && <Text color={theme.success}> +{counts.added}</Text>}
			{counts && <Text color={theme.danger}> −{counts.removed}</Text>}
			{awaiting && <Text color={theme.pending}> · waiting for approval</Text>}
			{!awaiting && stop && <Text color={stopColors[stop]}> · {stop}</Text>}
		</Text>
	);
}

const detailColors: Record<DiffLine['sign'], string> = {
	'+': theme.success,
	'-': theme.danger,
	' ': theme.textMuted,
	'…': theme.textSubtle,
};

const lineTints: Partial<Record<DiffLine['sign'], string>> = {
	'+': theme.diffAddedBg,
	'-': theme.diffRemovedBg,
};

// What an open row shows, one line each: a change as both vendors show one,
// numbered where the vendor said where it was, removed and added lines
// tinted across the row; output and notes in plain muted lines; a failure's
// reason in the colour of the failure.
function DiffPreview({ lines, failed = false }: { lines: readonly DiffLine[]; failed?: boolean }) {
	const gutter = Math.max(0, ...lines.map(line => line.line === undefined ? 0 : String(line.line).length));
	return (
		<Box flexDirection="column" marginLeft={4}>
			{lines.map((line, index) => (
				<Box key={index} backgroundColor={lineTints[line.sign]}>
					<Text wrap="truncate-end">
						{gutter > 0 && <Text color={theme.textSubtle}>{String(line.line ?? '').padStart(gutter)} </Text>}
						<Text color={failed && line.sign === ' ' ? theme.danger : detailColors[line.sign]}>
							{line.sign} {expandTabs(line.text)}
						</Text>
					</Text>
				</Box>
			))}
		</Box>
	);
}

// One call, collapsed to its summary line until clicked; open, it also shows
// what the call carried. Two kinds open by themselves, since each is what the
// user came to read: a change once it is made, and a failure, with why. A
// click still closes them.
function ToolCallEntry({ call, indent, sessionId, directory }: {
	sessionId?: string;
	directory?: string;
	call: ToolCallBlock;
	indent?: string;
}) {
	const failed = stopLabel(call) === 'failed';
	const opensItself = failed || (call.status === 'completed' && diffsOf(call).length > 0);
	const [expansionOverride, setExpansionOverride] = useState<boolean | null>(null);
	const expanded = expansionOverride ?? opensItself;
	const toggle = useCallback(() => setExpansionOverride(!expanded), [expanded]);
	const ref = useRef<DOMElement>(null);
	const hovered = useClickable(ref, toggle);
	const detail = expanded ? callDetail(call, directory) : [];
	return (
		<Box flexDirection="column">
			<Box ref={ref}>
				<ToolSummary sessionId={sessionId} directory={directory} call={call} indent={indent} hovered={hovered} />
			</Box>
			{detail.length > 0 && <DiffPreview lines={detail} failed={failed} />}
		</Box>
	);
}

function AnimatedDots() {
	const [dots, setDots] = useState(1);
	useEffect(() => {
		const timer = setInterval(() => setDots(current => current % 3 + 1), 400);
		return () => clearInterval(timer);
	}, []);
	return <>{'.'.repeat(dots)}</>;
}

export function ToolRunGroup({ calls, defaultExpanded = false, sessionId, directory }: {
	sessionId?: string;
	directory?: string;
	calls: readonly ToolCallBlock[];
	defaultExpanded?: boolean;
}) {
	// A group opens for whatever would open its row by itself: a change made,
	// or a failure. It follows arriving calls until the user chooses.
	const opensItself = calls.some(call => stopLabel(call) === 'failed'
		|| (call.status === 'completed' && diffsOf(call).length > 0));
	const [expansionOverride, setExpansionOverride] = useState<boolean | null>(null);
	const expanded = expansionOverride ?? (defaultExpanded || opensItself);
	const toggle = useCallback(() => setExpansionOverride(!expanded), [expanded]);
	const ref = useRef<DOMElement>(null);
	const hovered = useClickable(ref, toggle);
	const complete = calls.every(finished);
	const summaryColor = hovered ? theme.accentSoft : theme.textMuted;

	return (
		// Its summary lines up with the rows beside it, its calls under it.
		<Box flexDirection="column" marginLeft={3}>
			<Box ref={ref} flexDirection="row" flexWrap="nowrap">
				<Text color={summaryColor} wrap="truncate-end">
					{groupSummary(calls)}{!complete && <AnimatedDots />}
				</Text>
			</Box>
			{expanded ? (
				<Box flexDirection="column" marginLeft={2}>
					{calls.map(call => (
						<ToolCallEntry key={call.id} call={call} sessionId={sessionId} directory={directory} />
					))}
				</Box>
			) : null}
		</Box>
	);
}

// How a run stands, in the words of Claude Code's Agent row: "Done (4 tool
// uses · 12k tokens · 45s)". A call the user declined fails like any other,
// and the count says so, so that "Done" never reads as everything went
// through.
function runSummary(run: SubagentRun): string {
	const calls = run.content.filter((block): block is ToolCallBlock => block.type === 'tool_call' && !isPlanCall(block));
	const failed = calls.filter(call => call.status === 'failed');
	const declined = failed.filter(call => call.outcome === 'declined').length;
	const ended = run.status !== 'working';
	const parts = [
		`${calls.length} tool use${calls.length === 1 ? '' : 's'}`,
		...(declined > 0 ? [`${declined} declined`] : []),
		...(failed.length > declined ? [`${failed.length - declined} failed`] : []),
		...(ended && run.tokens !== undefined ? [`${formatTokens(run.tokens)} tokens`] : []),
		...(ended ? [workerAge(run)] : []),
	].join(' · ');
	switch (run.status) {
		case 'working': {
			const latest = calls.at(-1);
			return `Working (${parts})${latest ? ` · ${toolLine(latest, 60)}` : ''}`;
		}
		case 'done':
			return `Done (${parts})`;
		case 'failed':
			return `Failed (${parts}): ${singleLine(run.error ?? 'unknown error')}`;
		case 'cancelled':
			// "Cancelled by CancelAgent" says it already; a watchdog's reason does not.
			return run.error && /^cancelled\b/i.test(run.error)
				? `${singleLine(run.error)} (${parts})`
				: `Cancelled (${parts})${run.error ? `: ${singleLine(run.error)}` : ''}`;
		case 'interrupted':
			return `Interrupted (${parts}): ${singleLine(run.error ?? INTERRUPTED_REASON)}`;
	}
}

// A SpawnAgent call is the anchor of the worker it started, laid out the way
// Claude Code lays out an Agent row: the worker's name, or "Agent" for one
// given none, with its task; under it how the run stands; and once it has
// ended, the report its owner received, whole and as Markdown. A spawn that
// never started a worker says why, and one the user declined or whose turn
// was cancelled says so. A click folds the report away and back, and opens a
// running one's task in full.
function SpawnAgentEntry({ call, sessionId }: { call: ToolCallBlock; sessionId?: string }) {
	const { run, status } = useSubagentRun(call, sessionId);
	const awaiting = useAwaitingApproval(call, sessionId);
	const report = spawnReport(call);
	const [expansionOverride, setExpansionOverride] = useState<boolean | null>(null);
	const expanded = expansionOverride ?? (report !== '' && status !== 'working');
	const toggle = useCallback(() => setExpansionOverride(!expanded), [expanded]);
	const ref = useRef<DOMElement>(null);
	const hovered = useClickable(ref, toggle);
	const args = callArguments(call);
	const argument = (key: string) => typeof args[key] === 'string' ? singleLine(args[key] as string) : '';
	const name = run?.name ?? (argument('name') || 'Agent');
	const prompt = run?.prompt ?? (typeof args.prompt === 'string' ? args.prompt : '');
	const task = run ? run.description || singleLine(run.prompt) : argument('description') || singleLine(prompt);
	const color = call.outcome ? stopColors[call.outcome] : subagentColors[status];
	// A spawn waiting on the user's approval has not started anything yet;
	// its title says what it waits for.
	const summary = run ? runSummary(run)
		: call.outcome ? ''
		: status === 'failed' ? ['Failed', singleLine(outputText(call))].filter(Boolean).join(': ')
		: status === 'working' && !awaiting ? 'Starting' : '';
	return (
		<Box flexDirection="column">
			<Box ref={ref} flexDirection="column">
				<Text wrap="truncate-end">
					<Text color={color}>{'  '}●</Text>
					<Text color={hovered ? theme.accentSoft : theme.text} bold> {name}</Text>
					{task && <Text color={hovered ? theme.accentSoft : theme.textMuted}>({task})</Text>}
					{run && <Text color={theme.textSubtle} dimColor> · {run.model}{run.thinkingLevel ? ` ${run.thinkingLevel}` : ''} · {run.id}</Text>}
					{run?.branch && <Text color={theme.textSubtle} dimColor> · {run.branch}</Text>}
					{awaiting && <Text color={theme.pending}> · waiting for approval</Text>}
					{!awaiting && call.outcome && <Text color={stopColors[call.outcome]}> · {call.outcome}</Text>}
				</Text>
				{summary && (
					<Box marginLeft={4}>
						<Text color={status === 'failed' ? theme.danger : theme.textMuted} wrap="truncate-end">⎿ {summary}</Text>
					</Box>
				)}
			</Box>
			{expanded && report && (
				<Box marginLeft={6}>
					<Markdown>{report}</Markdown>
				</Box>
			)}
			{expanded && !report && prompt.trim() && (
				<Box marginLeft={6}>
					<Text color={theme.textMuted} wrap="wrap">{prompt.trim()}</Text>
				</Box>
			)}
		</Box>
	);
}

// The message owns spacing between activity and prose; rows stack directly.
function ToolCallRow({ call, sessionId, directory }: {
	call: ToolCallBlock;
	sessionId?: string;
	directory?: string;
}) {
	return (
		<Box flexDirection="column" paddingX={1}>
			{isSpawnAgent(call)
				? <SpawnAgentEntry call={call} sessionId={sessionId} />
				: <ToolCallEntry call={call} indent="  " sessionId={sessionId} directory={directory} />}
		</Box>
	);
}

// A thought that opens with a bold title, as summarised reasoning does, is
// named by that title while it is being written.
export function thoughtHeading(text: string): { title: string | null; body: string } {
	const trimmed = text.trim();
	const titled = /^\*\*(.+?)\*\*\s*/.exec(trimmed);
	if (titled) return { title: singleLine(titled[1]!), body: trimmed.slice(titled[0].length) || titled[1]! };
	return { title: null, body: trimmed };
}

// How long a finished thought took, as Claude Code says it. A thought from
// before thoughts were timed just says it happened.
function thoughtLength(block: ThoughtBlock): string {
	if (block.startedAt === undefined || block.endedAt === undefined) return 'Thought';
	return `Thought for ${formatElapsed(Math.max(1000, block.endedAt - block.startedAt))}`;
}

// Reasoning the runtime streamed: "Thinking" while it is being written, then
// "Thought for 3s", on one line that opens to the whole thought. It stays
// where it happened, among the rows of the calls around it.
function ThoughtRow({ block, live }: { block: ThoughtBlock; live: boolean }) {
	const [expanded, setExpanded] = useState(false);
	const toggle = useCallback(() => setExpanded(current => !current), []);
	const ref = useRef<DOMElement>(null);
	useClickable(ref, toggle);
	const { title, body } = thoughtHeading(block.text);
	// Live, it names what the model is working through, as the turn status
	// row does: the thought's title, or failing that its opening words.
	const label = live && block.endedAt === undefined ? `Thinking · ${title ?? singleLine(body)}` : thoughtLength(block);
	return (
		<Box flexDirection="column" paddingX={1}>
			<Box ref={ref}>
				<Text color={theme.textSubtle} wrap="truncate-end">
					{'  '}∴ {label}
				</Text>
			</Box>
			{expanded && body && (
				<Box marginLeft={4}>
					<WrappedText color={theme.textSubtle}>{body}</WrappedText>
				</Box>
			)}
		</Box>
	);
}

// The runtime folded its own conversation here: one rule across the message,
// and on a click the summary it reported, since that is all the participant
// now knows of the conversation above it.
function CompactionRule({ block, participantColors }: {
	block: CompactionBlock;
	participantColors?: ParticipantColors;
}) {
	const [expanded, setExpanded] = useState(false);
	const toggle = useCallback(() => setExpanded(current => !current), []);
	const ref = useRef<DOMElement>(null);
	const hovered = useClickable(ref, toggle);
	const summary = block.summary?.trim() || null;
	return (
		<Box flexDirection="column" marginY={1} flexShrink={0}>
			<Box ref={ref}>
				<Text color={hovered && summary ? theme.accentSoft : theme.textMuted} wrap="truncate-end">
					── context compacted{summary ? ` · ${expanded ? 'hide' : 'show'} summary` : ''} ──
				</Text>
			</Box>
			{expanded && summary && (
				<Box marginTop={1} marginLeft={2}>
					<Markdown participantColors={participantColors}>{summary}</Markdown>
				</Box>
			)}
		</Box>
	);
}

// An attached image: the terminal cannot show it, so its row says what it is.
export function ImageLine({ image }: { image: ImageBlock }) {
	return <Text color={theme.textMuted}>▣ {describeImage(image)}</Text>;
}

// A file or directory the prompt attached with an @ mention, named with its
// size the way Claude Code notes one. The runtimes read the snapshot itself.
function FileLine({ block }: { block: TextBlock }) {
	return <Text color={theme.textMuted} dimColor>{describeAttachment(block)}</Text>;
}

// Pieces of one typed line, cut where a span of the whole prompt starts and
// ends: the spans are the models that introduced participants.
function promptPieces(line: string, start: number, spans: readonly { start: number; end: number }[]): { text: string; model: boolean }[] {
	const pieces: { text: string; model: boolean }[] = [];
	let at = 0;
	for (const span of spans) {
		const from = Math.max(span.start - start, at);
		const to = Math.min(span.end - start, line.length);
		if (to <= from) continue;
		if (from > at) pieces.push({ text: line.slice(at, from), model: false });
		pieces.push({ text: line.slice(from, to), model: true });
		at = to;
	}
	if (at < line.length) pieces.push({ text: line.slice(at), model: false });
	return pieces;
}

// What the user typed, exactly as they typed it: no Markdown, as Codex prints
// a prompt, with each @name in its colour and the model that introduced a
// participant dimmed beside it, since the runtimes never read that part.
function PromptText({ text, start, spans, participantColors }: {
	text: string;
	start: number;
	spans: readonly { start: number; end: number }[];
	participantColors?: ParticipantColors;
}) {
	let lineStart = start;
	return (
		<Box flexDirection="column">
			{text.split('\n').map((line, index) => {
				const pieces = promptPieces(line, lineStart, spans);
				lineStart += line.length + 1;
				return (
					<WrappedText key={index} color={theme.text}>
						{line ? pieces.map((piece, at) => piece.model
							? <Text key={at} color={theme.textSubtle} dimColor>{expandTabs(piece.text)}</Text>
							: <MentionText key={at} colors={participantColors}>{expandTabs(piece.text)}</MentionText>)
							: ' '}
					</WrappedText>
				);
			})}
		</Box>
	);
}

function UserPrompt({ message, participantColors }: { message: Message; participantColors?: ParticipantColors }) {
	const spans = [...(message.creationModels ?? [])].sort((left, right) => left.start - right.start);
	// Spans count in `textOf` offsets: text blocks joined by one newline.
	let offset = 0;
	return message.content.map((block, index) => {
		if (block.type === 'image') return <ImageLine key={index} image={block} />;
		if (block.type !== 'text') return null;
		const start = offset;
		offset += block.text.length + 1;
		if (block.filePath) return <FileLine key={index} block={block} />;
		return <PromptText key={index} text={block.text} start={start} spans={spans} participantColors={participantColors} />;
	});
}

// What a finished turn took, under its reply: who, how long, when it ended,
// the tokens it used, which is what /status and /usage add up, and how many
// it wrote, the way Claude Code closes a turn with "Crunched for 12s · done
// 4:04 AM" and its ↓ token count. A Codex turn of several model calls has a
// total and nothing written to set beside it.
function TurnFooter({ message, name }: { message: Message; name: string }) {
	if (message.finishedAt === undefined) return null;
	const parts = [`@${name}`];
	if (message.startedAt !== undefined) parts.push(formatElapsed(message.finishedAt - message.startedAt));
	parts.push(new Date(message.finishedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
	if (message.usage) parts.push(`${formatTokens(message.usage.totalTokens)} tokens`);
	if (message.usage?.outputTokens !== undefined) parts.push(`↓ ${formatTokens(message.usage.outputTokens)}`);
	return (
		<Box marginTop={1}>
			<Text color={theme.textSubtle} dimColor wrap="truncate-end">{parts.join(' · ')}</Text>
		</Box>
	);
}

interface ChatMessageProps {
	sessionId?: string;
	// The session's directory: paths inside it are shown relative to it.
	directory?: string;
	message: Message;
	model?: string;
	participantColors?: ParticipantColors;
	// The reply is still being written.
	live?: boolean;
	// The current thought is already shown in the turn status row.
	hideThought?: boolean;
	// The last part of a reply a steered message split; the whole turn's
	// footer goes under it.
	final?: boolean;
}

function sameFields<T extends object>(left: T, right: T): boolean {
	const keys = Object.keys(left) as (keyof T)[];
	return keys.length === Object.keys(right).length
		&& keys.every(key => Object.is(left[key], right[key]));
}

function sameColors(left?: ParticipantColors, right?: ParticipantColors): boolean {
	if (left === right) return true;
	return left !== undefined && right !== undefined && left.size === right.size
		&& [...left].every(([name, color]) => right.get(name) === color);
}

function messageSnapshot(message: Message): Message {
	return { ...message, to: message.to ? [...message.to] : undefined, content: message.content.map(block => ({ ...block })) };
}

function sameMessage(previous: Message, next: Message): boolean {
	return previous.seq === next.seq && previous.role === next.role
		&& previous.participant === next.participant
		&& (previous.to ?? []).join('\0') === (next.to ?? []).join('\0')
		&& previous.finishedAt === next.finishedAt
		&& previous.usage === next.usage
		&& previous.creationModels === next.creationModels
		&& previous.content.length === next.content.length
		&& previous.content.every((block, index) => sameFields(block, next.content[index]!));
}

// Entries and their text blocks are mutated in place. Capture their fields
// before memoising, including tool outputs that arrive after a turn finishes.
// Nested tool data is replaced by the runtime reducer, so it keeps its identity.
export function ChatMessage(props: ChatMessageProps) {
	return <MessageBody {...props} message={messageSnapshot(props.message)} />;
}

export function ChatHistory({ messages, participants, isMessageLive, hideThoughtFor, ...props }: {
	messages: readonly Message[];
	participants: readonly { name: string; model: string }[];
	isMessageLive: (message: Message) => boolean;
	hideThoughtFor?: number;
	sessionId: string;
	directory?: string;
	participantColors: ParticipantColors;
}) {
	const models = new Map(participants.map(participant => [participant.name.toLocaleLowerCase(), participant.model]));
	const liveMessages = new Set(messages.filter(isMessageLive).map(message => message.seq));
	const entries = historyParts(messages).map(({ message, key, final }) => ({
		key,
		message: messageSnapshot(message),
		model: message.model ?? (message.role === 'assistant' ? models.get((message.participant ?? 'sirus').toLocaleLowerCase()) : undefined),
		live: final && liveMessages.has(message.seq),
		hideThought: message.seq === hideThoughtFor,
		final,
	}));
	return <HistoryBody {...props} entries={entries} />;
}

// A draft edit leaves the entire history subtree alone; streaming only
// passes the changed entries through the message-level boundary below.
const HistoryBody = memo(function HistoryBody({ entries, ...props }: {
	entries: readonly (Pick<ChatMessageProps, 'message' | 'model' | 'live' | 'hideThought' | 'final'> & { key: string })[];
	sessionId: string;
	directory?: string;
	participantColors: ParticipantColors;
}) {
	return entries.map(({ key, ...entry }) => <MessageBody key={key} {...props} {...entry} />);
}, (previous, next) => previous.sessionId === next.sessionId
	&& previous.directory === next.directory
	&& sameColors(previous.participantColors, next.participantColors)
	&& previous.entries.length === next.entries.length
	&& previous.entries.every((entry, index) => {
		const other = next.entries[index]!;
		return entry.key === other.key && entry.model === other.model && entry.live === other.live
			&& entry.hideThought === other.hideThought && entry.final === other.final && sameMessage(entry.message, other.message);
	}));

function SegmentView({ block, previous, participantColors, sessionId, directory, live }: {
	block: MessageSegment;
	previous?: MessageSegment;
	participantColors?: ParticipantColors;
	sessionId?: string;
	directory?: string;
	live: boolean;
}) {
	switch (block.type) {
		case 'text':
			if (block.filePath) return null;
			// Two messages in a row are two paragraphs, not one.
			return (
				<Box marginTop={previous?.type === 'text' ? 1 : 0}>
					<Markdown participantColors={participantColors}>{block.text}</Markdown>
				</Box>
			);
		case 'image':
			return <ImageLine image={block} />;
		case 'thought':
			return <ThoughtRow block={block} live={live} />;
		case 'plan':
			return <PlanRow call={block.call} />;
		case 'notice':
			return <NoticeRow block={block} />;
		case 'compaction':
			return <CompactionRule block={block} participantColors={participantColors} />;
		case 'tool_run':
			return <ToolRunGroup calls={block.calls} sessionId={sessionId} directory={directory} />;
		case 'tool_call':
			return <ToolCallRow call={block} sessionId={sessionId} directory={directory} />;
	}
}

const MessageBody = memo(function MessageBody({
	message,
	model,
	participantColors,
	sessionId,
	directory,
	live = false,
	hideThought = false,
	final = true,
}: ChatMessageProps) {
	const isUser = message.role === "user";
	const participantName = message.participant ?? 'sirus';
	// While the turn status row shows the thought in hand, the history leaves
	// it out; the thoughts before it stay where they happened.
	const content = hideThought && live
		? message.content.filter((block, index) => !(block.type === 'thought' && index === message.content.length - 1 && block.endedAt === undefined))
		: message.content;
	const segments = isUser ? [] : messageSegments(visibleContent(content));
	if (!isUser && message.content.length > 0 && segments.length === 0) return null;
	return (
		// no bars, no boxes — bold speaker label, body aligned flush beneath,
		// whitespace doing the separating
		<Box
			flexDirection="column"
			alignItems={isUser ? 'flex-end' : 'flex-start'}
			marginBottom={1}
			paddingX={3}
			flexShrink={0}
		>
			<Text>
				<Text
					color={isUser ? theme.highlight : participantColor(participantName, participantColors)}
					bold
				>
					{isUser ? "you" : participantName}
				</Text>
				{!isUser && model && <Text color={theme.textSubtle} dimColor> {model}</Text>}
				{!isUser && message.to?.length ? <Text color={theme.textMuted}> → {message.to.map(name => `@${name}`).join(', ')}</Text> : null}
			</Text>
			{isUser && <UserPrompt message={message} participantColors={participantColors} />}
			{segments.map((block, index) => {
				const row = <SegmentView key={index} block={block} previous={segments[index - 1]} participantColors={participantColors}
					sessionId={sessionId} directory={directory} live={live} />;
				if (!isActivity(block)) return row;
				const previous = segments[index - 1];
				const next = segments[index + 1];
				return <Box key={index} flexDirection="column"
					marginTop={previous && !isActivity(previous) ? 1 : 0}
					marginBottom={next && !isActivity(next) ? 1 : 0}>{row}</Box>;
			})}
			{!isUser && !live && final && <TurnFooter message={message} name={participantName} />}
		</Box>
	);
}, (previous, next) => previous.sessionId === next.sessionId
	&& previous.directory === next.directory
	&& previous.model === next.model
	&& previous.live === next.live
	&& previous.hideThought === next.hideThought
	&& previous.final === next.final
	&& sameColors(previous.participantColors, next.participantColors)
	&& sameMessage(previous.message, next.message));
