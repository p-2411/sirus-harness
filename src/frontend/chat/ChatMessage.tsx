import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
	DEFAULT_PARTICIPANT,
	isPlanCall,
	planEntriesOf,
	type CompactionBlock,
	type ImageBlock,
	type Message,
	type MessageBlock,
	type PlanEntry,
	type ThoughtBlock,
	type ToolCallBlock,
	type ToolCallDiff,
	type ToolCallStatus,
	type ToolKind,
} from '../../agent_runtime/types';
import { Box, Text, type DOMElement } from 'ink';
import { theme } from '../styles/theme';
import { Markdown } from '../markdown/Markdown';
import { describeImage } from '../../images';
import { terminalText } from '../terminal/text';
import { participantColor, type ParticipantColors } from '../MentionText';
import { useClickable } from '../interaction/clickable';
import {
	findSubagentByCall,
	getSubagentsVersion,
	subscribeSubagents,
	type SubagentRun,
	type SubagentStatus,
} from '../../agent_runtime/tools/subagents';
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

// A vendor's title or an agent's words, as one line the terminal only prints.
function singleLine(text: string): string {
	return terminalText(text).replace(/\s+/g, ' ').trim();
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
	return call.kind === 'other' && /(?:^|[^A-Za-z0-9])SpawnAgent\s*$/.test(call.title);
}

// The report the session put on the call when the worker it started ended.
// The call's own content is the handle the vendor was given back, which is
// not what the user came to read.
function spawnReport(call: ToolCallBlock): string {
	return isSpawnAgent(call) && typeof call.output === 'string' ? call.output.trim() : '';
}

// What the call produced: the worker's report on a SpawnAgent row, otherwise
// its text content, or failing that a string output.
export function outputPreview(call: ToolCallBlock): DiffLine[] {
	const report = spawnReport(call);
	if (report) return diffLines(' ', report);
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

// An agent's plan, shown open as a checklist rather than as a call.
interface PlanSegment {
	type: 'plan';
	call: ToolCallBlock;
}

export type MessageSegment = MessageBlock | ToolRun | PlanSegment;

// A call that is part of a run of ordinary tool calls, which a group folds
// away behind "Ran N commands". A SpawnAgent call is not: its row is a
// worker's anchor, showing the run's status and carrying its report, so it
// keeps a row of its own however many calls sit beside it.
function groupable(block: MessageBlock): block is ToolCallBlock {
	return block.type === 'tool_call' && !isSpawnAgent(block);
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

// The plan as the agent last set it: how far along it is, then every step
// with its state, the step in hand picked out.
function PlanRow({ call }: { call: ToolCallBlock }) {
	const entries = planEntriesOf(call);
	const done = entries.filter(entry => entry.status === 'completed').length;
	return (
		<Box flexDirection="column" paddingX={1} paddingY={1}>
			<Text color={theme.textMuted}>  Plan · {done} of {entries.length} done</Text>
			{entries.map((entry, index) => (
				<Box key={index} marginLeft={4}>
					<Box width={2} flexShrink={0}>
						<Text color={PLAN_MARKS[entry.status].color}>{PLAN_MARKS[entry.status].mark}</Text>
					</Box>
					<Text
						color={entry.status === 'in_progress' ? theme.text : theme.textMuted}
						strikethrough={entry.status === 'completed'}
					>
						{terminalText(entry.content)}
					</Text>
				</Box>
			))}
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
	status: SubagentIndicator | null;
} {
	useSyncExternalStore(subscribeSubagents, getSubagentsVersion);
	const run = sessionId === undefined ? undefined : findSubagentByCall(call.id, sessionId);
	if (run) return { run, status: run.status };
	if (!isSpawnAgent(call)) return { status: null };
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
	const { run, status: subagent } = useSubagentRun(call, sessionId);
	const permission = usePermissionStatus(call, sessionId);
	const color = subagent ? subagentColors[subagent] : statusColors[call.status];
	const title = singleLine(call.title);
	const counts = editCounts(call);
	return (
		<Text wrap="truncate-end">
			<Text color={color}>{indent}●</Text>
			<Text color={hovered ? theme.textMuted : theme.textSubtle}> {toolVerb(call.kind)}</Text>
			{run && <Text color={theme.textSubtle} dimColor> {run.model}</Text>}
			{title && <Text color={theme.textSubtle} dimColor> {title}</Text>}
			{counts && <Text color={theme.success}> +{counts.added}</Text>}
			{counts && counts.removed > 0 && <Text color={theme.danger}> −{counts.removed}</Text>}
			{run && <Text color={theme.textSubtle} dimColor> · {run.id}</Text>}
			{subagent && subagent !== 'unknown' && <Text color={color}> · {subagent}</Text>}
			{run?.branch && <Text color={theme.textSubtle} dimColor> · {run.branch}</Text>}
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
					{line.sign} {expandTabs(terminalText(line.text))}
				</Text>
			))}
		</Box>
	);
}

