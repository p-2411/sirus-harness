// Silberpfeil luxury: platinum and arctic white on the dark ground, gunmetal
// hairlines, with a restrained periwinkle reserved for participant mentions.
export const theme = {
  accent: "#C8CDD5",     // platinum — wordmark, active border
  accentSoft: "#AEB5BF", // soft silver — sirus voice, prompt, spinner
  mention: "#8B93D6",    // muted periwinkle — participant mentions
  highlight: "#F2F3F5",  // arctic white — the horse, the user's voice
  text: "#DDE0E4",       // cool light grey body text
  textMuted: "#8B919B",  // titanium — secondary labels
  textSubtle: "#5C616B", // graphite — hints and placeholders
  border: "#33373E",     // gunmetal hairline
  pending: "#E3B341",    // amber — a spawned subagent still at work
  success: "#00C853",    // traffic-signal green — the one green: tool activity, copied
  toolIndicator: "#00C853", // same green as success, kept as a named role
  danger: "#BF6A6A",     // restrained signal red
  selectionBg: "#3A4048", // slate — highlighted text under a drag-selection
  selectionFg: "#F2F3F5", // arctic white on the slate
} as const;
