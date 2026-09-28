import {
  ASK_MODE_DESCRIPTION,
  PERMISSION_MODE_NAMES,
  parsePermissionMode,
} from '../../agent_runtime/permissions/policy';
import { PERMISSION_MODES, type PermissionMode } from '../../agent_runtime/types';
import { vendorOf, VENDOR_INFO } from '../../agent_runtime/providers/catalog';
import type { McpServerState } from '../../agent_runtime/runtime/runtime';
import type { Participant } from '../../agent_runtime/agent';
import { contextPercent, formatTokens, formatTurnUsage, type ContextUsage } from '../../agent_runtime/usage';
import { SIRUS_VERSION } from '../../version';
import { describeThinking } from '../agents/behavior';
import { maskApiKey } from '../../agent_runtime/providers/sources';
import type { Feedback } from '../feedback';
import type { CommandMenuItem, CommandSession } from '../types';

// /compact asks a participant's runtime (the selected one's unless named) to
// fold its conversation now, with whatever the user wants the summary to
// keep, as Claude Code's own /compact takes it. Codex compacts without
// instructions, so for Codex they are dropped and the user is told. Each
// runtime also compacts on its own when its window fills; that is the
// vendor's and has no switch.
export async function compactCommand(args: readonly string[], session: CommandSession, signal?: AbortSignal, selected?: string): Promise<Feedback> {
  const named = args[0]?.startsWith('@') ? args[0].slice(1) : undefined;
  const instructions = (named ? args.slice(1) : args).join(' ').trim();
  const wanted = named ?? selected;
  const participant = wanted
    ? session.getParticipants().find(candidate => candidate.name.toLocaleLowerCase() === wanted.toLocaleLowerCase())
    : session.getParticipants()[0];
  if (!participant) throw new Error(`No participant @${wanted} in this session.`);
  await session.compact(signal, participant.name, instructions);
  const ignored = instructions && vendorOf(participant.model) === 'gpt'
    ? ' Codex compacts without instructions, so yours were not used.'
    : '';
  return { kind: ignored ? 'warning' : 'success', text: `Compacted @${participant.name}'s context.${ignored}` };
}

// A participant's credential in a few words: which vendor, and the account
// or the ends of the key.
function describeCredential(session: CommandSession, participant: Participant): string {
  const vendor = vendorOf(participant.model);
  const source = session.getCredential(participant.name);
  if (!vendor) return 'none (a scripted runtime)';
  if (!source) return `none: /login to sign in to ${VENDOR_INFO[vendor].displayName}`;
  const name = VENDOR_INFO[vendor].displayName;
  return source.kind === 'api'
    ? `${name} API key ${maskApiKey(source.key)}${source.fromEnv ? ' from the environment' : ''}`
    : `${name} subscription${source.label ? ` · ${source.label}` : ''}`;
}

function describeContext(context: ContextUsage | null): string {
  if (!context) return 'not reported yet';
  const percent = contextPercent(context);
  return `${formatTokens(context.tokens)} of ${formatTokens(context.window)}${percent === null ? '' : ` (${percent}% used, ${100 - percent}% left)`}`;
}

function describeMcpCounts(servers: readonly McpServerState[] | null): string {
  if (!servers) return 'not reported yet; /mcp asks';
  const counts = new Map<string, number>();
  for (const server of servers) counts.set(server.status, (counts.get(server.status) ?? 0) + 1);
  return [...counts].map(([status, count]) => `${count} ${status}`).join(', ') || 'none';
}

