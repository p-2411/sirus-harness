import {
  NOTIFICATION_MODES,
  NOTIFICATION_MODE_DESCRIPTIONS,
  notificationMode,
  parseNotificationMode,
  setNotificationMode,
} from '../../frontend/terminal/notifications';
import { terminalFocused } from '../../frontend/terminal/window-focus';
import type { Feedback } from '../feedback';
import type { CommandMenuItem, CommandSpec } from '../types';

function notifyMenuItems(): CommandMenuItem[] {
  return NOTIFICATION_MODES.map(mode => ({
    type: 'item',
    key: mode,
    label: mode,
    description: NOTIFICATION_MODE_DESCRIPTIONS[mode],
    command: `/notify ${mode}`,
  }));
}

function notifyCommand(mode: string | undefined): Feedback {
  if (mode === undefined) {
    const current = notificationMode();
    const focusNote = current === 'background' && terminalFocused() === null
      ? ' This terminal has not reported focus; if that persists, use /notify always.'
      : '';
    return { kind: 'info', text: `Notifications are ${current}: ${NOTIFICATION_MODE_DESCRIPTIONS[current]}.${focusNote}` };
  }
  const parsed = parseNotificationMode(mode);
  if (!parsed) throw new Error('Usage: /notify [off|background|always]');
  setNotificationMode(parsed);
  return { kind: 'success', text: `Notifications set to ${parsed}.` };
}

export const notifyCommandSpec: CommandSpec = {
  name: 'notify',
  args: '[off|background|always]',
  description: 'show or set desktop notifications',
  run: args => {
    if (args.length > 1) throw new Error('Usage: /notify [off|background|always]');
    return notifyCommand(args[0]);
  },
  menu: args => args.length === 0 ? notifyMenuItems() : null,
};
