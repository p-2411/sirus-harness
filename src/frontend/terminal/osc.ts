// Operating System Command sequences, wrapped so they survive tmux. tmux
// swallows OSC unless it arrives inside a DCS passthrough with ESCs doubled.
export function osc(payload: string): string {
  const sequence = `\x1b]${payload}\x1b\\`;
  if (process.env.TMUX) {
    return `\x1bPtmux;${sequence.replace(/\x1b/g, '\x1b\x1b')}\x1b\\`;
  }
  return sequence;
}
