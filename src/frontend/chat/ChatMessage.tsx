import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Message, MessageBlock, ToolCallBlock, ToolResultBlock } from '../../agent_runtime/types';
import { Box, Text, type DOMElement } from 'ink';
import { theme } from '../styles/theme';
import { Markdown } from '../markdown/Markdown';
import { participantColor, type ParticipantColors } from '../MentionText';
import { useClickable } from '../interaction/clickable';
import {
	findSubagentByCall,
	getSubagentsVersion,
	subscribeSubagents,
	type SubagentStatus,
} from '../../agent_runtime/tools/subagents';
import {
	getPermissionsVersion,
	isAwaitingApproval,
	isAwaitingJudge,
	isDeclinedResult,
	subscribePermissions,
} from '../../agent_runtime/permissions/permissions';

function singleLine(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

function lineCount(text: string): number {
	return text.length === 0 ? 0 : text.split('\n').length;
}

function textArgument(call: ToolCallBlock, name: string): string {
	const value = call.arguments[name];
	return typeof value === 'string' ? value : '';
}

// What a tool row shows after the tool's name: the thing the call is about,
// in full, left to the row to truncate at its own width.
export function toolSubject(call: ToolCallBlock): string {
	switch (call.name) {
		case 'ReadFile':
		case 'WriteFile':
		case 'EditFile':
			return textArgument(call, 'path');
		case 'RunShell':
			return singleLine(textArgument(call, 'command'));
		case 'SearchFiles': {
			const directory = textArgument(call, 'path');
			return `${textArgument(call, 'pattern')}${directory && directory !== '.' ? ` in ${directory}` : ''}`;
		}
		case 'SpawnAgent':
			return singleLine(textArgument(call, 'prompt'));
		case 'CheckAgent':
		case 'CancelAgent':
			return textArgument(call, 'id');
		case 'WebSearch':
		case 'SearchMemories':
			return textArgument(call, 'query');
		case 'FetchURL':
			return textArgument(call, 'url');
		case 'SaveMemory':
		case 'GetMemory':
		case 'DeleteMemory':
			return textArgument(call, 'name');
		default: {
			const first = Object.values(call.arguments)[0];
			if (first === undefined) return '';
			return singleLine(typeof first === 'string' ? first : JSON.stringify(first) ?? String(first));
		}
	}
}

// Lines added and removed by a file change, read off the text the call carries.
export function editCounts(call: ToolCallBlock): { added: number; removed: number } | null {
	if (call.name === 'WriteFile') return { added: lineCount(textArgument(call, 'content')), removed: 0 };
	if (call.name === 'EditFile') {
		return {
			added: lineCount(textArgument(call, 'new_text')),
			removed: lineCount(textArgument(call, 'old_text')),
		};
	}
	return null;
}

export interface DiffLine {
	sign: '+' | '-' | '…';
	text: string;
}

const DIFF_PREVIEW_LINES = 8;

function diffLines(sign: '+' | '-', text: string): DiffLine[] {
	if (!text) return [];
	const lines = text.split('\n');
	const shown: DiffLine[] = lines.slice(0, DIFF_PREVIEW_LINES).map(line => ({ sign, text: line }));
	const hidden = lines.length - DIFF_PREVIEW_LINES;
	if (hidden > 0) shown.push({ sign: '…', text: `${hidden} more line${hidden === 1 ? '' : 's'}` });
	return shown;
}

// The change a file call made, as removed then added lines; empty for
// anything that is not a file change.
export function editPreview(call: ToolCallBlock): DiffLine[] {
	if (call.name === 'WriteFile') return diffLines('+', textArgument(call, 'content'));
	if (call.name === 'EditFile') {
		return [
			...diffLines('-', textArgument(call, 'old_text')),
			...diffLines('+', textArgument(call, 'new_text')),
		];
	}
	return [];
}

interface ToolRun {
	type: 'tool_run';
	blocks: Array<ToolCallBlock | ToolResultBlock>;
}

export type MessageSegment = MessageBlock | ToolRun;

/** Collapse only adjacent tool activity containing two or more calls. */
export function messageSegments(content: readonly MessageBlock[]): MessageSegment[] {
	const segments: MessageSegment[] = [];
	for (let index = 0; index < content.length;) {
		if (content[index].type === 'text') {
			segments.push(content[index]);
			index++;
			continue;
		}

		const blocks: Array<ToolCallBlock | ToolResultBlock> = [];
		while (index < content.length && content[index].type !== 'text') {
			blocks.push(content[index] as ToolCallBlock | ToolResultBlock);
			index++;
		}
		const callCount = blocks.filter(block => block.type === 'tool_call').length;
		if (callCount > 1) segments.push({ type: 'tool_run', blocks });
		else segments.push(...blocks);
	}
	return segments;
}

// A SpawnAgent call outlives its tool result, so its row tracks the live run:
// amber while the subagent works, green once it is done, red if it failed. A
// run from an earlier process left no record, so its dot stays neutral.
type SubagentIndicator = SubagentStatus | 'unknown';

const subagentColors: Record<SubagentIndicator, string> = {
	working: theme.pending,
	done: theme.success,
	failed: theme.danger,
	cancelled: theme.textMuted,
	unknown: theme.textSubtle,
};

function useSubagentStatus(call: ToolCallBlock, result?: ToolResultBlock): SubagentIndicator | null {
	useSyncExternalStore(subscribeSubagents, getSubagentsVersion);
	if (call.name !== 'SpawnAgent') return null;
	const run = findSubagentByCall(call.id);
	if (run) return run.status;
	if (!result) return 'working';
	return result.isError ? 'failed' : 'unknown';
}

// What the permission gate is doing with a call: waiting on the user,
// checking it, or recording the user's refusal.
function usePermissionStatus(call: ToolCallBlock, result?: ToolResultBlock): { text: string; color: string } | null {
	useSyncExternalStore(subscribePermissions, getPermissionsVersion);
	if (result?.isError && isDeclinedResult(result.result)) return { text: 'declined by user', color: theme.danger };
	if (!result && isAwaitingApproval(call.id)) return { text: 'waiting for approval', color: theme.pending };
	if (!result && isAwaitingJudge(call.id)) return { text: 'checking', color: theme.pending };
	return null;
}

function subagentModel(call: ToolCallBlock): string {
	return findSubagentByCall(call.id)?.model
		?? (typeof call.arguments.model === 'string' ? call.arguments.model : '');
}

// One line for one call: status dot, name, subject, and for a file change
// the lines it added and removed. Truncated at the row's width.
function ToolSummary({ call, result, indent = '', hovered = false, marker }: {
	call: ToolCallBlock;
	result?: ToolResultBlock;
	indent?: string;
	hovered?: boolean;
	marker?: string;
}) {
	const subagent = useSubagentStatus(call, result);
	const permission = usePermissionStatus(call, result);
	const color = subagent
		? subagentColors[subagent]
		: result?.isError ? theme.danger : result ? theme.toolIndicator : theme.textSubtle;
	const subject = toolSubject(call);
	const counts = editCounts(call);
	return (
		<Text wrap="truncate-end">
			<Text color={color}>{indent}●</Text>
			<Text color={hovered ? theme.highlight : theme.textSubtle} bold={hovered}> {call.name}</Text>
			{subagent && <Text color={theme.textSubtle} dimColor> {subagentModel(call)}</Text>}
			{subject && <Text color={theme.textSubtle} dimColor> {subject}</Text>}
			{counts && <Text color={theme.success}> +{counts.added}</Text>}
			{counts && call.name === 'EditFile' && <Text color={theme.danger}> −{counts.removed}</Text>}
			{subagent && subagent !== 'unknown' && <Text color={color}> · {subagent}</Text>}
			{permission && <Text color={permission.color}> · {permission.text}</Text>}
			{marker && <Text color={hovered ? theme.highlight : theme.textSubtle}> {marker}</Text>}
		</Text>
	);
}

function DiffPreview({ lines }: { lines: readonly DiffLine[] }) {
	return (
		<Box flexDirection="column" marginLeft={4}>
			{lines.map((line, index) => (
				<Text
					key={index}
					color={line.sign === '+' ? theme.success : line.sign === '-' ? theme.danger : theme.textSubtle}
					wrap="truncate-end"
				>
					{line.sign} {line.text}
				</Text>
			))}
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

export function ToolRunGroup({ blocks, defaultExpanded = false }: {
	blocks: readonly (ToolCallBlock | ToolResultBlock)[];
	defaultExpanded?: boolean;
}) {
	const [expanded, setExpanded] = useState(defaultExpanded);
	const toggle = useCallback(() => setExpanded(current => !current), []);
	const ref = useRef<DOMElement>(null);
	const hovered = useClickable(ref, toggle);
	const calls = blocks.filter((block): block is ToolCallBlock => block.type === 'tool_call');
	const results = new Map(
		blocks
			.filter((block): block is ToolResultBlock => block.type === 'tool_result')
			.map(result => [result.callId, result]),
	);
	const complete = calls.every(call => results.has(call.id));
	const summaryColor = hovered ? theme.highlight : theme.textMuted;

	return (
		<Box flexDirection="column" marginLeft={2} marginY={1}>
			<Box ref={ref} flexDirection="row" flexWrap="nowrap">
				<Text color={summaryColor} bold={hovered}>{expanded ? '⌄' : '›'}</Text>
				<Text color={summaryColor} bold={hovered} wrap="truncate-end">
					{' '}{complete ? `Ran ${calls.length} commands` : <AnimatedCommandStatus count={calls.length} />}
				</Text>
			</Box>
			{expanded ? (
				<Box flexDirection="column" marginLeft={2}>
					{calls.map(call => <ToolSummary key={call.id} call={call} result={results.get(call.id)} />)}
				</Box>
			) : null}
		</Box>
	);
}

// A lone call. A file change opens on click to show what it wrote.
function ToolCallRow({ call, result }: { call: ToolCallBlock; result?: ToolResultBlock }) {
	const preview = editPreview(call);
	const expandable = preview.length > 0;
	const [expanded, setExpanded] = useState(false);
	const toggle = useCallback(() => {
		if (expandable) setExpanded(current => !current);
	}, [expandable]);
	const ref = useRef<DOMElement>(null);
	const hovered = useClickable(ref, toggle) && expandable;
	return (
		<Box flexDirection="column" padding={1}>
			<Box ref={ref}>
				<ToolSummary
					call={call}
					result={result}
					indent="  "
					hovered={hovered}
					{...(expandable ? { marker: expanded ? '⌄' : '›' } : {})}
				/>
			</Box>
			{expanded && <DiffPreview lines={preview} />}
		</Box>
	);
}

function renderToolBlock(
	block: ToolCallBlock | ToolResultBlock,
	key: number,
	results: ReadonlyMap<string, ToolResultBlock>,
) {
	if (block.type === 'tool_call') {
		return <ToolCallRow key={key} call={block} result={results.get(block.id)} />;
	}
	return (
		<Text key={key} color={block.isError ? theme.danger : theme.success}>
			{block.isError ? `! ${block.result}` : ''}
		</Text>
	);
}

export function ChatMessage({
	message,
	model,
	participantColors,
}: {
	message: Message;
	model?: string;
	participantColors?: ParticipantColors;
}) {
	const isUser = message.role === "user";
	const participantName = message.participant ?? 'sirus';
	const results = new Map(
		message.content
			.filter((block): block is ToolResultBlock => block.type === 'tool_result')
			.map(result => [result.callId, result]),
	);
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
			{messageSegments(message.content).map((block, index) => {
				if (block.type === 'text') {
					return <Markdown key={index} participantColors={participantColors}>{block.text}</Markdown>;
				}
				if (block.type === 'tool_run') {
					return <ToolRunGroup key={index} blocks={block.blocks} />;
				}
				return renderToolBlock(block, index, results);
			})}
		</Box>
	);
}
