# Cara → Legitimate 100% Agent-Native Score — Requirements

**Date:** 2026-06-24
**Status:** Brainstorm complete, ready for `/ce-plan`
**Scope tier:** Deep (cross-cutting, architectural)
**Source audit:** `/ce-agent-native-audit` run on 2026-06-24 — overall 61%

---

## Problem & Goal

Cara is already a genuinely agent-native assistant (a first-class actor with broad tool reach over a shared Firestore data space), but the 2026-06-24 audit scored her at **61% overall**, dragged down by:

- **CRUD Completeness — 30%**: read-rich, write-lite. Creation/deletion funneled through signup flows and SMS conversations, not agent tools.
- **Prompt-Native Features — 47%**: core conversational flows (onboarding, job posting, refunds, scheduling) are hardcoded TypeScript step machines, not prompt-driven.
- **Tools as Primitives — 59%**: ~41% of tools encode multi-step workflows + side effects rather than atomic capability.
- Plus partial scores on Context Injection (61%), Shared Workspace (61%), UI Integration (69%), Action Parity (70%).

**Goal:** Reach a *legitimate, defensible* 100% — not by forcing every measured gap to green (which would regress security and compliance), but by (1) re-baselining deliberate exclusions as documented N/A, and (2) closing every gap that is not such an exclusion.

**Approach decision (settled):** All-in architectural push — pursue all tracks together rather than phasing — with the onboarding cutover protected by shadow-mode + transcript replay.

---

## Success Criteria

The effort is done when a re-run of `/ce-agent-native-audit` yields **100% across all 8 principles**, where:

1. Every gap classified below as **Close** is implemented and verified.
2. Every item classified as **Re-baseline (N/A)** is documented in a single `AGENT_NATIVE_EXCLUSIONS.md` with rationale, and the audit treats it as out-of-denominator (not as a failure).
3. The onboarding rewrite passes transcript-replay parity (collects identical required fields, reaches identical terminal state) before any production cutover.
4. No regression: no auth-critical action becomes agent-reachable; no compliance record (invoices, shift hours, audit logs) becomes mutable/deletable by the agent; no internal-infra collection becomes user-visible.

**Quantitative cutover gate (onboarding):** shadow-flow field-collection parity ≥ agreed threshold against the replay corpus; live signup completion rate within rollback tolerance of the legacy flow.

---

## Scope

### Track A — Re-baseline (document as N/A, remove from denominator)

A single source-of-truth doc, `AGENT_NATIVE_EXCLUSIONS.md`, declaring these intentional and out-of-scope, each with a one-line rationale:

| Exclusion | Principle(s) | Rationale |
|---|---|---|
| Password change, account deletion, ban, suspend | Action Parity, CRUD | Auth/admin actions deliberately unavailable to an SMS agent (security) |
| Invoices, shift-hours, audit logs immutable | CRUD | Financial/audit integrity; create-only by design |
| `credential_vault`, `browser_sessions`, `agent_turn_checkpoints`, webhook idempotency ledgers (`processed_stripe_events`, `processed_checkr_events`), `dnd_queue`, `user_triggers`, `proactive_triggers`, `execution_agents` | Shared Workspace | Internal infrastructure; correctly never user-visible |
| `agent_audit_log` / `agent_action_ledger` admin-only | Shared Workspace | Observability isolation; users see filtered `user_activity_feed` projection |
| Crisis keyword fast-path, STOP/UNSUBSCRIBE, strict YES/NO SMS protocol, email-format regex, OTP rate limits, `isTrivialQuickReply` | Prompt-Native | CLAUDE.md-sanctioned: latency-critical safety / carrier protocol / exact-command parsing — not intent parsing |

**Requirement:** the audit re-run must read this doc and exclude listed items from scoring denominators.

### Track B — Close (build / refactor)

Grouped by principle. All pursued together (all-in).

