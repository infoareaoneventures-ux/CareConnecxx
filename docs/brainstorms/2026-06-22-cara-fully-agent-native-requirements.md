---
date: 2026-06-22
topic: cara-fully-agent-native
---

# Cara — Fully Agent-Native

## Summary

Make Cara's agent loop the default driver of conversation so she can compose her existing primitive tools to handle requests no one hardcoded — gated by a money/irreversible-action boundary and a cost/latency budget that protect the reliability already shipped. Deliver in three sequenced phases: build the safety net (C), strangler-migrate flows into the loop (A), then stand up a capability manifest plus per-user accumulated knowledge as the lasting emergence layer (B).

## Problem Frame

Cara is two systems. A deterministic router and state machine (`intentClassifier` → `routeIntent`, with flags like `pendingJobId`, `awaitingJobResponse`, `pendingInterviewConfirm`) owns the high-value flows: matching, booking, interviews, job apply. A separate agent loop — the QA agent on Claude Sonnet with ~105 MCP tools — mostly answers open questions. `isTrivialQuickReply` decides whether the agent loop even runs.

The valuable flows are exactly the ones a user would most want to improvise against ("find someone who also drives Mom to dialysis Tuesdays," "reschedule all my mornings next week"). Because the state machine owns them, Cara can answer questions about those flows but cannot recompose them. The agent's intelligence is used to route, not to act — the cardinal agent-native anti-pattern.

The usual hard part of going agent-native — tool parity and granularity — is largely already done. `HIGH_STAKES_MUTATIONS` lists ~45 atomic primitives spanning bookings, interviews, jobs, shifts, money, people, care data, and reminders, with broad CRUD (`create_reminder`/`delete_reminder`, `add_family_member`/`remove_family_member`, `block_user`/`unblock_user`). The gap is not tools. It is control flow, runtime context, and a real safety gate.

## Key Decisions

- **This is a post-launch capability track, not the launch gate.** None of the six release-gating criteria in `context/project-overview.md` require Cara to be agent-native; they are reliability and correctness gates. Launch readiness is governed by those gates plus CI verification of the reliability work already done. This roadmap makes Cara more capable and cheaper to evolve — it does not make her launch-ready, and its later phases would risk launch reliability if done first.
- **Agent owns everything except money and irreversible commitment.** The agent loop drives and composes freely. Code gates remain only on charging cards, confirming bookings, payouts, account deletion/opt-out, and message relays the recipient believes were delivered.
- **Sequence C → A → B; do not pick one.** Safety net first (cheap evidence, protects the reliability sprint), then incremental migration (emergence at a controlled pace), then the manifest plus accumulated-knowledge layer (the right end state, reckless as a starting move without the eval harness).
- **Design-forward, validated by instrumentation.** No real failed-ask data exists yet. The roadmap builds the capacity to compose and instruments what users actually ask, rather than predicting specific features.
- **The hybrid LLM cost discipline is an invariant, not a target.** The gpt-4o-mini-for-short / Sonnet-for-the-loop split (per `CLAUDE.md`) exists for latency and cost. Moving traffic into the loop must respect a measured budget; rebuilding the split is out of scope.

## Requirements

### Phase 1 — Safety net (C), launch-compatible

R1. Inject per-user runtime context into the agent prompt: the user's role, appointments, job posts, match history, and care team — enough for the agent to know what exists for this person before it composes.

R2. Promote `HIGH_STAKES_MUTATIONS` from an error-reporting list into a confirm-before-execute gate, backed by the existing booking idempotency, so irreversible actions require explicit confirmation in-conversation and execute exactly once.

R3. Build a golden-transcript eval harness that scores the agent's handling of representative flows against expected outcomes, runnable in CI.

R4. Run the agent in shadow mode beside the live state machine on the hardened flows (booking, interview, payment), recording where it agrees and diverges, without taking user-facing action.

R5. Instrument and persist the asks users make of Cara so latent demand becomes observable rather than guessed.

### Phase 2 — Strangler migration (A), gated behind launch

R6. Make the agent loop the default inbound handler; retire state-machine branches one flow at a time behind feature flags, each independently reversible.

R7. Migrate flows in order of composition value: matching, job search, and rescheduling first; linear onboarding last.

R8. Block any flow cutover until the shadow harness (R3, R4) shows parity and no regression on that flow.

### Phase 3 — Emergence layer (B), gated behind launch

R9. Give the agent a self-describing manifest of available resources and capabilities in user vocabulary, refreshable within a long session.

