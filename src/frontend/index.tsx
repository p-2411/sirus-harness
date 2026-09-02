import React from "react";
import App from "./app";
import { render } from "ink";
import { installOverlay } from "./pixel";
import { installFrameCapture } from "./screen";

// Frame capture must see Ink's writes, so it wraps stdout before anything else.
installFrameCapture();
installOverlay();
// The app is a fixed full-screen frame, so the alternate screen costs nothing
// and gives the user their previous terminal contents back on exit.
// The kitty keyboard protocol, where the terminal supports it, reports cmd and
// other modifiers that legacy encodings cannot; plain typing is unaffected.
render(<App launchDirectory={process.cwd()} />, { alternateScreen: true, kittyKeyboard: { mode: 'auto' } });
