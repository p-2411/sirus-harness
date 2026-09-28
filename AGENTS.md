# Agent instructions

## Phone app issues: trace them back to the TUI

The iPhone app (`ios/SirusRemote`) was ported from the terminal interface
(`src/frontend`), and Sirus shapes what the phone shows (`src/remote`). So a
problem found in the app is often also in the TUI, or starts in the shared
code both of them draw from.

When you're fixing an issue in the iOS app:

1. Trace it to its cause before changing Swift. Check whether the TUI does
   the same thing. Menus pushing the conversation up instead of floating over
   it was in both.
2. If the cause is in shared code (`src/remote`, the protocol, or the session
   state both interfaces read), fix it there so the fix reaches both.
3. If each interface has its own copy of the behaviour, fix both in the same
   piece of work.
4. Only fix the app alone once you've confirmed the TUI doesn't have the
   problem, and say so in your report.
