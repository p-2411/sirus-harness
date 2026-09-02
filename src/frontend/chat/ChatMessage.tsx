import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Message, MessageBlock, ToolCallBlock, ToolResultBlock } from '../../data/data';
import { Box, Text, type DOMElement } from 'ink';
import { theme } from '../theme';
import { Markdown } from '../markdown/Markdown';
import { participantColor, type ParticipantColors } from '../MentionText';
import { useClickable } from '../clickable';
import {
	findSubagentByCall,
	getSubagentsVersion,
	subscribeSubagents,
	type SubagentStatus,
} from '../../agent/subagents';
import {
	getPermissionsVersion,
	isAwaitingApproval,
	isAwaitingJudge,
	isDeclinedResult,
	judgeVerdictFor,
	subscribePermissions,
} from '../../agent/permissions';

const argumentPreviewLength = 10;

function formatToolArguments(args: Record<string, unknown>): string {
	const firstEntry = Object.entries(args)[0];
	if (!firstEntry) return '';

	const [name, value] = firstEntry;
	const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
	const preview = text.length > argumentPreviewLength
		? `${text.slice(0, argumentPreviewLength)}...`
		: text;

	return `{ ${name} : ${preview}`;
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

// What the permission gate did with a call: the prompt it is waiting on, the
// judge it is waiting on, the verdict it got, or the user's refusal.
function usePermissionStatus(call: ToolCallBlock, result?: ToolResultBlock): { text: string; color: string } | null {
	useSyncExternalStore(subscribePermissions, getPermissionsVersion);
	if (result?.isError && isDeclinedResult(result.result)) return { text: 'declined by user', color: theme.danger };
	if (!result && isAwaitingApproval(call.id)) return { text: 'waiting for approval', color: theme.pending };
	if (!result && isAwaitingJudge(call.id)) return { text: 'checking', color: theme.pending };
	const verdict = judgeVerdictFor(call.id);
	return verdict ? { text: `judge: ${verdict}`, color: theme.textSubtle } : null;
}

function subagentModel(call: ToolCallBlock): string {
	return findSubagentByCall(call.id)?.model
		?? (typeof call.arguments.model === 'string' ? call.arguments.model : '');
}

function ToolLine({ call, result }: { call: ToolCallBlock; result?: ToolResultBlock }) {
	const subagent = useSubagentStatus(call, result);
	const permission = usePermissionStatus(call, result);
	const color = subagent
		? subagentColors[subagent]
		: result?.isError ? theme.danger : result ? theme.toolIndicator : theme.textSubtle;
	return (
		<Text>
			<Text color={color}>●</Text>
			<Text color={theme.textSubtle}> {call.name}</Text>
			{subagent && <Text color={theme.textSubtle} dimColor> {subagentModel(call)}</Text>}
			<Text color={theme.textSubtle} dimColor> {formatToolArguments(call.arguments)}</Text>
			{subagent && subagent !== 'unknown' && <Text color={color}> · {subagent}</Text>}
			{permission && <Text color={permission.color}> · {permission.text}</Text>}
		</Text>
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
					{calls.map(call => <ToolLine key={call.id} call={call} result={results.get(call.id)} />)}
				</Box>
			) : null}
		</Box>
	);
}

function ToolCallRow({ call, result }: { call: ToolCallBlock; result?: ToolResultBlock }) {
	const subagent = useSubagentStatus(call, result);
	const permission = usePermissionStatus(call, result);
	const color = subagent ? subagentColors[subagent] : theme.toolIndicator;
	return (
		<Box padding={1}>
			<Text color={color}>  ●</Text>
			<Text color={theme.textSubtle}> {call.name}</Text>
			{subagent && <Text color={theme.textSubtle} dimColor> {subagentModel(call)}</Text>}
			<Text color={theme.textSubtle} dimColor> {formatToolArguments(call.arguments)}</Text>
			{subagent && subagent !== 'unknown' && <Text color={color}> · {subagent}</Text>}
			{permission && <Text color={permission.color}> · {permission.text}</Text>}
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
		<Box flexDirection="column" marginBottom={1} paddingX={3} flexShrink={0}>
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
