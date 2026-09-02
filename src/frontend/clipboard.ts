import { spawn } from 'child_process';
import { writeOverlay } from './screen';
import { osc } from './terminal';

// OSC 52 lets the terminal itself set the clipboard, which is the only route
// that works over SSH. Not every terminal honours it (Terminal.app ignores it,
// iTerm2 needs a preference), so a native clipboard tool runs as well.
// Setting the clipboard twice with the same text is harmless.
export function copyToClipboard(text: string) {
  writeOverlay(osc52(text));
  nativeCopy(text);
}

function osc52(text: string): string {
  return osc(`52;c;${Buffer.from(text, 'utf8').toString('base64')}`);
}

function nativeCopy(text: string) {
  const command =
    process.platform === 'darwin' ? ['pbcopy']
    : process.platform === 'win32' ? ['clip']
    : process.env.WAYLAND_DISPLAY ? ['wl-copy']
    : ['xclip', '-selection', 'clipboard'];
  try {
    const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'ignore', 'ignore'] });
    // a missing tool is expected on some systems; OSC 52 may still have worked
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(text);
  } catch {
    // spawn itself can throw synchronously for a bad command; same reasoning
  }
}
