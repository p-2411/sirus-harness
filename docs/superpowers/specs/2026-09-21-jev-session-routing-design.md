# Jev picks a new session's model

Status: approved 2026-09-21. Scope: sub-project 1 of the Jev work. Sub-project 2
(subagent parity and Jev routing the default subagent) follows in its own spec.

## Goal

A new session no longer starts on a preselected model. The first prompt goes to
Jev, TypeSafe AI's System One model, which picks the model best suited to the
task from the latest model of each connected vendor. The user's own choice, the
saved default and the current fallback all keep working underneath.

## Decisions

1. **Candidates are the latest model of each vendor that can still run.** The
   catalog marks one model per vendor as `latest` (`claude-fable-5-1`,
   `gpt-6-astra`) and carries a `strengths` description for it. A vendor is a
   candidate when it has a credential and that credential has allowance: an
   API key always does; a subscription does when the cached figure the sidebar
   refreshes every minute (the vendor's own window, 5-hour for Claude, 7-day
   for Codex) is above 0%. No cached figure yet counts as available, so a fresh
   launch never waits on a live read. One candidate is used without asking Jev;
   none leaves the fallback.
2. **Jev is told what the user asked, not who they are.** State: the prompt's
   text, the names of the files it mentions, the working directory's basename.
   One `choice` question, the candidates' strengths as the criteria.
   Descriptions are researched, kept in the catalog, and are the owner's to
   correct.
3. **The user's pick wins.** A draft starts on today's model (the saved
   `/model` default, else `gpt-5.6-luna`) with routing pending. `/model` on
   the draft's default participant clears it, for that session; the saved
   default is untouched.
4. **Anything short of a confident pick keeps the current model.** No
   `JEV_API` key, a timeout (2 s, no retries), an error, or confidence under
   0.5 leaves the draft on its starting model, silently. The turn is never
   blocked on Jev beyond the timeout.
5. **Nothing new is shown.** The status row's model label is the only sign of
   the pick, as it is for any model.

## Shape

- `providers/catalog.ts`: `ModelInfo` gains `latest?: true` and `strengths?:
  string`; `latestModelOf(vendor)`.
- `agent_runtime/router.ts`: `routeSessionModel(prompt, candidates, signal)`
  through `@typesafe-ai/sdk` 0.6.0 with `apiKey: process.env.JEV_API`;
  `routingCandidates()` from the providers and the allowance cache. Returns the
  chosen model and confidence, or null.
- `session/index.ts`: `routePending` on `SessionOptions`, set by the draft in
  `frontend/app.tsx`; cleared by `changeParticipantModel` on the default
  participant; on the first prompt with it set, the router is awaited and a
  pick is applied to the default participant before any runtime starts. Not
  persisted.

## Verification

Typecheck and the suite; a real Jev call from a scratch script with the
owner's key on a few prompts; the app started on a draft with both vendors
connected.
