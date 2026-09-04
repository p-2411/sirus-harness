import {
  NOTIFICATION_MODES,
  NOTIFICATION_MODE_DESCRIPTIONS,
  notificationMode,
  parseNotificationMode,
  setNotificationMode,
} from '../../frontend/terminal/notifications';
import { terminalFocused } from '../../frontend/terminal/window-focus';
import type { Feedback } from '../feedback';
import type { CommandMenuItem } from '../types';

export function notifyMenuItems(): CommandMenuItem[] {
  return NOTIFICATION_MODES.map(mode => ({
    type: 'item',
    key: mode,
    label: mode,
    description: NOTIFICATION_MODE_DESCRIPTIONS[mode],
    command: `/notify ${mode}`,
  }));
}

export function notifyCommand(mode: string | undefined): Feedback {
  if (mode === undefined) {
    const current = notificationMode();
    const focusNote = current === 'background' && terminalFocused() === null
      ? ' This terminal has not reported focus yet; if it never does, use /notify always.'
      : '';
    return { kind: 'info', text: `Notifications are ${current}: ${NOTIFICATION_MODE_DESCRIPTIONS[current]}.${focusNote}` };
  }
  const parsed = parseNotificationMode(mode);
  if (!parsed) throw new Error('Usage: /notify [off|background|always]');
  setNotificationMode(parsed);
  return { kind: 'success', text: `Notifications set to ${parsed}: ${NOTIFICATION_MODE_DESCRIPTIONS[parsed]}.` };
}
