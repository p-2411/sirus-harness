import { Session } from '../runtime/session';
import { clearAllSessionRuntimes, clearSessionRuntime, modelStrategies } from '../agent/chat';
import { isMemoryAccessEnabled, setMemoryAccessEnabled } from '../agent/memory-access';
import { login, subscriptionDetail, type Notify } from '../agent/providers/login';
import {
  API_KEY_OWNER,
  authStatus,
  clearApiKey,
  findApiKey,
  maskApiKey,
  setApiKey,
} from '../agent/credentials';
import { isSubscriptionEnabled, parseVendor, setSubscriptionEnabled, VENDORS, type Vendor } from '../agent/subscriptions';
import {
  PERMISSION_MODE_NAMES,
  PERMISSION_MODES,
  parsePermissionMode,
  type PermissionMode,
} from '../agent/permissions';
import type { Feedback } from '../feedback';
import {
  THINKING_LEVEL_DESCRIPTIONS,
  THINKING_LEVELS,
  parseThinkingLevel,
  type ThinkingLevel,
} from '../agent/thinking';

export function changeModel(
  participantName: string = 'sirus',
  model: string,
  session: Session,
  changeSirusModel?: (model: string) => void,
): Feedback {
  if (modelStrategies[model]) {
    const normalizedParticipantName = participantName.replace(/^@/, '');
    if (normalizedParticipantName.toLocaleLowerCase() === 'sirus' && changeSirusModel) {
      changeSirusModel(model);
    } else {
      session.changeParticipantModel(participantName, model);
    }
    return {
      kind: 'success',
      text: `@${normalizedParticipantName} model changed to ${model}.`,
    };
  } else {
    throw new Error(`Unknown model. Try: ${Object.keys(modelStrategies).join(', ')}`);
  }
}

export function changeThinkingLevel(
  participantName: string = 'sirus',
  value: string,
  session: Session,
): Feedback {
  const level = parseThinkingLevel(value);
  if (!level) throw new Error(`Unknown thinking level. Try: ${THINKING_LEVELS.join(', ')}`);
  const normalizedParticipantName = participantName.replace(/^@/, '');
  session.setThinkingLevel(level, normalizedParticipantName);
  return {
    kind: 'success',
    text: `@${normalizedParticipantName} thinking level changed to ${level}.`,
  };
}

export function clearSession(session: Session): Feedback {
  for (const runtimeId of session.getParticipantRuntimeIds()) clearSessionRuntime(runtimeId);
  session.clear();
  return { kind: 'success', text: 'Session history cleared.' };
}

// One entry per way of signing in. Items with `secret` ask for a value the
// input bar must hide, then run `command` with it appended.
export interface CommandMenuItem {
  key: string;
  label: string;
  description: string;
  command: string;
  secret?: { prompt: string };
}

const VENDOR_NAMES: Record<Vendor, string> = { claude: 'Claude', gpt: 'ChatGPT' };

function modelsOf(vendor: Vendor): string {
  return `${vendor}-* models`;
}

// `/login` asks which provider first; `/login <provider>` then offers that
// provider's two ways in. Picking a provider sends `/login <provider>`, which
// opens the second step through the same path.
export function loginMenuItems(args: readonly string[] = []): CommandMenuItem[] | null {
  if (args.length > 1) return null;
  if (args.length === 0) {
    return VENDORS.map(vendor => ({
      key: vendor,
      label: VENDOR_NAMES[vendor],
      description: `${modelsOf(vendor)}`,
      command: `/login ${vendor}`,
    }));
  }
  const vendor = parseVendor(args[0]);
  return [
    {
      key: 'subscription',
      label: 'Subscription',
      description: `sign in with your ${VENDOR_NAMES[vendor]} account in the browser`,
      command: `/login ${vendor} subscription`,
    },
    {
      key: 'api',
      label: 'API key',
      description: `paste an ${API_KEY_OWNER[vendor]} API key`,
      command: `/login ${vendor} api`,
      secret: { prompt: `Paste your ${API_KEY_OWNER[vendor]} API key` },
    },
  ];
}

// In the input bar, `/login` and `/login <provider>` open the picker; these
// are the text forms the picker sends (and that can be typed directly).
export function loginCommand(
  args: readonly string[],
  notify: Notify,
  signal?: AbortSignal,
): Promise<Feedback> | Feedback {
  const choices = loginMenuItems(args);
  if (choices) {
    return {
      kind: 'info',
      text: `Choose a sign-in: ${choices.map(item => item.command).join(', ')}. /info shows the current state.`,
    };
  }
  const vendor = parseVendor(args[0]);
  if (args[1] === 'subscription' && args.length === 2) {
    return login(vendor, notify, signal).then(text => ({ kind: 'success', text }));
  }
  if (args[1] === 'api' && args.length === 3) {
    setApiKey(vendor, args[2]);
    return {
      kind: 'success',
      text: `Saved your ${API_KEY_OWNER[vendor]} API key (${maskApiKey(args[2].trim())}). ${modelsOf(vendor)} now use it.`,
    };
  }
  throw new Error(`Usage: /login ${vendor} subscription  or  /login ${vendor} api <key>`);
}

