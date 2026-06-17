# Spike: Converge inbound routing onto the MCP tool loop (U21)

**Type:** spike / decision memo (no committed migration)
**Date:** 2026-06-17
**Origin:** `docs/plans/2026-06-17-001-feat-cara-launch-readiness-hardening-plan.md` → U21
**Status:** recommendation ready; rollout flag defaults OFF

> This is the spike output U21 called for: a measured go/no-go, not a migration of all flows. It documents the current dual architecture, what convergence would entail, the shadow-comparison method to gather real data, the risks, and a recommendation.

---

## The dual architecture today

Cara has **two** request-handling shapes that coexist:

1. **The guard cascade** — `functions/src/linq/webhooks.ts` `handleInboundInner` is ~2,000 lines of order-dependent `if (session.x) { … return }` blocks (opt-out → crisis → NOTIFY → pending-approval → state machines → intent classify → …). Order is load-bearing and pinned by `handleInbound.routing.test.ts`. The LLM classifies intent, then a hand-ordered switchboard dispatches to imperative handlers (`routeClient`, `routeCaregiver`, `routeIntent`).

2. **The MCP tool loop** — `runQaAgent` (`functions/src/agents/qaAgent.ts`) with ~88 tools. This is the agent-native design: the model decides which tools to call to achieve an outcome.

**Key finding:** general Q&A *already* runs through `runQaAgent`. The cascade's remaining job is (a) safety/protocol fast-paths (crisis, STOP, NOTIFY, OTP) and (b) **stateful multi-step flows** (cancel, swap, refund, timesheet approval, onboarding, job posting). So "convergence" is really *"can the stateful flows move from bespoke state machines into tools the agent composes?"* — not "route Q&A to the loop" (already done).

---

## What convergence would (and would not) mean

**Would NOT move into the loop (keep as fast-paths):**
- Crisis detection + NOTIFY escalation — life-safety, speed-critical, must not depend on a tool-loop decision (CLAUDE.md).
- STOP/START opt-out — carrier protocol.
- OTP / phone verification — security.
- The per-phone lock (U4), dedup (U8), and confirmation gate (U12) — infrastructure the loop runs *inside*, not flows to migrate.

**Could move into the loop (the actual candidates):** the stateful flows. Each is today a `session.xStep` machine + handler. In the loop they become tools (`cancel_shift`, `request_swap`, …) the agent calls, with the **pending-action gate (U12)** providing the confirmation the state machine currently hand-rolls.

---

## Why not a big-bang (and why a flag)

The cascade order *is* the product behavior, pinned by characterization tests. Moving a flow into the loop changes: how confirmation is gathered, how mid-flow questions are handled, how errors surface, and latency (a state-machine step is one cheap LLM parse; a loop turn is up to 5 Sonnet calls). A wrong move regresses paid/regulated flows (Stripe/Checkr). So convergence must be **measured per-flow**, behind a flag, with a shadow comparison — never flipped wholesale.

---

## Shadow-comparison design (the measurement)

To decide go/no-go for a single flow with real data, without risking users:

1. **Flag:** `ROUTING_CONVERGENCE_SHADOW` (env), default OFF. When on, for the chosen flow's inbound messages, run the EXISTING handler for real (user-facing) AND, in parallel and **non-user-facing**, run `runQaAgent` with the flow's tools available.
2. **Capture** both outcomes to a `routing_shadow` Firestore collection: resolution (did each path reach the same end state?), latency, tool/iteration count, voice-lint flags (reuse the U20 turn metrics), and any divergence.
3. **Compare** over ~1–2 weeks of the flow's traffic: agreement rate, latency delta, lint delta, and qualitative divergence review.
4. **Decide:** widen (move the flow to the loop, flag flips to "live"), iterate (fix the prompt/tools), or hold (keep the state machine).

Pick the **lowest-risk, highest-volume, reversible** flow first. Recommendation: **reminder management** (already LLM-classified post-U10, fully reversible, no money/clinical data) as the pilot — NOT cancel/swap/refund (irreversible or financial) and NOT onboarding (Stripe/Checkr side effects).

---

## Risks

- **Latency regression:** loop turns are multi-call. Mitigation: the shadow run measures it before any flip; U14 (tool caching) narrows the gap.
- **Confirmation drift:** the loop's gate (U12) and the state machine confirm differently. Mitigation: shadow compares end states; only flip when they agree.
- **Characterization-test churn:** moving a flow rewrites its routing test. Mitigation: per-flow, one at a time, tests updated with the move.
- **Scope creep:** the spike must stay a spike. Mitigation: shadow is non-user-facing and flag-gated; no flow flips without the comparison data.

---

## Recommendation

**Go — but narrowly and measured.** Convergence is the right long-term direction (the cascade's stale-flag collisions and hand-maintained TTLs are real debt), but it is **post-launch** work and must proceed one reversible flow at a time behind the shadow flag. Q&A is already converged; do not touch the safety fast-paths. 

**Concrete next step (one PR, post-launch):** implement the `ROUTING_CONVERGENCE_SHADOW` flag + `routing_shadow` capture for the **reminder-management** flow only, gather 1–2 weeks of agreement/latency data, then bring the comparison back for a flip/hold decision. Flag stays OFF until that data exists.

**Do not** schedule the broader migration until the pilot flow's shadow data shows parity. This memo is the gate; the data is the trigger.
