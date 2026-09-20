import React from "react";
import App from "./app";
import { render } from "ink";
import { installFrameCapture } from "./terminal/screen";
import { disposeAllRuntimes } from "../agent_runtime/runtime/runtime";
import { stopSirusMcpServer } from "../agent_runtime/tools/server";
import { closeAllMemoryStores } from "../memory/store";
import { enableCheckpoints } from "../checkpoints";

// Frame capture must see Ink's writes, so it wraps stdout before anything else.
installFrameCapture();
// Interactive sessions snapshot their directory before each turn so /undo
// and /rewind can put it back.
enableCheckpoints();
// The app is a fixed full-screen frame, so the alternate screen costs nothing
// and gives the user their previous terminal contents back on exit.
// The kitty keyboard protocol, where the terminal supports it, reports cmd and
// other modifiers that legacy encodings cannot; plain typing is unaffected.
const app = render(
  <App launchDirectory={process.cwd()} />,
  { alternateScreen: true, kittyKeyboard: { mode: 'auto' } },
);

// Agent processes outlive individual turns. Tear them down when Ink exits,
// with the tool server they talk to, so their handles cannot leave the CLI
// waiting for another Ctrl+C.
const shutdown = () => {
  disposeAllRuntimes();
  stopSirusMcpServer();
  closeAllMemoryStores();
};
void app.waitUntilExit().then(shutdown, shutdown);