// Which rows the user opened or closed, kept apart from the components that
// show them. Copying a selection renders the history again off screen to
// reach what has scrolled away, and that render has to open the rows the
// screen has open, or the copy reads the wrong lines. Held per message, so a
// rewind that drops a message drops what was opened in it too.
const openedRows = new WeakMap<Message, Map<string, boolean>>();
const openedRowListeners = new Set<() => void>();

function subscribeOpenedRows(listener: () => void): () => void {
	openedRowListeners.add(listener);
	return () => {
		openedRowListeners.delete(listener);
	};
}

// Whether one row of a message is open: the user's choice once they have
// made one, `fallback` until then. The toggle records the opposite of what
// is showing.
function useRowExpansion(message: Message, row: string, fallback: boolean): [boolean, () => void] {
	const chosen = useSyncExternalStore(subscribeOpenedRows, () => openedRows.get(message)?.get(row));
	const expanded = chosen ?? fallback;
	const toggle = useCallback(() => {
		const rows = openedRows.get(message) ?? new Map<string, boolean>();
		rows.set(row, !expanded);
		openedRows.set(message, rows);
		for (const listener of openedRowListeners) listener();
	}, [message, row, expanded]);
	return [expanded, toggle];
}

// One call, collapsed to its summary line until clicked; expanded, it also
// shows what the call carried. A worker's report is the exception: it is what
// the user has been waiting for, so the SpawnAgent row opens itself once the
// run has ended, and a click still closes it.
function ToolCallEntry({ message, call, indent, sessionId }: {
	message: Message;
	sessionId?: string;
	call: ToolCallBlock;
	indent?: string;
}) {
	const { status } = useSubagentRun(call, sessionId);
	const showsReport = spawnReport(call) !== '' && status !== 'working';
	const [expanded, toggle] = useRowExpansion(message, `call:${call.id}`, showsReport);
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

// A group is known by its first call, which stays first as the run grows.
export function ToolRunGroup({ message, calls, defaultExpanded = false, sessionId }: {
	message: Message;
	sessionId?: string;
	calls: readonly ToolCallBlock[];
	defaultExpanded?: boolean;
}) {
	const hasCompletedEdit = calls.some(call => call.status === 'completed' && editPreview(call).length > 0);
	// Follow arriving file changes until the user chooses whether to expand.
	const [expanded, toggle] = useRowExpansion(message, `group:${calls[0]?.id}`, defaultExpanded || hasCompletedEdit);
	const ref = useRef<DOMElement>(null);
	const hovered = useClickable(ref, toggle);
	const complete = calls.every(finished);
	const summaryColor = hovered ? theme.accentSoft : theme.textMuted;

	return (
		<Box flexDirection="column" marginLeft={2} marginY={1}>
			<Box ref={ref} flexDirection="row" flexWrap="nowrap">
				<Text color={summaryColor} wrap="truncate-end">
					{complete ? `Ran ${calls.length} commands` : <AnimatedCommandStatus count={calls.length} />}
				</Text>
			</Box>
			{expanded ? (
				<Box flexDirection="column" marginLeft={2}>
					{calls.map(call => (
						<ToolCallEntry key={call.id} message={message} call={call} sessionId={sessionId} />
					))}
				</Box>
			) : null}
		</Box>
	);
}

// A row on its own is set off by a blank line; rows that follow one another
// stack directly, as the entries of a group do.
function ToolCallRow({ message, call, sessionId, joinsPrevious = false, joinsNext = false }: {
	message: Message;
	call: ToolCallBlock;
	sessionId?: string;
	joinsPrevious?: boolean;
	joinsNext?: boolean;
}) {
	return (
		<Box flexDirection="column" paddingX={1} paddingTop={joinsPrevious ? 0 : 1} paddingBottom={joinsNext ? 0 : 1}>
			<ToolCallEntry message={message} call={call} indent="  " sessionId={sessionId} />
		</Box>
	);
}

// Reasoning the runtime streamed: one dim line until clicked, then the whole
// thought, laid out like a tool row.
function ThoughtRow({ message, block }: { message: Message; block: ThoughtBlock }) {
	const [expanded, toggle] = useRowExpansion(message, `block:${message.content.indexOf(block)}`, false);
	const ref = useRef<DOMElement>(null);
	const hovered = useClickable(ref, toggle);
	const text = block.text;
	return (
		<Box flexDirection="column" padding={1}>
			<Box ref={ref}>
				<Text wrap="truncate-end">
					<Text color={hovered ? theme.textMuted : theme.textSubtle}>  thinking</Text>
					{!expanded && <Text color={theme.textSubtle} dimColor> {singleLine(text)}</Text>}
				</Text>
			</Box>
			{expanded && (
				<Box marginLeft={4}>
					<Text color={theme.textSubtle} dimColor wrap="wrap">{terminalText(text).trim()}</Text>
				</Box>
			)}
		</Box>
	);
}

// The runtime folded its own conversation here: one rule across the message,
// and on a click the summary it reported, since that is all the participant
// now knows of the conversation above it.
function CompactionRule({ message, block, participantColors }: {
	message: Message;
	block: CompactionBlock;
	participantColors?: ParticipantColors;
}) {
	const [expanded, toggle] = useRowExpansion(message, `block:${message.content.indexOf(block)}`, false);
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

export function ChatMessage({
	message,
	model,
	participantColors,
	sessionId,
}: {
	sessionId?: string;
	message: Message;
	model?: string;
	participantColors?: ParticipantColors;
}) {
	const isUser = message.role === "user";
	const participantName = message.participant ?? DEFAULT_PARTICIPANT;
	const segments = messageSegments(message.content);
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
			</Text>
			{segments.map((block, index) => {
				switch (block.type) {
					case 'text':
						if (block.filePath) return null;
						return <Markdown key={index} participantColors={participantColors}>{block.text}</Markdown>;
					case 'image':
						return <ImageLine key={index} image={block} />;
					case 'thought':
						return <ThoughtRow key={index} message={message} block={block} />;
					case 'plan':
						return <PlanRow key={index} call={block.call} />;
					case 'compaction':
						return <CompactionRule key={index} message={message} block={block} participantColors={participantColors} />;
					case 'tool_run':
						return <ToolRunGroup key={index} message={message} calls={block.calls} sessionId={sessionId} />;
					case 'tool_call':
						return (
							<ToolCallRow
								key={index}
								message={message}
								call={block}
								sessionId={sessionId}
								joinsPrevious={segments[index - 1]?.type === 'tool_call'}
								joinsNext={segments[index + 1]?.type === 'tool_call'}
							/>
						);
				}
			})}
		</Box>
	);
}
