import crypto from 'crypto';
import { spawn } from 'child_process';
import { loadNotificationPreference, saveNotificationPreference } from '../../persistence';
import { osc } from './osc';
import { writeOverlay } from './screen';
import { terminalFocused } from './window-focus';

// Desktop notifications for things that finish while the user is looking
// elsewhere. The terminal shows them where it can (iTerm2, kitty, WezTerm,
// Ghostty, VTE terminals each have an escape sequence for it, and the
// sequence also works over SSH); otherwise the platform's notifier runs.
// A bell goes with every notification, for terminals that badge or bounce.

export type NotificationMode = 'off' | 'background' | 'always';

export const NOTIFICATION_MODES: readonly NotificationMode[] = ['off', 'background', 'always'];

export const NOTIFICATION_MODE_DESCRIPTIONS: Record<NotificationMode, string> = {
  off: 'never notify',
  background: 'notify when the terminal window is not focused (default)',
  always: 'notify whether or not the terminal is focused',
};

export const DEFAULT_NOTIFICATION_MODE: NotificationMode = 'background';

export function parseNotificationMode(value: unknown): NotificationMode | null {
  return value === 'off' || value === 'background' || value === 'always' ? value : null;
}

let mode: NotificationMode | null = null;

export function notificationMode(): NotificationMode {
  mode ??= loadNotificationPreference();
  return mode;
}

export function setNotificationMode(next: NotificationMode): void {
  if (!saveNotificationPreference(next)) throw new Error('Could not save notification settings.');
  mode = next;
}

// Whether a notification would be shown right now. In background mode a
// terminal that never reports focus counts as focused, so the user is not
// pestered while looking straight at it.
export function shouldNotify(): boolean {
  switch (notificationMode()) {
    case 'off': return false;
    case 'always': return true;
    case 'background': return terminalFocused() === false;
  }
}

// Control characters would end or corrupt the sequence; a notification is
// one line of plain text.
function plain(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim();
}

// The escape sequence this terminal understands, or null when it has none
// that we know of.
export function terminalNotificationSequence(
  title: string,
  body: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const program = env.TERM_PROGRAM ?? '';
  const safeTitle = plain(title).replace(/;/g, ',');
  const safeBody = plain(body);
  if (env.KITTY_WINDOW_ID || env.TERM?.startsWith('xterm-kitty')) {
    const id = crypto.randomUUID().slice(0, 8);
    return osc(`99;i=${id}:d=0;${safeTitle}`) + osc(`99;i=${id}:p=body;${safeBody}`);
  }
  if (program === 'iTerm.app' || env.ITERM_SESSION_ID) {
    return osc(`9;${safeTitle}: ${safeBody}`);
  }
  if (program === 'WezTerm' || program === 'ghostty' || env.VTE_VERSION) {
    return osc(`777;notify;${safeTitle};${safeBody}`);
  }
  return null;
}

function nativeNotify(title: string, body: string): void {
  const command = process.platform === 'darwin'
    ? ['osascript', '-e', `display notification ${JSON.stringify(plain(body))} with title ${JSON.stringify(plain(title))}`]
    : process.platform === 'linux' ? ['notify-send', '--', plain(title), plain(body)]
    : null;
  if (!command) return;
  try {
    const child = spawn(command[0], command.slice(1), { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // no notifier on this machine; the bell still rang
  }
}

export function notify(title: string, body: string): void {
  if (!shouldNotify()) return;
  const sequence = terminalNotificationSequence(title, body);
  if (sequence) writeOverlay(sequence);
  else nativeNotify(title, body);
  writeOverlay('\x07');
}
