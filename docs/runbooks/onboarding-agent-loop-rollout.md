# Runbook — Agent-native onboarding (conversational collapse) rollout

**Flag:** `ONBOARDING_AGENT_LOOP` (comma-separated role keys, e.g. `client` or `client,caregiver`). Default OFF.
**Plan:** `docs/plans/2026-06-28-001-feat-agent-native-onboarding-collapse-plan.md`
**Scope shipped:** CLIENT conversational field-collection only. Caregiver is deferred (its flow interleaves transactional gates mid-collection — needs the segmented design, see plan + `onboardingContract.ts`).

## What the flag does

When `ONBOARDING_AGENT_LOOP` contains `client`, an inbound from a client on a
conversational collection step (`client_ask_name|senior|needs|location|schedule`,
plain text, no media/location) runs inside the `qaAgent` loop in onboarding mode
instead of the scripted step runner. The loop:

- injects `buildOnboardingDirective` (missing-field checklist + lead-don't-interrogate
  voice rules + never-re-greet guardrail),
- is offered only `save_onboarding_field`, `complete_collection`, `complete_task`,
- persists each field to `agent_sessions/{phone}.onboardingData`,
- calls `complete_collection` when the required set is filled, which sets the cursor
  to `client_ask_start` and hands back to the deterministic machine.

Transactional gates (payment, identity, uploads), `ask_role`, and all caregiver
steps are **never** routed to the loop. Clearing the flag reverts to the scripted
runner instantly (no redeploy).

## Pre-flip gate (do NOT enable in prod until all pass)

This mirrors the unvalidated-flip lesson from `context/progress-tracker.md:69` — the
prompt dispatcher was flipped live without its eval. Do not repeat that.

1. **Real-model eval.** Run the onboarding-loop eval against a real model on messy
   human inputs (terse "My mom", front-loaded multi-field, mid-flow questions, bare
   greetings, corrections). Gate: collection-completion rate ≥ scripted baseline;
   no re-greet; no double-send; required fields always saved before handoff.
   *(Mocked-loop harness shipped — `qaAgent.onboarding.test.ts`. The REAL-model run
   against messy inputs is the remaining blocker — see "Remaining" below.)*
2. **Latency check.** Per-turn latency within agreed bound. The loop is Sonnet; the
   scripted runner used gpt-4o-mini per field (KTD-7). Collection is few-turn, but
   measure before trusting it on the signup happy path.
3. **Golden transcripts** (`functions/src/agents/goldenTranscripts.test.ts`) extended
   with onboarding cases, green.

## Rollout sequence

1. **OFF** (current). Scripted runner ships. Code present, inert.
2. **Shadow** (optional): run the loop in parallel without sending, compare against
   the scripted output on real traffic. Reuse the routing-shadow pattern
   (`ROUTING_CONVERGENCE_SHADOW`) if wired for onboarding.
3. **Canary:** `ONBOARDING_AGENT_LOOP=client` for a small cohort / short window.
   Watch the canary report below.
4. **On:** keep `client` set. Caregiver stays off pending its segmented design.

## Canary watch (run during the canary)

```
npm run canary:onboarding         # last 24h
npm run canary:onboarding 6       # last 6h
```

`onboardingCanaryWatch.ts` reads the `cara_turn_metrics` Firestore mirror for the
onboarding cohort and prints re-greet rate, P95 latency vs the 4 s ceiling, and
tool-error / exhausted / errored counts. It exits non-zero when turns exist but the
hard gates aren't clean, so it can gate a "widen the canary" step in CI. Onboarding
turns mirror to Firestore ONLY while the flag is on (`flowClass === "onboarding"`),
so there's data during the canary and zero per-turn writes when the flag is off.

## Metrics to watch (emitted via `emitTurnMetrics`, mirrored to `cara_turn_metrics`)

- **`onboardingReGreet`** — re-greet detector (`isReGreet` on the final reply). MUST
  be zero. Non-zero is a rollback trigger.
- **`flowClass="onboarding"`** + **`durationMs`** — per-turn latency; P95 ≤ 4 s
  (provisional ceiling, ratify from the eval).
- `iterations`, `toolCalls`, `toolErrors`, `exhausted`, truncations.
- Signup-completion rate (collection → first gate → payment) vs the OFF baseline.
- Double-sends: architecturally one reply per loop turn (asserted in
  `qaAgent.onboarding.test.ts`); the canary still surfaces `exhausted`/retry turns.
