import React from "react";
import type { CliOptions } from "../cli";
import App from "./app";
import { render } from "ink";
import { installFrameCapture } from "./terminal/screen";
import { disposeAllRuntimes } from "../agent_runtime/runtime/runtime";
import { stopSirusMcpServer } from "../agent_runtime/tools/server";
import { closeAllMemoryStores } from "../memory/store";
import { enableCheckpoints } from "../checkpoints";
import { sendHeartbeat } from "../telemetry";

export function startFrontend(options: CliOptions): void {
  // A heartbeat, carrying a random installation id and the version, goes to
  // the Sirus stats endpoint at most once a day and never blocks startup. It
  // is on by default: SIRUS_HEARTBEAT_URL points it elsewhere, and an empty
  // value turns it off. Shutting down abandons one still in flight.
  const lifetime = new AbortController();
  void sendHeartbeat({ signal: lifetime.signal }).catch(() => undefined);

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
    <App launchDirectory={options.directory ?? process.cwd()} startup={options} />,
    {
      alternateScreen: true,
      kittyKeyboard: { mode: 'auto' },
      // The input bar handles decoded Ctrl+C for both legacy and Kitty input. Ink's
      // built-in handler only exits on the legacy byte and swallows Kitty Ctrl+C.
      exitOnCtrlC: false,
    },
  );

  // Agent processes outlive individual turns. Tear them down when Ink exits,
  // with the tool server they talk to, so their handles cannot leave the CLI
  // waiting for another Ctrl+C.
  const shutdown = () => {
    lifetime.abort();
    disposeAllRuntimes();
    stopSirusMcpServer();
    closeAllMemoryStores();
  };
  void app.waitUntilExit().then(shutdown, shutdown);
}