R10. Maintain a per-user accumulated-knowledge store (a `context.md` equivalent) the agent reads and updates, seeded by the existing caregiver-reputation signal.

R11. Reduce the state machine to a thin interceptor whose only job is to catch money/irreversible calls (R2) on their way through the loop.

### Cross-cutting invariants

R12. Every migrated flow must hold the `CLAUDE.md` Cara rules: no regex/keyword intent parsing, LLM-based understanding, mid-flow question handling.

R13. Total agent-loop cost and latency must stay within a budget measured in Phase 1; a cheap-planner tier may be introduced if the budget is exceeded.

R14. The agent must signal task completion explicitly rather than via heuristic detection.

## Key Flows

F1. Agent-driven composition (target state).
- **Trigger:** inbound SMS that doesn't map to a single hardcoded intent.
- The agent loop receives the message with per-user context injected (R1).
- It composes primitives — search, filter, schedule, message — in a loop to pursue the user's outcome.
- For any irreversible step, it calls the confirm-gate (R2), which requires explicit user confirmation and executes once.
- It signals completion (R14) and replies.

F2. Flow cutover (migration mechanism).
- **Trigger:** a flow is queued for migration in Phase 2.
- The flow runs in shadow (R4) until the eval harness (R3) shows parity and no regression (R8).
- A feature flag flips the flow from state machine to agent loop.
- The flag remains reversible; regression rolls it back without redeploy.

## Success Criteria

1. The agent accomplishes at least one representative in-domain outcome that was never built as a feature, operating in a loop until done (the ultimate agent-native test).
2. Shadow mode shows no regression versus the state machine on booking, interview, and payment flows before any cutover.
3. Changing a migrated flow's behavior is achievable by editing prompts/context, not refactoring and redeploying functions.
4. Measured agent-loop cost and latency stay within the Phase 1 budget.
5. Instrumentation surfaces a ranked list of real user asks, replacing the design-forward assumption with evidence.

## Scope Boundaries

### Deferred for later
- Phases 2 and 3 in their entirety until after a live test launch produces usage data.
- A cheap-planner LLM tier — introduced only if R13's budget is exceeded.

### Outside this product's identity
- Full collapse of money orchestration into the agent (explicitly rejected: "agent owns all but money").
- Net-new tools as a goal — parity is already strong; this is a control-flow, context, and safety-gate effort.
- Rebuilding the hybrid LLM split; its cost discipline is a constraint to honor.
- Caregiver identity-model unification (phone-keyed vs uid-keyed docs) — separate tracked follow-up.

## Dependencies / Assumptions

- **Launch precedes Phases 2–3.** The six release gates and CI verification of the prior reliability work (U2–U11) clear first; this roadmap does not substitute for them.
- **Assumption (load-bearing): demand is design-forward.** No observed failed-ask data exists; R5 instrumentation is how the assumption gets tested.
- **Assumption: existing tool parity is sufficient for early composition.** Based on the `HIGH_STAKES_MUTATIONS` surface; a parity audit in Phase 1 confirms or extends it.
- The existing booking idempotency (KTD-1 / U2 / U9) is the backing for R2's exactly-once guarantee.

## Outstanding Questions

### Resolve before planning
- What is the cost/latency budget (R13), and is a cheap-planner tier in or out of Phase 1?
- Which single flow is the Phase 2 pilot, and what parity threshold (R8) authorizes its cutover?

### Deferred to planning
- The concrete shape of per-user context injection (R1) and the manifest (R9) — what fields, how refreshed.
- Where the per-user knowledge store (R10) lives and how it relates to existing reputation data.
- The eval harness's scoring model and which transcripts seed it (R3).

## Sources / Research

- `context/project-overview.md` — the six release-gating success criteria; confirms this track is not a launch gate.
- `CLAUDE.md` — hybrid LLM cost/latency rules, Cara handler rules, the two-system architecture.
- `functions/src/agents/toolCapabilities.ts:244` — `HIGH_STAKES_MUTATIONS`, the ~45-primitive surface and the seed for R2's gate.
- `functions/src/linq/routeIntent.ts`, `functions/src/utils/sessionState.ts` — the deterministic router and state-machine flags being migrated.
- `functions/src/ai/caregiverReputation.ts` — the accumulated-signal seed for R10.
- `docs/plans/2026-06-22-001-feat-cara-reliability-learning-funnel-plan.md` — the reliability/learning/funnel work this roadmap sequences after.
