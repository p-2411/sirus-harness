# Audit: providers / model integration

Files: `src/agent_runtime/providers/{provider,providers,credentials,login,profiles,usage,subscription}.ts`,
`anthropic/{index,api,claude-subscription}.ts`, `openai/{index,api,codex-subscription,codex-rpc}.ts`,
`codex-models.json`, `chat.ts` (contract), `turn.ts`, `prompt.ts`.

## Concepts and duplicates

- `Vendor` union `provider.ts:18-25`; `RequestSource` `:30` (also the persisted preference);
  `Transport` `:33-39`; `ApiKey`/`maskApiKey` duplicated byte-for-byte in `credentials.ts`
  (**dead file, zero importers**); `AuthStatus` consumed only by tests; `Provider extends
  ModelStrategy` `:61-81`; `ProviderSource` with a synthetic env source spliced at read
  `:144-147`; model→strategy literal `providers.ts:22-31`; context windows `:36-46` with a
  `gpt-6-astra` special case; `modelsFor`/`contextWindowFor` reverse-lookup strategy→vendor by
  object identity; profiles `profiles.ts:6-19`; login `login.ts` (vendor ternary `:208-209`);
  usage `usage.ts` (vendor if/else `:114-119`); Codex model facts also in `codex-models.json`.
- Two sources of truth for "active source": `settings.subscriptions[vendor]` boolean and
  `settings.providerSources[vendor]` list. The boolean is only a group tie-break (`:247`) yet
  is written on every mutation (`:194,:209,:218,:228`).
- `setSource('subscription')` synthesises `{id:'default'}` (`:203-206`); used only by tests.
- `ProviderOptions.subscription` (`:94`) is never reached (both vendors supply
  `subscriptionFor`); survives only in reset loops (`:301,307`). The profile-less
  `subscriptionTransport` aggregates (`claude-subscription.ts:643-647`,
  `codex-subscription.ts:607-611`) are test-only.

## Public surface and callers

`modelStrategies` → `chat.ts`, `session.ts:275,643,728`, `agent.ts:92`, `tools/subagents.ts:108`,
`tools/agents/tools.ts:24`, `permissions/judge.ts:21`, `commands/agents/behavior.ts:46`,
`frontend/app.tsx:43`, `frontend/chat/ParticipantMenu.tsx:24`. `resolveStrategy` → `chat.ts:39`.
`contextWindowFor` → `session.ts:516`. `providerFor` → `login.ts`, `commands/authentication/behavior.ts`,
`commands/agents/behavior.ts:78`, `frontend/SubscriptionLimits.tsx:25`. `modelsFor` →
`agents/behavior.ts:82`. `resetAllRuntimes` → `commands/memory/behavior.ts:19`.
`maskApiKey`, `ProviderSource` → `authentication/behavior.ts:1`. `subscribeProviderChanges` →
`SubscriptionLimits.tsx:4`. `login`, `subscriptionDetail`, `Notify` → `authentication/behavior.ts`
(`Notify` also `commands/update/behavior.ts:1`). `usage.ts` exports → `authentication/behavior.ts`,
`SubscriptionLimits.tsx`. `shutdownCodexRuntime` → `frontend/index.tsx:24`.
Provider members with no production consumer: `authStatus`, `setSource`, `requireApiKey`.
Tests reach into: `anthropic/api.ts` (`toAnthropicMessages`, `anthropicUsage`,
`anthropicThinkingConfig`), `openai/api.ts` (`toOpenAIInput`, `toOpenAIContinuationInput`,
`openAIUsage`), `codex-subscription.ts` (`codexTurnUsage`, `codexTurnInput`,
`subscriptionTransport`, `codexSubscriptionTransport`), `claude-subscription.ts`
(`createClaudeSubscriptionUsageReader`, `readClaudeSubscriptionUsage`), `codex-rpc.ts`,
`profiles.ts`, `subscription.ts`, `createProvider`/`Transport` (`provider_fallback.test.ts:5`).

## Problems

- `Provider extends ModelStrategy` fuses model dispatch, credentials, auth UI and fallback.
  Model identity is discarded at resolution; `judgeModel` on the strategy works only because
  model→vendor is one-to-one by accident.
- `getResponse` fallback loop `provider.ts:239-297`: 59 lines, seven jobs. Rewrites history
  with an English instruction (`:269`) and a second, different one for subscriptions (`:286`);
  mutates the turn from inside the router (`turn.updateStream([])` `:282`, `turn.commit` `:284`);
  the unresolved-tool guard `:281` is buried in a catch.
- Module globals: `listeners` `:100` shared by every provider; `current` is a single slot
  (`:132`) so `currentSource()` reports whichever agent last started a turn; `transports`
  never pruned; `removeSource` constructs then disposes a transport and leaves it cached.
- Adding `gpt-6-astra` needed four edits: `providers.ts:26`, `:42`, `codex-subscription.ts:83-87`,
  `codex-models.json`.
- `Response.continueWithToolResults` honoured only by API transports (`anthropic/api.ts:341-358`,
  `openai/api.ts:269-276`). Subscription transports always return `end_turn` and run host tools
  themselves (`claude-subscription.ts:196-228` via in-process MCP; `codex-subscription.ts:318-348`
  via RPC), calling `runTool` directly. `chat.ts:43-68` is dead for them. Import cycle:
  `chat.ts → providers.ts → anthropic/index → claude-subscription → tools.ts → tools/agents/tools → chat.ts`.
