import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { NOTIFICATION_PREFERENCES, openSettings, type NotificationPreference } from '../../persistence/settings';
import { osc } from './osc';
import { writeOverlay } from './screen';
import { terminalFocused } from './window-focus';

// Desktop notifications for things that finish while the user is looking
// elsewhere. The terminal shows them where it can (iTerm2, kitty, WezTerm,
// Ghostty, VTE terminals each have an escape sequence for it, and the
// sequence also works over SSH); otherwise the platform's notifier runs.
// A bell goes with every notification, for terminals that badge or bounce.
//
// Terminal sequences and osascript can only show the terminal's own icon.
// On a local Mac with terminal-notifier installed, that runs first instead,
// so the notification carries the Sirus logo.

// Shipped inside src/ so the published package ("files": ["src"]) has it.
const LOGO_PATH = fileURLToPath(new URL('../../assets/sirus-icon.png', import.meta.url));

export const NOTIFICATION_MODE_DESCRIPTIONS: Record<NotificationPreference, string> = {
  off: 'never notify',
  background: 'notify when the terminal window is not focused (default)',
  always: 'notify whether or not the terminal is focused',
};

export function parseNotificationMode(value: unknown): NotificationPreference | null {
  return NOTIFICATION_PREFERENCES.includes(value as NotificationPreference) ? value as NotificationPreference : null;
}

let mode: NotificationPreference | null = null;

export function notificationMode(): NotificationPreference {
  mode ??= openSettings().get('notifications');
  return mode;
}

export function setNotificationMode(next: NotificationPreference): void {
  if (!openSettings().set({ notifications: next })) throw new Error('Could not save notification settings.');
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

function spawnDetached(command: string[]): void {
  try {
    const child = spawn(command[0], command.slice(1), { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // no notifier on this machine; the bell still rang
  }
}

let terminalNotifier: string | null | undefined;

// terminal-notifier posts from its own app, so it needs the local desktop:
// over SSH the notification would land on the remote Mac.
function logoNotifier(): string | null {
  if (process.platform !== 'darwin' || process.env.SSH_CONNECTION || process.env.SSH_TTY) return null;
  if (terminalNotifier === undefined) terminalNotifier = Bun.which('terminal-notifier');
  return terminalNotifier;
}

// terminal-notifier reads its arguments as user defaults, which parse a
// leading bracket as a property list; its README escapes it with a backslash.
function notifierText(text: string): string {
  return plain(text).replace(/^\[/, '\\[');
}

function logoNotify(notifier: string, title: string, body: string): void {
  const command = [
    notifier, '-title', notifierText(title), '-message', notifierText(body),
    '-appIcon', LOGO_PATH, '-contentImage', LOGO_PATH,
  ];
  // Clicking the notification brings back the terminal Sirus runs in.
  const terminal = process.env.__CFBundleIdentifier;
  if (terminal) command.push('-activate', terminal);
  spawnDetached(command);
}

function nativeNotify(title: string, body: string): void {
  const command = process.platform === 'darwin'
    ? ['osascript', '-e', `display notification ${JSON.stringify(plain(body))} with title ${JSON.stringify(plain(title))}`]
    : process.platform === 'linux' ? ['notify-send', '--icon', LOGO_PATH, '--', plain(title), plain(body)]
    : null;
  if (command) spawnDetached(command);
}

export function notify(title: string, body: string): void {
  if (!shouldNotify()) return;
  const notifier = logoNotifier();
  const sequence = notifier ? null : terminalNotificationSequence(title, body);
  if (notifier) logoNotify(notifier, title, body);
  else if (sequence) writeOverlay(sequence);
  else nativeNotify(title, body);
  writeOverlay('\x07');
}