- Stuck collection: loop never calling `complete_collection` — caught live by the
  stuck-signup net (`webhooks.ts`), which advances the cursor to the gate.

## Rollback

Clear `ONBOARDING_AGENT_LOOP` (remove the role key). Next inbound uses the scripted
runner. No data migration — `onboardingData` shape is identical on both paths.

## Open review items (address before canary)

From the code review of this work:

- ~~**Zep structured push skipped on the loop path.**~~ FIXED — the push is now a
  shared `pushOnboardingStepToZep` helper called by both the loop and scripted
  paths (`webhooks.ts`).
- ~~**No stuck-signup net.**~~ FIXED — after the loop turn, if collection is complete
  but the cursor is still a collection step, `webhooks.ts` advances it to the gate.
- ~~**Both-flags interaction untested.**~~ FIXED — `handleInbound.routing.test.ts`
  ("onboarding agent-loop flag routing") pins the invariant: with `ONBOARDING_AGENT_LOOP=client`
  the client collection turn routes to the loop and `handleOnboardingStep` is never
  called, so the `CONVERGENCE_FLIPPED=onboarding` dispatcher can't also run and the
  cursor is never double-resolved. Covers both-flags-on, loop-throws fallback, and
  caregiver-only / flag-off negative cases.
- **Latency baseline.** Pre-flip gate 2 ("within agreed bound") is now falsifiable.
  **Provisional ceiling: P95 ≤ 4 s per collection turn.** Rationale: the scripted
  runner is gpt-4o-mini single-shot per field (~0.5–1 s observed); the loop is one
  Sonnet turn that saves the field(s) then replies — typically 2 iterations, ~1.5–2 s
  each → ~3–4 s. Above 4 s the collection happy path degrades vs the scripted baseline.
  **Measure before canary** (do NOT rely on the provisional number): tap
  `emitTurnMetrics` `flowClass="onboarding"` turns in shadow/canary, take P95 over ≥50
  turns, and ratify or revise the ceiling. The metric is already emitted (see Metrics
  below) — this is a read, not new instrumentation.
- **Mid-flow role-switch / "start over"** during collection lives in the bypassed
  `handleOnboardingStep`; confirm the loop directive handles these or routes back.

## Remaining test work (before canary)

- ~~A `runQaAgent` onboarding-mode integration harness.~~ DONE —
  `functions/src/agents/qaAgent.onboarding.test.ts` (5 tests) mocks the Claude client
  to drive tool_use → `save_onboarding_field` → `complete_collection`, asserting:
  fields saved before handoff in order; role injected into every save; tool surface
  restricted to the three onboarding tools; single user-facing reply (no double-send /
  no re-greet); and the `complete_collection` missing-fields recovery branch (loop
  feeds the result back, model saves the missing field, then completes).
- **Real-model eval (the last gate) — harness shipped, run pending.**
  `functions/src/agents/qaAgent.onboarding.eval.test.ts` drives the loop against
  the REAL model on 5 messy multi-turn cases (terse, front-loaded, mid-flow
  question, correction, bare greeting) and grades the four gates via the pure
  `onboardingEvalGraders.ts` (completion, fields-before-handoff, no re-greet, no
  double-send) plus a per-turn P95 latency report against the 4 s ceiling.

  It is SPEND-GATED: skipped unless `CARA_ONBOARDING_EVAL_LIVE=true` AND
  `ANTHROPIC_API_KEY` are set, so `npm run eval` / the normal suite never spend.
  The grader unit tests and the tool-engine fidelity test run for free in CI.

  **To run (incurs API spend — your go):**
  ```
  CARA_ONBOARDING_EVAL_LIVE=true ANTHROPIC_API_KEY=sk-... npm run eval:onboarding
  ```
  Gate: all 5 cases pass (completion, zero re-greet, no premature handoff) and P95
  ≤ 4 s (ratify or revise the ceiling from the printed number). This is the only
  remaining pre-flip blocker — deliberately NOT wired into predeploy so a deploy
  never triggers paid model runs.

  Deliberate deviation from the original "wire into `npm run eval`" note: the
  predeploy `eval` runs on every deploy, so folding a paid multi-turn model eval
  into it would bill every deploy. It's a separate opt-in script instead.

Unit coverage already in place: `onboardingContract.test.ts` (field gate, routing
predicate, tool surface), `onboardingDirective.test.ts` (voice rules, no chatbot
phrasing), and no-regression on `qaAgent.test.ts` (68) + `handleInbound.routing.test.ts` (32).