- Thinking level read independently by four transports; only Claude subscription bakes it at
  session creation (`claude-subscription.ts:371,405-407,554-558`), so `Session.setThinkingLevel`
  resets unconditionally (`session.ts:596-598`).
- `agent.resetRuntime()` resolves through the **current** model's vendor (`agent.ts:91-93`);
  `changeParticipantModel` does not reset, so switching claude→gpt orphans a live Claude Code
  child until `resetAllRuntimes`.
- `storedSources()` legacy reconstruction runs on every call, re-reading `settings.json`
  several times per fallback iteration (`:133-141,245,290`).
- `transportFor` cache key embeds the raw API key (`:175`).
- Vendor `if/else` at `usage.ts:114-119`, `login.ts:208-221`, `profiles.ts:9-11`,
  `commands/authentication/behavior.ts:15`, `SubscriptionLimits.tsx:30,39`.

## Behaviours to preserve (test)

1. Candidate order: preference group first, then the runtime's previously successful source
   pinned to front (`tests/agent/provider_fallback.test.ts:62-72`).
2. Fallback crosses kinds, newest-first (`provider_fallback.test.ts:74-80`).
3. Stickiness per `runtimeId`; concurrent runtimes independent (`:103-115`).
4. Never fall back after abort (`:93-101`).
5. Never replay a delegated tool call with unknown outcome; rethrow (`:163-172`).
6. Completed delegated tool work is committed and carried into the retry; failed draft text
   dropped (`:146-161`) — needs `turn.commit` from the fallback path.
7. Failed API continuation retries on another source with tool results in history (`:129-144`).
8. Exhaustion raises one error naming the count, keys masked (`:82-91`).
9. `maskApiKey` prefix + last 4, nothing for short keys (`tests/agent/providers.test.ts:256-262`).
10. Env key is a real fallback source; stored keys win; removing stored restores env
    (`providers.test.ts:216-235,248-255`).
11. Pasting a key switches the vendor off its subscription (`providers.test.ts:236-241`).
12. Empty key rejected (`:243-247`).
13. Missing credentials fail before any request with a `/login` hint (`:216-221,287-298`).
14. Legacy migration: `apiKeys` + `subscriptions` boolean reconstruct a source list; once
    `providerSources` is written the legacy key is deleted and never resurrects; unrelated
    settings survive; file stays 0600 (`provider_fallback.test.ts:47-60`, `:117-127`).
15. Repeated subscription login adds a profile (`login.ts:15-17`; `provider_fallback.test.ts:201-211`).
16. Profile envs isolated, scrub inherited API creds, reject traversal (`:174-185`).
17. One Codex app-server per profile; `cli_auth_credentials_store: 'file'` for non-default;
    all closed on shutdown (`:187-199`).
18. Claude allowance read from the profile's `CLAUDE_CONFIG_DIR` (`:213-222`).
19. Claude usage read reuses an active query, never submits a prompt (`tests/agent/claude_usage.test.ts`).
20. Limit cache persisted per `(vendor,profile,period)`, kept on failed refresh, expired past
    window, cleared on removal and re-login (`tests/commands/usage.test.ts:82-108`).
21. Sidebar shows only the active subscription, seeds from cache, follows fallback live, clears
    when API becomes the source (`tests/frontend/subscription_limits.test.tsx:25-120`) — asserts
    the row switches while a fallback request is in flight.
22. Codex shutdown idempotent (`providers.test.ts:313-338`).
23. Judge = cheapest model of the same vendor, tool-less, own runtimeId (no test).
24. `gpt-6-astra` 1.05M window; provider-reported window wins; large budgets thread-local; model
    switch starts a fresh thread (`tests/agent/astra_context.test.ts:26-98`).
25. Codex catalog disables shell/apply_patch/code-mode (`astra_context.test.ts:15-24`).
26. Tool-enabled Codex threads: `sandbox: 'danger-full-access'`, MCP servers disabled
    (`providers.test.ts:340-378`).
27. Shared-history replay labels participants, omits own remembered response, honours
    `turnPrompt` (`tests/agent/subscriptions.test.ts`).
28. Thinking level → adaptive vs legacy budget, same on API and subscription (`providers.test.ts:47-60`).
29. Usage accounting per vendor (`providers.test.ts:131-161`).
30. Allowance normalisation (`tests/agent/usage.test.ts`).
31. `/logout` lists removable sources, hides env keys, disambiguates
    (`tests/commands/command_register.test.ts:364-376,405-434`).

## Migration hazards

- Keep `subscriptions` and `apiKeys` as optional fields in the settings schema; removing them
  makes existing files fail the parse and silently reset every setting.
- Both continuation-rewrite strings are frozen text.
- Tests reaching into transport factories (`provider_fallback.test.ts:42-45`,
  `astra_context.test.ts:7`, `providers.test.ts:342`, `subscription_limits.test.tsx:78,80`)
  must be repointed in the same commit as any factory change.
- `providers.test.ts:300-305`, `astra_context.test.ts:41` call `shutdownCodexRuntime()` in
  `beforeEach`; the registry must expose an equivalent (`disposeAll`).