// /status: the session, where it runs and how, and each participant's
// model, depth, window, spend and credential, the way Claude Code's and
// Codex's own /status describe their one session. Nothing here asks a
// runtime anything; it reads what the session already knows.
export function statusCommand(session: CommandSession, toggles: { memory: boolean; notifications: string }): Feedback {
  const subagents = session.getSubagentModel();
  const rows: [string, string][] = [
    ['session', `${session.getName()} · ${session.getId()}`],
    ['directory', session.getDirectory()],
    ['permissions', PERMISSION_MODE_NAMES[session.getPermissionMode()]],
    ['memory', toggles.memory ? 'on' : 'off'],
    ['notifications', toggles.notifications],
    ['subagents', subagents ? `run on ${subagents}` : 'run on their owner\'s model unless told otherwise'],
  ];
  const participants = session.getParticipants().map(participant => {
    const vendor = vendorOf(participant.model);
    const usage = session.getTurnUsage(participant.name);
    const levels = session.getOfferedThinkingLevels(participant.name);
    const thinking = levels?.length === 0 ? 'no thinking levels' : `thinking ${describeThinking(participant.name, session)}`;
    return [
      `@${participant.name} · ${vendor ? `${VENDOR_INFO[vendor].displayName} · ` : ''}${participant.model} · ${thinking}`,
      ...([
        ['context', describeContext(session.getContextUsage(participant.name))],
        ['tokens', usage ? formatTurnUsage(usage) : 'none reported yet'],
        ['credential', describeCredential(session, participant)],
        ['MCP servers', describeMcpCounts(session.getMcpServers(participant.name))],
      ] as [string, string][]).map(([label, value]) => `  ${label.padEnd(12)}${value}`),
    ].join('\n');
  });
  return {
    kind: 'info',
    showIcon: false,
    panel: true,
    text: [
      `Sirus ${SIRUS_VERSION}`,
      ...rows.map(([label, value]) => `${label.padEnd(14)}${value}`),
      '',
      participants.join('\n\n'),
    ].join('\n'),
  };
}

// /mcp: each participant's MCP servers and how each connection stands, as
// its vendor reports them. Both are asked with the vendor's own /mcp, run
// aside. Codex answers with its list; Claude Code answers with a count, so
// its list is read from the servers its session reported, the fork's when
// the participant's own runtime has not reported yet.
export async function mcpCommand(session: CommandSession, signal: AbortSignal, notify: (text: string) => void): Promise<Feedback> {
  const participants = session.getParticipants();
  notify(`Asking ${participants.map(participant => `@${participant.name}`).join(' and ')} for their MCP servers…`);
  const sections = await Promise.all(participants.map(async participant => {
    const vendor = vendorOf(participant.model);
    const heading = `**@${participant.name}** · ${vendor ? VENDOR_INFO[vendor].displayName : 'scripted'} · ${participant.model}`;
    try {
      const output = await session.runCommandAside(participant.name, '/mcp', signal);
      const servers = session.getMcpServers(participant.name) ?? output.mcpServers;
      const body = servers
        ? servers.map(server => `- ${server.name} · ${server.status === 'pending' ? 'connecting' : server.status}`).join('\n') || 'No MCP servers.'
        : output.text || 'No MCP servers reported.';
      return `${heading}\n\n${body}`;
    } catch (error) {
      if (signal.aborted) throw error;
      return `${heading}\n\n${error instanceof Error ? error.message : String(error)}`;
    }
  }));
  return { kind: 'info', showIcon: false, panel: true, markdown: true, text: sections.join('\n\n') };
}

export function renameSession(name: string, session: CommandSession): Feedback {
  const trimmed = name.replace(/\s+/g, ' ').trim();
  if (!trimmed) throw new Error('Usage: /rename <name>');
  session.setName(trimmed);
  return { kind: 'success', text: `Renamed to ${session.getName()}.` };
}

const PERMISSION_MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  ask: ASK_MODE_DESCRIPTION,
  auto: 'the agent\'s own reviewer decides and asks only about what it judges unsafe',
  bypass: 'nothing is asked',
};

export function permissionsMenuItems(): CommandMenuItem[] {
  return PERMISSION_MODES.map(mode => ({
    type: 'item',
    key: mode,
    label: PERMISSION_MODE_NAMES[mode],
    description: PERMISSION_MODE_DESCRIPTIONS[mode],
    command: `/permissions ${mode}`,
  }));
}

// Setting a mode says nothing: the status row shows it.
export function permissionsCommand(mode: string | undefined, session: CommandSession): Feedback | void {
  if (mode === undefined) {
    const current = session.getPermissionMode();
    return {
      kind: 'info',
      text: `Permission mode is ${PERMISSION_MODE_NAMES[current]}.${current === 'ask' ? ` ${ASK_MODE_DESCRIPTION}` : ''}`,
    };
  }
  const parsed = parsePermissionMode(mode);
  if (!parsed) throw new Error('Usage: /permissions [ask|auto|bypass]');
  session.setPermissionMode(parsed);
}
