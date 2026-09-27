import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
	isPlanCall,
	planEntriesOf,
	type CompactionBlock,
	type ImageBlock,
	type Message,
	type MessageBlock,
	type NoticeBlock,
	type PlanEntry,
	type ToolCallBlock,
	type ToolCallDiff,
	type ToolCallStatus,
	type ToolKind,
} from '../../agent_runtime/types';
import { Box, Text, type DOMElement } from 'ink';
import { theme } from '../styles/theme';
import { Markdown } from '../markdown/Markdown';
import { describeImage } from '../../images';
import { participantColor, type ParticipantColors } from '../MentionText';
import { useClickable } from '../interaction/clickable';
import {
	findSubagentByCall,
	getSubagentsVersion,
	subscribeSubagents,
	type SubagentRun,
	type SubagentStatus,
} from '../../agent_runtime/tools/subagents';
import { INTERRUPTED_REASON } from '../../agent_runtime/tools/subagents/report';
import { formatTokens } from '../../agent_runtime/usage';
import { historyParts } from './history';
import { workerAge } from '../../commands/agents/behavior';
import {
	getPermissionsVersion,
	isAwaitingApproval,
	lastDecision,
	subscribePermissions,
} from '../../agent_runtime/permissions/approvals';

// The verb a tool row leads with, from ACP's kind. The title the vendor sent
// is the rest of the line, so the row reads "Edit src/app.ts" whatever the
// vendor calls its edit tool.
const TOOL_VERBS: Record<ToolKind, string> = {
	read: 'Read',
	edit: 'Edit',
	delete: 'Delete',
	move: 'Move',
	search: 'Search',
	execute: 'Run',
	think: 'Think',
	fetch: 'Fetch',
	switch_mode: 'Mode',
	other: 'Tool',
};

function toolVerb(kind: ToolKind): string {
	return TOOL_VERBS[kind];
}

