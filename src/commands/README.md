# Commands

A command lives in a folder named for what it acts on, and that folder holds a single
`commands.ts` containing both the `CommandSpec` and the behaviour behind it. A folder gains a
second file, `behavior.ts`, only when something outside the folder imports the behaviour
directly — the frontend, another command, or a test that exercises the behaviour rather than
the spec. `agents/`, `authentication/` and `checkpoints/` are split for that reason. `help/`,
`images/`, `jev/`, `memory/`, `notifications/`, `session/` and `update/` are each one file.
Commands see the conversation through `CommandSession` in `types.ts`, a structural interface
of the methods they actually call, and reach anything beyond it — attaching an image,
quitting the app — through an opt-in capability the caller may not supply. Every spec is
listed in `registry.ts`, whose order is what the user sees in the `/` menu and in `/help`.
A spec that declares no `args` takes none: `executeCommand` turns any away with the usage
line `commandUsage` writes. `registry.ts` also decides, in `isSirusCommand`, which `/` lines
are Sirus's to run and which go to the agent as one of the vendor's own commands.
