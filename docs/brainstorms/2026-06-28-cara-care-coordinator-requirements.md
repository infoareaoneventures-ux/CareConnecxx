---
title: Cara — Human Care Coordinator Readiness
type: requirements
date: 2026-06-28
status: draft
---

# Cara — Human Care Coordinator Readiness

## Problem

Cara is far more built than "a chatbot that needs building." She has a strong agentic QA
loop (Claude Sonnet 4.6, 88 MCP tools, supervision + voice linter, dual-layer memory,
emotional-context engine, family groups, action ledgers). The complaint — *she forgets /
re-asks, and she sounds robotic* — is real, but the cause is not "she isn't built." The
cause is that **Cara is two systems**:

1. **The agentic path** (`functions/src/agents/qaAgent.ts`) — conversational, supervised,
   memory-aware, voice-linted. This is the "great care coordinator" experience and it
   largely works.
2. **The legacy scripted paths** — the onboarding state machine
   (`functions/src/agents/onboardingConversation.ts`) and the direct route handlers
   (`functions/src/linq/routeIntent.ts`, `routeClient.ts`, `routeCaregiver.ts`,
   `runQuickReply`). These bypass the memory and voice layers. **Every symptom the user
   reports lives here.**

The fixes are already correctly diagnosed in
`docs/plans/2026-06-27-001-feat-cara-10-10-human-agent-plan.md` (the "10/10 human agent"
plan) — but that plan is written, not shipped. This document scopes the user-facing
behavior we want, confirms what already exists, and adds the one ask not fully covered by
that plan: **memory must start the moment a user gives name + number.**

## Premise corrections (confirmed against code)

| User belief | Reality | Action |
|---|---|---|
| "Phone should already be in our code" (pre-seeded list) | No allowlist exists. Account is created the moment a person texts in; the session is pre-registered on first inbound. | **Keep current model** (user confirmed). No allowlist work. |
| "Build onboarding for both clients and caregivers" | Already exists — `buildClientSteps` + `buildCaregiverSteps`, branched at `ask_role`. | No new flow; fix *quality* of the existing flow. |
| "She should know if onboarded or not" | Already exists — `classifyCompleteness()` → `NEW` / `PARTIAL` / `ONBOARDED`, single source of truth. | Reuse; no new mechanism. |
| "Memory should start when user gives name + number" | Zep inits on first contact; learned-facts extract per client message; **but the rich profile memory files bootstrap only at onboarding *complete*.** | **New requirement R-MEM-1 below.** |
| "Concurrency / race forgets" | Per-phone inbound lock is **shipped** (`webhooks.ts`, `sessionState.ts`). | Race is fixed; not the cause anymore. |

## Goals

- Cara feels like one person across every message — onboarding, quick replies, route
  handlers, and the main loop — never like a form or an FAQ widget.
- Cara's durable memory of a person begins at name + number and survives an interrupted
  onboarding, so she never re-asks what she was just told.
- Close the gap between the agentic path (good) and the scripted paths (robotic/forgetful)
  without rebuilding what already works.

## Non-goals

