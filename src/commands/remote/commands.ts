import QRCode from 'qrcode';
import { phoneConnected, remoteAddress, toggleRemote } from '../../remote';
import type { CommandSpec } from '../types';

// Modules of quiet space the QR code keeps around it.
const QUIET_ZONE = 2;

// The phone's one-time setup: a QR code the iPhone Camera opens the app
// with, already pointed at this Mac. Drawn in half blocks, two rows of
// modules to a line, light where the code is light, since the terminal's
// ground is dark and a code reads as dark marks on light.
export function connectionQr(url: string): string {
  const { modules } = QRCode.create(url, { errorCorrectionLevel: 'M' });
  const light = (row: number, column: number) => row < 0 || column < 0 || row >= modules.size || column >= modules.size
    || !modules.get(row, column);
  const lines: string[] = [];
  for (let row = -QUIET_ZONE; row < modules.size + QUIET_ZONE; row += 2) {
    let line = '';
    for (let column = -QUIET_ZONE; column < modules.size + QUIET_ZONE; column++) {
      const top = light(row, column);
      const bottom = row + 1 < modules.size + QUIET_ZONE && light(row + 1, column);
      line += top ? bottom ? '█' : '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

export const rcCommandSpec: CommandSpec = {
  name: 'rc',
  description: 'toggle remote control of this session from the Sirus iPhone app',
  run: async (_args, { session }) => {
    const text = await toggleRemote(session);
    const address = remoteAddress();
    if (!session.isRemote() || !address || phoneConnected()) return { kind: 'success', text };
    // Until a phone has connected, /rc shows where to point it.
    const url = `sirus://connect?host=${encodeURIComponent(address.host)}`;
    return {
      kind: 'info', panel: true, showIcon: false,
      text: `${text}\n\nScan with the iPhone Camera to set up the Sirus app:\n\n${connectionQr(url)}\n\n${url}`,
    };
  },
};
