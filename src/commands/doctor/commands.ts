import { formatDoctor, runDoctor } from '../../doctor';
import type { CommandSpec } from '../types';

export const doctorCommandSpec: CommandSpec = {
  name: 'doctor',
  description: 'check runtimes, login, storage and git',
  run: (args, context) => {
    if (args.length > 0) throw new Error('Usage: /doctor');
    context.notify('Checking runtimes and logins…');
    return runDoctor(context.session.getDirectory(), context.signal).then(checks => ({
      kind: checks.some(check => check.status !== 'ok') ? 'warning' : 'info',
      text: formatDoctor(checks), showIcon: false, panel: true,
    }));
  },
};
