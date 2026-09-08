import path from 'path';
import type { ToolCallBlock } from '../types';
import { classifySimpleCommand, splitShellCommand } from './classify';
import type { Requester } from './approvals';

// What the approval prompt says: who is asking, what they want to do, and
// why it stopped for a decision.

const DETAIL_LINES = 6;

export function describeRequester(requester: Requester): string {
  return 'participant' in requester ? `@${requester.participant}` : `subagent ${requester.subagent}`;
}

export function previewLines(text: string, prefix: string = ''): string[] {
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
      return [target, ...previewLines(String(args.content ?? ''), '  + ')];
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

export function sensitiveReason(call: ToolCallBlock, directory: string): string {
  if (call.name === 'WriteFile' || call.name === 'EditFile') return 'sensitive: outside the session directory';
  if (call.name === 'RunShell') {
    const culprit = splitShellCommand(String(call.arguments.command ?? ''))
      ?.find(simple => classifySimpleCommand(simple, directory) === 'sensitive');
    return culprit && culprit.words.length > 0 ? `sensitive: ${culprit.words.slice(0, 2).join(' ')}` : 'sensitive';
  }
  return 'sensitive';
}
