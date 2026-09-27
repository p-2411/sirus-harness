import {
  NOTIFICATION_MODE_DESCRIPTIONS,
  notificationMode,
  parseNotificationMode,
  setNotificationMode,
} from '../../frontend/terminal/notifications';
import { NOTIFICATION_PREFERENCES, type NotificationPreference } from '../../persistence/settings';
import { terminalFocused } from '../../frontend/terminal/window-focus';
import type { Feedback } from '../feedback';
import { commandUsage, type CommandMenuItem, type CommandSpec } from '../types';

function notifyMenuItems(): CommandMenuItem[] {
  return NOTIFICATION_PREFERENCES.map(mode => ({
    type: 'item',
    key: mode,
    label: mode,
    description: NOTIFICATION_MODE_DESCRIPTIONS[mode],
    command: `/notify ${mode}`,
  }));
}

function notifyCommand(mode: NotificationPreference | undefined): Feedback {
  if (mode === undefined) {
    const current = notificationMode();
    const focusNote = current === 'background' && terminalFocused() === null
      ? ' This terminal has not reported focus; if that persists, use /notify always.'
      : '';
    return { kind: 'info', text: `Notifications are ${current}: ${NOTIFICATION_MODE_DESCRIPTIONS[current]}.${focusNote}` };
  }
  setNotificationMode(mode);
  return { kind: 'success', text: `Notifications set to ${mode}.` };
}

export const notifyCommandSpec: CommandSpec = {
  name: 'notify',
  args: '[off|background|always]',
  description: 'show or set desktop notifications',
  run: args => {
    const mode = args[0] === undefined ? undefined : parseNotificationMode(args[0]);
    if (args.length > 1 || mode === null) throw new Error(`Usage: ${commandUsage(notifyCommandSpec)}`);
    return notifyCommand(mode);
  },
  menu: args => args.length === 0 ? notifyMenuItems() : null,
};