**B1. UI Integration → 100%** (additive, low risk)
- Add a real-time caregiver-profile listener in `context/CareConnexContext.tsx` (currently stale until logout/login after Cara's ~49 write paths).
- Add `subscribeToSeniorProfile(seniorId)` in `services/api.ts` and wire into family profile/intake views.
- Add a persistent `subscribeToUser(uid)` listener for aggregated fields (verification status, ratings, badges) beyond the one-off in `IdentityCallback.tsx`.
- Acceptance: every agent write to `caregivers`, `senior_profiles`, `users` reflects in an open UI without reload.

**B2. Context Injection → 100%** (additive, low risk; touches system-prompt assembly in `functions/src/agents/qaAgent.ts`)
- Inject account-state flags: identity-verified, background-check status, subscription status, onboarding status, account status.
- Inject the user's own identity (name, email, phone, timezone) — not just the senior's name.
- Inject senior location (city/state/coords) for distance-aware reasoning.
- Preload the full care plan for clients (currently lazy-loaded via tool call).
- Add an explicit role statement ("You are texting with a [family member / caregiver]").

**B3. Capability Discovery → 100%** (UX polish)
- Capability teaser in web onboarding (`components/auth/onboarding/OnboardingFlow.tsx`) before SMS handoff.
- `/help` discoverability hint in the in-app chat surface.
- Concrete capability call-out on the landing page.
- Bilingual parity for frontend hints/placeholders (mirror the backend `caraCapabilities.ts` Spanish support into `constants/caraCapabilities.ts` and `components/AiSearchAgent.tsx`).

**B4. CRUD Completeness → 100%** (medium; new tools)
- Add missing **Create** tools: `create_senior_profile` (multi-senior households), `create_recurring_schedule` (currently only modify/pause/resume/delete).
- Add missing **Delete/lifecycle** tools where safe: `delete_care_journal_entry`, support-ticket lifecycle (`view_support_tickets`, update status, add response — currently create-only, tickets orphaned).
- Add `delete_review` (user can, agent can't), `log_match_feedback`.
- Memory-file delete/archive for "forget what you know about X".
- Everything in Track A's CRUD column stays N/A.

**B5. Action Parity → 100%** (medium; tools)
- Close the legitimate misses: support-ticket history/context, match feedback logging, proactive-draft management, direct `create_recurring_schedule`, and promoting job-post creation from sub-agent delegation to a direct tool.
- Auth/admin actions stay N/A (Track A).

**B6. Tools as Primitives → 100%** (high; tool-surface refactor)
- Decompose `perform_web_action` (~200-line branching dispatch) into atomic primitives (e.g. search-provider, fetch/browse, find-slots, book, request-refill, manage-credentials).
- Extract notification side-effects out of workflow tools (`cancel_appointment`, `schedule_interview`, `submit_gps_checkin`, `respond_to_job_application`, etc.) into a standalone `send_notification` primitive the model composes.
- Replace orchestration tools (`find_replacement_caregivers`, `request_booking`) with composable read/filter/write primitives; move approval-gating to the outer loop.
- Adopt a primitive naming convention (`get_`/`list_`/`create_`/`update_`/`delete_`/`search_`/`submit_`).
- CLAUDE.md-sanctioned code paths stay N/A (Track A).

**B7. Prompt-Native Features → 100%** (highest risk; the critical-path refactor)
- Rewrite the 67-step `functions/src/agents/onboardingConversation.ts` switch machine into a prompt-driven step dispatcher (LLM decides next question from `collectedFields` + phase state).
- Same treatment for `jobPostingFlow.ts`, `modifyScheduleFlow.ts`, refund flow, availability handler.
- Move hardcoded thresholds/SLAs to config/Remote Config: 48h dispute SLA, shift-offer TTL, etc.
- Move non-safety decision lists (approval words, bereavement keywords) to an editable store; keep crisis keywords as code (Track A).

### Out of Scope

- Anything that makes an auth-critical action agent-reachable or a compliance record mutable.
- The Track A exclusions themselves.
- Net-new product surfaces beyond agent parity (this is a parity/architecture effort, not a feature expansion).

---

## Onboarding Cutover Safety (settled: Shadow + Transcript Replay)

Because `onboardingConversation.ts` is the **sole** caregiver signup path (per CLAUDE.md), the B7 rewrite is gated:

1. Assemble a corpus of real + synthetic onboarding transcripts covering happy path, mid-flow questions, corrections, multi-field absorption, and edge orders.
2. Replay the corpus against the new prompt-driven flow; require it to collect the **same required fields** and reach the **same terminal state** (`status: active`, `onboardingStatus: profile_complete`, `verificationStatus: submitted`).
3. Run the new flow in **shadow** alongside the live machine before any user cutover.
4. Cut over only after parity threshold met; keep instant rollback to the legacy machine.

---

## Dependencies & Assumptions

- **Audit must become exclusion-aware.** The 100% target assumes `/ce-agent-native-audit` is updated (or invoked with a flag) to read `AGENT_NATIVE_EXCLUSIONS.md` and drop those items from denominators. Without this, a true 100% is unreachable by design. *(Assumption: the audit skill can be parameterized this way — verify when planning.)*
- **Scoring denominators are approximate.** Audit tool counts ranged 105–138 depending on grouping; "100%" is per-principle pass, not an exact fraction.
- Real-time listeners assume Firestore `onSnapshot` is acceptable cost at current scale (existing pattern in `services/api.ts`).
- Transcript corpus availability: assumes access to real onboarding logs OR willingness to author synthetic coverage. *(Open — see below.)*
- B6/B7 refactors assume existing Vitest + Playwright harness can cover the new prompt-driven paths via field-coverage + replay tests.

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Onboarding rewrite regresses the sole signup path | High | Shadow + transcript replay + flag rollback (above) |
| Prompt-driven flows drift / hallucinate next step | Med | Field schema remains the hard contract; replay parity gate |
| Tool decomposition (B6) breaks existing qaAgent tool-use loop on Sonnet | Med | Refactor incrementally, keep tool count stable per release, regression-test the MCP loop |
| Context-injection bloat raises latency/token cost | Low-Med | Preload only high-hit context (care plan, account state); keep privacy-sensitive data (earnings) lazy |
| "All-in" blast radius across many subsystems at once | Med | Even within all-in, land additive B1–B3 first as they de-risk and show score movement early |

---

## Outstanding Questions (for planning)

1. Can `/ce-agent-native-audit` be made exclusion-aware (read `AGENT_NATIVE_EXCLUSIONS.md`), or do we re-baseline manually each run?
2. What's the exact transcript-replay parity threshold for onboarding cutover (e.g. 100% required-field coverage, % terminal-state match)?
3. Do we have real onboarding transcripts to seed the replay corpus, or author synthetic-only?
4. For B6, is there appetite to grow the tool count (decomposition adds tools) given CLAUDE.md notes the 83-tool MCP loop "works best on Sonnet"? Need a ceiling.
5. Which decision lists move to an editable store vs stay code (bereavement/approval words are borderline)?
