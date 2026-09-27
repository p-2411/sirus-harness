// Text from outside Sirus, as the terminal should be handed it: an agent's
// reply, a tool's output, a file name, a session name an agent chose. Ink
// strips cursor movement and some OSC sequences but passes the rest through,
// so a carriage return redraws over the sidebar, a bell rings on every frame
// that shows it, and an OSC 8 link shows one address while opening another.

// CSI, OSC and the string sequences (DCS, SOS, PM, APC), each with or
// without its terminator, then the two-character escapes.
const ESCAPE_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[ -/]*[0-~])/g;
// Every control character but the tab and the line break.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const HAS_CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;

// Printable text, tabs and line breaks only. A line a progress bar redrew
// with carriage returns keeps what was drawn last, as the terminal would
// have shown it. Applied where the text is printed; what is stored stays as
// the agent or the tool produced it.
export function terminalText(text: string): string {
  if (!HAS_CONTROL.test(text)) return text;
  return text
    .replace(ESCAPE_SEQUENCE, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => {
      const drawn = line.replace(/\r+$/, '');
      return drawn.slice(drawn.lastIndexOf('\r') + 1);
    })
    .join('\n')
    .replace(CONTROL, '');
}