// What a provider falls back to after signing out. A key from the environment
// is a developer convenience the user never set up, so it is described as
// just "the API key" and never named.
function remainingCredentials(vendor: Vendor): string {
  const found = findApiKey(vendor);
  if (!found) return `${modelsOf(vendor)} are signed out; run /login to sign in.`;
  return found.source === 'settings'
    ? `${modelsOf(vendor)} now use your saved ${API_KEY_OWNER[vendor]} API key (${maskApiKey(found.key)}).`
    : `${modelsOf(vendor)} now use the ${API_KEY_OWNER[vendor]} API key (${maskApiKey(found.key)}).`;
}

// Signs out of whichever mechanism is currently in effect for the provider:
// the subscription if it is on, otherwise the key pasted into Sirus.
export function logoutCommand(name: string | undefined): Feedback {
  const vendor = parseVendor(name);
  if (isSubscriptionEnabled(vendor)) {
    setSubscriptionEnabled(vendor, false);
    return {
      kind: 'success',
      text: `Signed out of the ${VENDOR_NAMES[vendor]} subscription. ${remainingCredentials(vendor)}`,
    };
  }
  if (clearApiKey(vendor)) {
    return {
      kind: 'success',
      text: `Removed your saved ${API_KEY_OWNER[vendor]} API key. ${remainingCredentials(vendor)}`,
    };
  }
  return { kind: 'info', text: `Nothing to sign out of for ${vendor}.` };
}

async function describeVendor(vendor: Vendor, signal?: AbortSignal): Promise<string> {
  const status = authStatus(vendor);
  switch (status.mode) {
    case 'subscription': {
      let detail: string;
      try {
        detail = await subscriptionDetail(vendor, signal);
      } catch (error) {
        detail = `status unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
      return `${vendor}: subscription · ${detail}`;
    }
    case 'api':
      return `${vendor}: API key · ${status.masked}`;
    case 'none':
      return `${vendor}: not configured`;
  }
}

export async function infoCommand(signal?: AbortSignal): Promise<Feedback> {
  const lines = await Promise.all(VENDORS.map(vendor => describeVendor(vendor, signal)));
  return { kind: 'info', text: lines.join('\n'), showIcon: false };
}

const PERMISSION_MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  ask: 'prompt before every write, shell command, and spawned agent',
  auto: 'run ordinary work; prompt only for sensitive operations',
  bypass: 'run everything without prompting',
};

export function permissionsMenuItems(): CommandMenuItem[] {
  return PERMISSION_MODES.map(mode => ({
    key: mode,
    label: PERMISSION_MODE_NAMES[mode],
    description: PERMISSION_MODE_DESCRIPTIONS[mode],
    command: `/permissions ${mode}`,
  }));
}

export function thinkingMenuItems(args: readonly string[] = []): CommandMenuItem[] | null {
  if (args.length > 1 || (args.length === 1 && (parseThinkingLevel(args[0]) || !args[0].startsWith('@')))) {
    return null;
  }
  const participant = args[0]?.replace(/^@/, '');
  return THINKING_LEVELS.map((level: ThinkingLevel) => ({
    key: level,
    label: level,
    description: THINKING_LEVEL_DESCRIPTIONS[level],
    command: participant ? `/thinking @${participant} ${level}` : `/thinking ${level}`,
  }));
}

export function thinkingCommand(args: readonly string[], session: Session): Feedback {
  if (args.length === 0) {
    return { kind: 'info', text: `@sirus thinking level is ${session.getThinkingLevel()}.` };
  }
  if (args.length === 1) {
    const level = parseThinkingLevel(args[0]);
    if (level) return changeThinkingLevel('sirus', level, session);
    if (!args[0].startsWith('@')) {
      throw new Error(`Unknown thinking level. Try: ${THINKING_LEVELS.join(', ')}`);
    }
    return {
      kind: 'info',
      text: `@${args[0].replace(/^@/, '')} thinking level is ${session.getThinkingLevel(args[0])}.`,
    };
  }
  if (args.length === 2) return changeThinkingLevel(args[0], args[1], session);
  throw new Error('Usage: /thinking [participant] [low|medium|high|xhigh|max]');
}

// `/permissions` alone opens the picker; `/permissions <mode>` sets it.
export function permissionsCommand(mode: string | undefined, session: Session): Feedback {
  if (mode === undefined) {
    return {
      kind: 'info',
      text: `Permission mode is ${PERMISSION_MODE_NAMES[session.getPermissionMode()]}.`,
    };
  }
  const parsed = parsePermissionMode(mode);
  if (!parsed) throw new Error('Usage: /permissions [ask|auto|bypass]');
  session.setPermissionMode(parsed);
  return {
    kind: 'success',
    text: `Permission mode set to ${PERMISSION_MODE_NAMES[parsed]}.`,
  };
}

export function memoryCommand(mode: string | undefined): Feedback {
  if (mode === undefined) {
    return {
      kind: 'info',
      text: `Memory access is ${isMemoryAccessEnabled() ? 'on' : 'off'}.`,
    };
  }
  if (mode !== 'on' && mode !== 'off') {
    throw new Error('Usage: /memory [on|off]');
  }

  const enabled = mode === 'on';
  const changed = isMemoryAccessEnabled() !== enabled;
  setMemoryAccessEnabled(enabled);
  if (changed) clearAllSessionRuntimes();
  return {
    kind: 'success',
    text: `Memory access ${enabled ? 'enabled' : 'disabled'}. Stored memories were not changed.`,
  };
}