function singleLine(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

// The whole line as one string, for the callers with no row to truncate it:
// the approval prompt, the turn status and the desktop notification all name
// a call the same way the transcript does. `limit` cuts the title where the
// caller has less room than a row.
export function toolLine(call: Pick<ToolCallBlock, 'kind' | 'title'>, limit?: number): string {
	const title = singleLine(call.title);
	const shown = limit !== undefined && title.length > limit ? `${title.slice(0, limit - 1)}…` : title;
	return shown ? `${toolVerb(call.kind)} ${shown}` : toolVerb(call.kind);
}

function lineCount(text: string): number {
	return text.length === 0 ? 0 : text.split('\n').length;
}

// Ink measures a tab as zero columns, so a truncated line can still carry
// tabs the terminal expands past the row's edge and wraps into the sidebar.
function expandTabs(text: string): string {
	return text.replace(/\t/g, '    ');
}

function diffsOf(call: ToolCallBlock): ToolCallDiff[] {
	return call.content.filter((block): block is ToolCallDiff => block.type === 'diff');
}

// Lines added and removed by a file change, read off the diffs the call
// carries; null for a call that changed no file.
export function editCounts(call: ToolCallBlock): { added: number; removed: number } | null {
	const diffs = diffsOf(call);
	if (diffs.length === 0) return null;
	let added = 0;
	let removed = 0;
	for (const diff of diffs) {
		added += lineCount(diff.newText);
		removed += lineCount(diff.oldText ?? '');
	}
	return { added, removed };
}

export interface DiffLine {
	sign: '+' | '-' | ' ' | '…';
	text: string;
}

const DIFF_PREVIEW_LINES = 8;

function diffLines(sign: '+' | '-' | ' ', text: string): DiffLine[] {
	if (!text) return [];
	const lines = text.split('\n');
	const shown: DiffLine[] = lines.slice(0, DIFF_PREVIEW_LINES).map(line => ({ sign, text: line }));
	const hidden = lines.length - DIFF_PREVIEW_LINES;
	if (hidden > 0) shown.push({ sign: '…', text: `${hidden} more line${hidden === 1 ? '' : 's'}` });
	return shown;
}

// The change a call made, as removed then added lines of each file it
// touched; empty for anything that changed no file.
export function editPreview(call: ToolCallBlock): DiffLine[] {
	return diffsOf(call).flatMap(diff => [
		...diffLines('-', diff.oldText ?? ''),
		...diffLines('+', diff.newText),
	]);
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

// What SpawnAgent was asked, as the vendor recorded the call: the arguments
// themselves from Claude, nested under `arguments` from Codex.
function spawnArguments(call: ToolCallBlock): Record<string, unknown> {
	const record = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown> : null;
	const input = record(call.input) ?? {};
	return record(input.arguments) ?? input;
}

// Why a spawn failed before any worker existed: the error the tool returned,
// which Claude carries as the call's text and Codex as its raw output.
function spawnFailure(call: ToolCallBlock): string {
	const text = call.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(' ');
	if (text.trim()) return singleLine(text);
	const output = call.output !== null && typeof call.output === 'object' ? call.output as Record<string, unknown> : {};
	const error = output.error;
	if (typeof error === 'string' && error.trim()) return singleLine(error);
	const message = error !== null && typeof error === 'object' ? (error as { message?: unknown }).message : undefined;
	if (typeof message === 'string') return singleLine(message);
	const result = output.result as { content?: { text?: unknown }[] } | undefined;
	return singleLine((result?.content ?? []).flatMap(block => typeof block.text === 'string' ? [block.text] : []).join(' '));
}

// What the call produced: its text content, or failing that a string output.
export function outputPreview(call: ToolCallBlock): DiffLine[] {
	const text = call.content
		.flatMap(block => block.type === 'text' ? [block.text] : [])
		.join('\n');
	if (text) return diffLines(' ', text);
	return typeof call.output === 'string' ? diffLines(' ', call.output) : [];
}

function argumentLines(name: string, value: unknown): DiffLine[] {
	const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
	if (!text.includes('\n')) return [{ sign: ' ', text: `${name}: ${text}` }];
	return [{ sign: ' ', text: `${name}:` }, ...diffLines(' ', text)];
}

// What a row reveals when expanded: the diff of a file change, then what the
// call produced, and when there is neither, its input in full. Long values
// are cut the same way a diff is.
export function callDetail(call: ToolCallBlock): DiffLine[] {
	const lines = [...editPreview(call), ...outputPreview(call)];
	if (lines.length > 0 || call.input === undefined) return lines;
	const input = call.input;
	if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
		return Object.entries(input).flatMap(([name, value]) => argumentLines(name, value));
	}
	return diffLines(' ', typeof input === 'string' ? input : JSON.stringify(input) ?? String(input));
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

function isActivity(segment: MessageSegment | undefined): boolean {
	return segment !== undefined && ['tool_call', 'tool_run', 'plan', 'notice', 'thought'].includes(segment.type);
}

// A call that is part of a run of ordinary tool calls, which a group folds
// away behind "Ran N commands". A SpawnAgent call is not: its row is a
// worker's anchor, showing the run's status and carrying its report, so it
// keeps a row of its own however many calls sit beside it. Plan updates
// also stand alone so each checklist can be opened where it happened.
function groupable(block: MessageBlock): block is ToolCallBlock {
	return block.type === 'tool_call' && !isSpawnAgent(block) && !isPlanCall(block);
}

// A thought shows only while it is what the model is doing now: the last
// block of a reply still being written. Once the model moves on it goes, and
// the tool calls on either side of it group as though it was never there.
export function visibleContent(content: readonly MessageBlock[], live: boolean): MessageBlock[] {
	const last = content.length - 1;
	return content.filter((block, index) => block.type !== 'thought' || (live && index === last));
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
		: block.severity === 'error' ? theme.danger : theme.textMuted;
	return (
		<Box paddingX={1}>
			<Text color={color} dimColor wrap="truncate-end">
				{'  '}{singleLine(block.title)}{block.description ? ` · ${singleLine(block.description)}` : ''}
			</Text>
		</Box>
	);
}

function finished(call: ToolCallBlock): boolean {
	return call.status === 'completed' || call.status === 'failed';
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

// User-visible permission state: only an approval that needs their input or
// a call they declined.
function usePermissionStatus(call: ToolCallBlock, sessionId?: string): { text: string; color: string } | null {
	useSyncExternalStore(subscribePermissions, getPermissionsVersion);
	if (sessionId === undefined) return null;
	if (isAwaitingApproval(call.id, sessionId)) return { text: 'waiting for approval', color: theme.pending };
	if (lastDecision(call.id, sessionId) === 'deny') return { text: 'declined by user', color: theme.danger };
	return null;
}

const statusColors: Record<ToolCallStatus, string> = {
	pending: theme.textSubtle,
	in_progress: theme.textSubtle,
	completed: theme.toolIndicator,
	failed: theme.danger,
};

// One line for one call: status dot, verb, title, and for a file change the
// lines it added and removed. Truncated at the row's width.
function ToolSummary({ call, indent = '', hovered = false, sessionId }: {
	sessionId?: string;
	call: ToolCallBlock;
	indent?: string;
	hovered?: boolean;
}) {
	const permission = usePermissionStatus(call, sessionId);
	const title = singleLine(call.title);
	const counts = editCounts(call);
	return (
		<Text wrap="truncate-end">
			<Text color={statusColors[call.status]}>{indent}●</Text>
			<Text color={hovered ? theme.textMuted : theme.textSubtle}> {toolVerb(call.kind)}</Text>
			{title && <Text color={theme.textSubtle} dimColor> {title}</Text>}
			{counts && <Text color={theme.success}> +{counts.added}</Text>}
			{counts && counts.removed > 0 && <Text color={theme.danger}> −{counts.removed}</Text>}
			{permission && <Text color={permission.color}> · {permission.text}</Text>}
		</Text>
	);
}

const detailColors: Record<DiffLine['sign'], string> = {
	'+': theme.success,
	'-': theme.danger,
	' ': theme.textMuted,
	'…': theme.textSubtle,
};

function DiffPreview({ lines }: { lines: readonly DiffLine[] }) {
	return (
		<Box flexDirection="column" marginLeft={4}>
			{lines.map((line, index) => (
				<Text key={index} color={detailColors[line.sign]} wrap="truncate-end">
					{line.sign} {expandTabs(line.text)}
				</Text>
			))}
		</Box>
	);
}

// One call, collapsed to its summary line until clicked; expanded, it also
// shows what the call carried.
function ToolCallEntry({ call, indent, sessionId }: {
	sessionId?: string;
	call: ToolCallBlock;
	indent?: string;
}) {
	const [expanded, setExpanded] = useState(false);
	const toggle = useCallback(() => setExpanded(current => !current), []);
	const ref = useRef<DOMElement>(null);
	const hovered = useClickable(ref, toggle);
	const detail = expanded ? callDetail(call) : [];
	return (
		<Box flexDirection="column">
			<Box ref={ref}>
				<ToolSummary sessionId={sessionId} call={call} indent={indent} hovered={hovered} />
			</Box>
			{detail.length > 0 && <DiffPreview lines={detail} />}
		</Box>
	);
}

function AnimatedCommandStatus({ count }: { count: number }) {
	const [dots, setDots] = useState(1);
	useEffect(() => {
		const timer = setInterval(() => setDots(current => current % 3 + 1), 400);
		return () => clearInterval(timer);
	}, []);
	return <>Running {count} commands{'.'.repeat(dots)}</>;
}

export function ToolRunGroup({ calls, defaultExpanded = false, sessionId }: {
	sessionId?: string;
	calls: readonly ToolCallBlock[];
	defaultExpanded?: boolean;
}) {
	const hasCompletedEdit = calls.some(call => call.status === 'completed' && editPreview(call).length > 0);
	// Follow arriving file changes until the user chooses whether to expand.
	const [expansionOverride, setExpansionOverride] = useState<boolean | null>(null);
	const expanded = expansionOverride ?? (defaultExpanded || hasCompletedEdit);
	const toggle = useCallback(() => setExpansionOverride(!expanded), [expanded]);
	const ref = useRef<DOMElement>(null);
	const hovered = useClickable(ref, toggle);
	const complete = calls.every(finished);
	const summaryColor = hovered ? theme.accentSoft : theme.textMuted;

	return (
		<Box flexDirection="column" marginLeft={2}>
			<Box ref={ref} flexDirection="row" flexWrap="nowrap">
				<Text color={summaryColor} wrap="truncate-end">
					{complete ? `Ran ${calls.length} commands` : <AnimatedCommandStatus count={calls.length} />}
				</Text>
			</Box>
			{expanded ? (
				<Box flexDirection="column" marginLeft={2}>
					{calls.map(call => (
						<ToolCallEntry key={call.id} call={call} sessionId={sessionId} />
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
	const declined = failed.filter(call => lastDecision(call.id, run.sessionId) === 'deny').length;
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
// never started a worker says why. A click folds the report away and back,
// and opens a running one's task in full.
function SpawnAgentEntry({ call, sessionId }: { call: ToolCallBlock; sessionId?: string }) {
	const { run, status } = useSubagentRun(call, sessionId);
	const permission = usePermissionStatus(call, sessionId);
	const report = spawnReport(call);
	const [expansionOverride, setExpansionOverride] = useState<boolean | null>(null);
	const expanded = expansionOverride ?? (report !== '' && status !== 'working');
	const toggle = useCallback(() => setExpansionOverride(!expanded), [expanded]);
	const ref = useRef<DOMElement>(null);
	const hovered = useClickable(ref, toggle);
	const args = spawnArguments(call);
	const argument = (key: string) => typeof args[key] === 'string' ? singleLine(args[key] as string) : '';
	const name = run?.name ?? (argument('name') || 'Agent');
	const prompt = run?.prompt ?? (typeof args.prompt === 'string' ? args.prompt : '');
	const task = run ? run.description || singleLine(run.prompt) : argument('description') || singleLine(prompt);
	const color = subagentColors[status];
	// A spawn waiting on the user's approval has not started anything yet;
	// its title says what it waits for.
	const summary = run ? runSummary(run)
		: status === 'failed' ? ['Failed', spawnFailure(call)].filter(Boolean).join(': ')
			: status === 'working' && !permission ? 'Starting' : '';
	return (
		<Box flexDirection="column">
			<Box ref={ref} flexDirection="column">
				<Text wrap="truncate-end">
					<Text color={color}>{'  '}●</Text>
					<Text color={hovered ? theme.accentSoft : theme.text} bold> {name}</Text>
					{task && <Text color={hovered ? theme.accentSoft : theme.textMuted}>({task})</Text>}
					{run && <Text color={theme.textSubtle} dimColor> · {run.model} {run.thinkingLevel} · {run.id}</Text>}
					{run?.branch && <Text color={theme.textSubtle} dimColor> · {run.branch}</Text>}
					{permission && <Text color={permission.color}> · {permission.text}</Text>}
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
function ToolCallRow({ call, sessionId }: {
	call: ToolCallBlock;
	sessionId?: string;
}) {
	return (
		<Box flexDirection="column" paddingX={1}>
			{isSpawnAgent(call)
				? <SpawnAgentEntry call={call} sessionId={sessionId} />
				: <ToolCallEntry call={call} indent="  " sessionId={sessionId} />}
		</Box>
	);
}

// A thought that opens with a bold title, as summarised reasoning does, is
// named by that title; any other by its own opening words, and unfolds in
// place rather than repeating them underneath.
export function thoughtHeading(text: string): { title: string | null; body: string } {
	const trimmed = text.trim();
	const titled = /^\*\*(.+?)\*\*\s*/.exec(trimmed);
	if (titled) return { title: singleLine(titled[1]!), body: trimmed.slice(titled[0].length) };
	return { title: null, body: trimmed };
}

// Reasoning the runtime streamed: its step on one dim line until clicked,
// then the whole thought, laid out like a tool row.
function ThoughtRow({ text }: { text: string }) {
	const [expanded, setExpanded] = useState(false);
	const toggle = useCallback(() => setExpanded(current => !current), []);
	const ref = useRef<DOMElement>(null);
	useClickable(ref, toggle);
	const { title, body } = thoughtHeading(text);
	if (!title && expanded) {
		return (
			<Box flexDirection="column" paddingX={1}>
				<Box ref={ref} marginLeft={2}>
					<Text color={theme.textSubtle} wrap="wrap">{body}</Text>
				</Box>
			</Box>
		);
	}
	return (
		<Box flexDirection="column" paddingX={1}>
			<Box ref={ref}>
				<Text color={theme.textSubtle} wrap="truncate-end">
					{'  '}{title ?? singleLine(body)}
				</Text>
			</Box>
			{expanded && body && (
				<Box marginLeft={4}>
					<Text color={theme.textSubtle} wrap="wrap">{body}</Text>
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

interface ChatMessageProps {
	sessionId?: string;
	message: Message;
	model?: string;
	participantColors?: ParticipantColors;
	// The reply is still being written.
	live?: boolean;
	// The current thought is already shown in the turn status row.
	hideThought?: boolean;
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
	}));
	return <HistoryBody {...props} entries={entries} />;
}

// A draft edit leaves the entire history subtree alone; streaming only
// passes the changed entries through the message-level boundary below.
const HistoryBody = memo(function HistoryBody({ entries, ...props }: {
	entries: readonly (Pick<ChatMessageProps, 'message' | 'model' | 'live' | 'hideThought'> & { key: string })[];
	sessionId: string;
	participantColors: ParticipantColors;
}) {
	return entries.map(({ key, ...entry }) => <MessageBody key={key} {...props} {...entry} />);
}, (previous, next) => previous.sessionId === next.sessionId
	&& sameColors(previous.participantColors, next.participantColors)
	&& previous.entries.length === next.entries.length
	&& previous.entries.every((entry, index) => {
		const other = next.entries[index]!;
		return entry.key === other.key && entry.model === other.model && entry.live === other.live && entry.hideThought === other.hideThought && sameMessage(entry.message, other.message);
	}));

function SegmentView({ block, participantColors, sessionId }: {
	block: MessageSegment;
	participantColors?: ParticipantColors;
	sessionId?: string;
}) {
	switch (block.type) {
		case 'text':
			return block.filePath ? null : <Markdown participantColors={participantColors}>{block.text}</Markdown>;
		case 'image':
			return <ImageLine image={block} />;
		case 'thought':
			return <ThoughtRow text={block.text} />;
		case 'plan':
			return <PlanRow call={block.call} />;
		case 'notice':
			return <NoticeRow block={block} />;
		case 'compaction':
			return <CompactionRule block={block} participantColors={participantColors} />;
		case 'tool_run':
			return <ToolRunGroup calls={block.calls} sessionId={sessionId} />;
		case 'tool_call':
			return <ToolCallRow call={block} sessionId={sessionId} />;
	}
}

const MessageBody = memo(function MessageBody({
	message,
	model,
	participantColors,
	sessionId,
	live = false,
	hideThought = false,
}: ChatMessageProps) {
	const isUser = message.role === "user";
	const participantName = message.participant ?? 'sirus';
	const segments = messageSegments(visibleContent(message.content, live && !hideThought));
	if (message.content.length > 0 && segments.length === 0) return null;
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
			{segments.map((block, index) => {
				const row = <SegmentView key={index} block={block} participantColors={participantColors} sessionId={sessionId} />;
				if (!isActivity(block)) return row;
				const previous = segments[index - 1];
				const next = segments[index + 1];
				return <Box key={index} flexDirection="column"
					marginTop={previous && !isActivity(previous) ? 1 : 0}
					marginBottom={next && !isActivity(next) ? 1 : 0}>{row}</Box>;
			})}
		</Box>
	);
}, (previous, next) => previous.sessionId === next.sessionId
	&& previous.model === next.model
	&& previous.live === next.live
	&& previous.hideThought === next.hideThought
	&& sameColors(previous.participantColors, next.participantColors)
	&& sameMessage(previous.message, next.message));