- Rebuilding the memory architecture (Zep + memory files + learned facts already work).
- A pre-seeded phone allowlist (user chose first-text-creates-account).
- Streaming responses (SMS doesn't support it; not the problem).
- Replacing the QA agent's Sonnet tool loop.

## Requirements

### Memory begins at name + number

- **R-MEM-1.** The durable per-person memory record must begin the moment Cara has a name
  and a phone number — at the `*_ask_name` step, not at onboarding completion. From that
  point, everything the user says is captured into a record Cara reads back on the next
  turn, so an interrupted onboarding resumes as "I remember you," never "who is this?"
  *Today: memory files bootstrap at `onboardingStep === "complete"`
  (`onboardingConversation.ts` ~line 2648); learned-facts already extract per message.*
- **R-MEM-2.** Resuming an abandoned onboarding must use that record, not the raw step
  cursor, to decide what is still unknown — so cursor desync can no longer cause a re-ask.
  (The self-heal code at `onboardingConversation.ts:386` is a band-aid for this; the record
  becomes the source of truth.)

### One Cara across all paths (kill the robotic feel)

- **R-VOICE-1.** Every outbound message — direct route handlers, fallbacks, quick replies,
  healthcare/state-machine handlers — must pass through the same voice layer
  (`safety/linter.ts` + `supervise()`) that the QA path already uses. *Today these paths
  send raw: e.g. `routeIntent.ts:489` and `:656` send "Let me know if you need anything"
  unlinted.* (Plan R7.)
- **R-VOICE-2.** No system prompt or direct send may frame Cara as "an AI care assistant"
  or a chatbot. *Today: `routeCaregiver.ts:404,950`, `routeClient.ts:56`,
  `credentialCollector.ts:52` still do.* (Plan R8 / KTD7.) Legal/consent AI disclosure is
  exempt.
- **R-VOICE-3.** Onboarding must feel like a person leading a conversation, not a form:
  one missing fact at a time, acknowledge what was said before asking the next thing, and
  absorb multiple volunteered fields without re-asking. *Multi-field absorption already
  exists (`onboardingConversation.ts:472`); the gap is tone + acknowledgment on the
  scripted steps.* (Plan R5.)

### Memory never lost on the fast path

- **R-CTX-1.** `runQuickReply` must not bypass memory or the supervisor for any message
  that touches a real situation (pending approvals, bookings, payments, healthcare,
  caregiver state). Trivial-greeting bypass stays only for genuinely contentless messages.
  (Plan R10.)
- **R-CTX-2.** Fresh user text and fresh tool/Firestore state must always outrank older
  memory and rolled-up summaries, so stale memory can never override a correction the user
  just made. *Priority policy exists at `qaAgent.ts:213`; enforce it on every path.*
  (Plan R2.)

### Operational reliability (the silent failure mode)

- **R-OPS-1.** Missing LLM/SMS secrets must fail loud, not silent. `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, and `LINQ_API_KEY` currently default to `""` with a console warning
  only — a partial-`.env` deploy that wipes them makes Cara go dead or dumb with no alert.
  Add a startup health check that surfaces missing secrets to an admin channel.
  *(Cross-ref the known deploy hazard: full deploy from a partial `.env` wipes live
  secrets.)*

## What a great care coordinator does — and where Cara stands

The agent-native principle: *any action a human coordinator can take, the agent can take,
and outcomes are achieved by the agent in a loop — not hardcoded in scripted branches.*
Measured against a real coordinator:

| Coordinator ability | Cara today | Gap |
|---|---|---|
| Remembers the whole situation without being re-told | Memory exists, multi-source recall | Starts too late (R-MEM-1); lost on quick path (R-CTX-1) |
| Sounds like a person, adapts to emotion | Emotional engine + voice linter on QA path | Not applied to scripted paths (R-VOICE-1/2/3) |
| Knows who she's talking to and their stage | `classifyCompleteness()` NEW/PARTIAL/ONBOARDED | ✅ solid |
| Leads, doesn't interrogate; one thing at a time | "Lead, don't ask" + one-question rules on QA path | Onboarding still form-like (R-VOICE-3) |
| Closes the loop — does what she says, confirms done | Promises-must-be-actions rule; action ledger | Enforce "never claim done before durable write" everywhere (plan R12) |
| Proactive — anticipates coverage gaps, expiring docs, refills, missed visits | Proactive caps + scheduled nudges exist | Deepen anticipation as first-class agent goals (future) |
| Escalates to humans safely | Supervisor + admin alerts + Control Room | ✅ solid |
| Continuity across the family, not just one phone | Family groups + thread mirroring | ✅ solid |

**Where Cara is genuinely lacking = the scripted paths.** Everything above that reads
"gap" traces back to behavior that lives outside the agent loop. The agent-native
direction is to route those paths through the same memory + voice + supervision spine the
QA loop already uses (and longer term, collapse the onboarding state machine into the agent
loop itself).

## Recommended approach

1. **Ship the 2026-06-27 "10/10 human agent" plan** — it already scopes R-VOICE-1/2/3,
   R-CTX-1/2, and R12 correctly. It is the bulk of the fix.
2. **Add R-MEM-1/2** (memory begins at name + number) — the user's specific ask, only
   partially covered by that plan.
3. **Add R-OPS-1** (loud secret health check) — cheap insurance against the silent-death
   deploy failure, the most likely "she just stopped working" cause in production.

This is *finish and connect*, not *rebuild*. The hard parts (agent loop, tools, memory
stores, emotional engine, voice linter, per-phone lock) are done.

## Open questions

- Is the robotic feel reported on **onboarding specifically**, on **post-onboarding quick
  replies**, or both? Determines whether R-VOICE-3 or R-CTX-1 is the higher priority.
- Has the 2026-06-27 plan been **partially** executed already? Several R-items show shipped
  infrastructure (linter, lock) but unshipped wiring — worth a quick status pass before
  planning.
- Should onboarding eventually be **collapsed into the QA agent loop** (fully agent-native)
  rather than kept as a state machine with a voice veneer? Bigger bet; out of scope here.

## Pointers

- Agentic path: `functions/src/agents/qaAgent.ts`
- Scripted paths (the problem): `functions/src/agents/onboardingConversation.ts`,
  `functions/src/linq/routeIntent.ts`, `routeClient.ts`, `routeCaregiver.ts`
- Voice layer: `functions/src/safety/linter.ts`, `functions/src/safety/supervisor.ts`
- Memory: `functions/src/memory/{zepClient,memoryFiles,learnedFacts}.ts`
- Onboarded-state classifier: `functions/src/agents/profileCompleteness.ts`
- Concurrency lock: `functions/src/utils/sessionState.ts`, `functions/src/linq/webhooks.ts`
- Prior diagnosis: `docs/plans/2026-06-27-001-feat-cara-10-10-human-agent-plan.md`,
  `docs/plans/2026-06-17-001-feat-cara-launch-readiness-hardening-plan.md`
