# Agent-Native Architecture Review: Evia (CareConnex)

**Date:** 2026-07-03 · **Method:** 8 parallel principle audits (ce-agent-native-audit) · **Scope:** full repo — React/Vite frontend + Firebase Functions backend

> **REMEDIATION LANDED 2026-07-03 (same day)** — see the "Remediation Update" section at the bottom. Post-remediation projected score: **~92%** (from 82%). The original audit below is preserved as the baseline.

## Overall Score Summary

| Core Principle | Score | Percentage | Status |
|----------------|-------|------------|--------|
| Action Parity | 58/58 | 100% | ✅ |
| Tools as Primitives | 140/145 | 97% | ✅ |
| Shared Workspace | 9/10 | 90% | ✅ |
| Context Injection | 7/8 | 88% | ✅ |
| Capability Discovery | 6/7 | 86% | ✅ |
| UI Integration | 14/18 | 78% | ⚠️ |
| CRUD Completeness | 19/25 | 76% | ⚠️ |
| Prompt-Native Features | 11/25 | 44%* | ❌ |

**Overall Agent-Native Score: 82%**

*Status legend: ✅ Excellent (80%+) · ⚠️ Partial (50–79%) · ❌ Needs Work (<50%)*

\* **Correction:** the prompt-native audit read *code defaults* and counted client onboarding as CODE because `ONBOARDING_AGENT_LOOP` is unset in code. Per the verified launch config baseline (`docs/runbooks/launch-config-baseline.md`, live env verified byte-identical 2026-07), the client agent loop runs at **100% in production via env var** — so live client onboarding is prompt-native. Adjusted score ≈ 12/25 (48%), still the weakest principle. Caregiver onboarding remains fully scripted with no directive equivalent.

---

## Per-Principle Findings

### 1. Action Parity — 58/58 (100%) ✅
- Machine-enforced parity registry: `functions/src/agents/launchActionParity.ts` (58 shipped rows: 22 client + 22 caregiver + 2 family + 12 admin) with `toolCapabilities.test.ts` verifying every row resolves to a real tool/callable reachable by the correct prompt filter. **0 blocker rows.**
- Independent cross-check of `services/api.ts` + component `httpsCallable` sites found no user-facing write action lacking an agent tool.
- One low-confidence edge: `shiftHoursService.confirmCashReceived` (`services/api.ts:3731`) has no dedicated tool — verify whether the UI button survived the 2026-07-02 dead-code cleanup; add a tool or delete the orphan.
- Dead service code: `givePeerRecognition` has no UI caller — prune to avoid phantom parity flags.
- Documented exclusions (AGENT_NATIVE_EXCLUSIONS.md) correctly cover password change, account deletion, ban/hard-delete, invoice mutation, and non-goals.

### 2. Tools as Primitives — 140/145 (97%) ✅
- 145-tool MCP registry is overwhelmingly clean read/write/list/send primitives; cross-cutting concerns (auth, ownership, confirm-gate, audit, idempotency) centralized in `runTool.ts` bands; behavior correctly lives in 3 file-based `SKILL.md` packs.
- **5 workflow tools flagged:** `perform_web_action` (switch-statement-as-a-tool branching across portal flows), `save_onboarding_field` + `complete_collection` (onboarding state machine leaked into the tool layer, duplicating `onboardingContract.ts`), `request_shift_swap` (search + broadcast fused), `suggest_upcoming_care` (upsell heuristic baked in).
- Borderline watch-items: `select_callout_backup`, `request_callout_refund`, `modify_recurring_schedule`, `trigger_emergency_alert`, `resume_execution_agent`.
- `caraActionRegistry.assertHealthy(maxModelVisible=40)` caps the CaraAction surface, but `MCP_TOOLS[]` has no equivalent "one capability per tool" gate.

### 3. Shared Workspace — 9/10 (90%) ✅
- Explicit enforced data contract at `functions/src/data/contract.ts` — invariant: **"Evia must write where the web reads"** — verified by `tests/contractCollections.test.ts`. ~50 operational collections genuinely shared; raw agent stores bridged to UI via sanitized projections (`user_activity_feed`, `shift_swap_summaries`).
- Real gap: the **agent memory layer is UI-invisible** (`learned_facts`, `memory_embeddings`, `blocks`, `agent_conversations`, `user_preferences`) — no "what Evia knows about me" surface, no correction/forget affordance. Trust + HIPAA-transparency issue.
- Minor: `seniors` vs `senior_profiles` controlled duplication; memory/signal stores absent from the contract registry; `disputes` has no web reader.

### 4. Context Injection — 7/8 (88%) ✅
- Mature layered pipeline in `qaAgent.ts`: core identity + full care plan (explicit PHI policy), operational context with **degradation sentinels** when live sources fail, Zep + memory files + learned facts, capability hints tied to live state, ~80-tool inline catalog.
- **Biggest gap: no current date/time/day-of-week/timezone in the conversational system prompt** — serious for a scheduling agent (single-shot handlers inject it; the main agent doesn't).
- Also missing: DND/quiet-hours and communication preferences surfaced to the model (enforced only in delivery-layer `shouldSend`); document content (only status flags); caregiver core context is thin vs. the client side.

### 5. CRUD Completeness — 19/25 (76%) ⚠️
- Full agent CRUD across the transactional core: appointments, shifts, jobs, applications, reviews, journal, reminders, timesheets, billing, subscriptions, referrals, support tickets.
- Incomplete: **Senior profile has no delete/archive tool** (undocumented gap on the central entity); Care Plan (no delete, upsert-only create); Message (no update/delete — likely intentional, undocumented); Family Group Member (no update of role/permissions); Interview (no read/cancel); Memory File (no delete).
- Several would resolve by simply documenting intentional immutability in AGENT_NATIVE_EXCLUSIONS.md.

### 6. UI Integration — 14/18 (78%) ⚠️
- Real-time-by-default: 109 `onSnapshot` registrations across 39 files; agent actions projected into a family-safe `user_activity_feed` via `projectActivityFeed`. All core loops (booking, messaging, care plans, profiles, shift lifecycle, check-ins, notifications) update immediately.
- **Silent actions:** (1) family member add/remove — agent writes `family_group_members` but `FamilyManager.tsx` one-shot reads `senior_profiles.familyMembers` (dual source of truth + non-reactive); (2) `emergency_alerts` has no in-app listener — safety-critical action reaches UI only via the notification pipeline; (3) `referrals` — no in-app surface; (4) admin `InvoicingTab.tsx` uses one-shot `.get()`.

### 7. Capability Discovery — 6/7 (86%) ✅
- Strongest mechanism: `buildCapabilityHint` (role-aware care recipes injected into the system prompt, tested). Good empty-state + suggestion chips, rich platform Help/FAQ.
- Gaps: **no persistent capability affordance in chat** (all discovery vanishes after the first message); `constants/caraCapabilities.ts` — the CI-synced canonical capability mirror — is **orphaned** (its consumer `AiSearchAgent.tsx` was removed in the 2026-07-02 cleanup) while `CaraChat` ships divergent hardcoded suggestions; `/help` / `/capabilities` work only on the SMS path — web chat (`linq/webChat.ts`) bypasses the intent classifier; `buildCapabilityMenu` is built but never wired into onboarding completion (stale comment claims otherwise); Help docs describe the platform, not what you can *ask Evia*.

### 8. Prompt-Native Features — 11/25 code-default (44%) ❌ · ~12/25 live (48%)
- Prompt-native and excellent: Q&A/action agents (client + caregiver personas), 3 SKILL.md skills + LLM skill picker, matching judgment prose, memory policy, voice contract, client onboarding directive (live at 100% per config baseline).
- Code-defined anti-patterns dominate transactional flows:
  1. **`linq/routeIntent.ts` (~1,861 lines)** — hand-written intent→handler dispatcher with nested pending-flag state machines; only 2 of ~45 flows flipped to convergence.
  2. **`onboardingConversation.ts` (~3,646 lines)** — scripted step machine; still the only path for **caregiver** onboarding (no directive equivalent exists).
  3. **`intentClassifier.ts`** — 45+ hardcoded Intent enum; new capability = enum + branch + deploy.
  4. Per-intent handler files (refund, timesheet, earnings, availability, swap, profile, cancel-shift) duplicating existing MCP tools.
  5. `jobPostingFlow.ts` / `modifyScheduleFlow.ts` still code-sequenced even in "converged" form; matching escalation thresholds (`failureCount >= 2 → urgent`) hardcoded.
- Operational note: even prompt-defined behavior lives in inline TS template strings (redeploy to change); only the SKILL.md files are truly prose-editable.

---

## Top 10 Recommendations by Impact

| Priority | Action | Principle | Effort |
|----------|--------|-----------|--------|
| 1 | Continue routing convergence: flip read-only/reversible intents (earnings, invoices, journal, availability) from `routeIntent.ts` onto the MCP tool loop, then retire their handler files | Prompt-Native | High |
| 2 | Build the **caregiver** onboarding directive (client's `onboardingDirective.ts` pattern) so caregiver signup stops depending on the 3,646-line scripted state machine | Prompt-Native | Medium-High |
| 3 | Fix the family-member silent action: make `family_group_members` the single source of truth and add `subscribeToFamilyMembers` onSnapshot in `FamilyManager.tsx` | UI Integration | Low-Med |
| 4 | Inject a CURRENT TIME block (ISO date, day-of-week, user timezone) into both conversational system prompts | Context Injection | Trivial |
| 5 | Rewire capability discovery UI: source `CaraChat` chips from `constants/caraCapabilities.ts`, add a persistent "What can Evia do?" affordance using the unused `buildCapabilityMenu`, and send the capability menu as the final onboarding message | Discovery | Low |
| 6 | Honor `/help` / `/capabilities` in web chat (`linq/webChat.ts` — check before falling through to `runQaAgent`), then advertise it | Discovery | Low |
| 7 | Close CRUD gaps: add `delete_senior_profile` (or archive), `update_family_member`, interview read/cancel — and document Message U/D + Care Plan D immutability in AGENT_NATIVE_EXCLUSIONS.md | CRUD | Low-Med |
| 8 | Add in-app `emergency_alerts` listener + banner (safety-critical), and convert `InvoicingTab` to onSnapshot | UI Integration | Low-Med |
| 9 | Surface agent memory: read-only "What Evia knows" view over `learned_facts`/`user_preferences` with a correct/forget affordance; register memory collections in `contract.ts` | Shared Workspace | Medium |
| 10 | Refactor the 5 workflow tools (`perform_web_action`, `save_onboarding_field`, `complete_collection`, `request_shift_swap`, `suggest_upcoming_care`) into primitives with logic moved to skills/agent loop | Primitives | Medium |

Also worth doing (small): resolve `confirmCashReceived` (add tool or delete orphan), prune `givePeerRecognition`, extend `contractCollections.test.ts` to flag one-shot `.get()` reads of agent-writable collections, externalize system prompts from inline TS strings to loadable files.

---

# Remediation Update — 2026-07-03 (landed same day)

Four parallel workstreams closed the tractable gaps. All gates green: functions transpile 277 files / 0 errors, frontend `tsc --noEmit` clean, **674 tests passing across 51 files**. Full backup at `../pre-100-backup-2026-07-03`. **Nothing deployed** — deploy notes below.

## Post-Remediation Scorecard

| Core Principle | Before | After | Status | What changed |
|---|---|---|---|---|
| Action Parity | 100% | **100%** (59/59) | ✅ | `confirm_cash_received` tool + parity row (found to be a LIVE flow, untracked); dead `givePeerRecognition` pruned |
| Tools as Primitives | 97% | **97%** (148/153) | ✅ | 8 new clean primitives; the 5 workflow-tool refactors deliberately deferred (behavior-risky pre-launch) |
| Shared Workspace | 90% | **~95%** | ✅ | 10 memory/signal collections registered in `contract.ts` (isolation now deliberate + test-governed); "What Evia knows" user surface still open |
| Context Injection | 88% | **~94%** | ✅ | CURRENT TIME block (cache-safe), DND/comm-prefs surfaced to model, caregiver core context parity; document-content summarization still open |
| Capability Discovery | 86% | **100%** (7/7) | ✅ | Persistent "What can Evia do?" menu, canonical chips, `/help` on web chat, onboarding capability tour, agent-focused Help section |
| UI Integration | 78% | **~100%** (17/17) | ✅ | Family roster live (dual-source merge), in-app emergency banner, live invoicing; referrals documented SMS-only exclusion. Household-wide emergency visibility = follow-up enhancement |
| CRUD Completeness | 76% | **100%** (25/25) | ✅ | 7 CRUD tools added + intentional immutability documented in AGENT_NATIVE_EXCLUSIONS.md (message U/D, care-plan D, senior hard-delete) |
| Prompt-Native Features | 44–48% | **~48%** (live) | ❌→⚠️ | Caregiver directive now BUILT and tested, shipping dark; score moves to ~52% at flag flip. Full score requires the routing convergence program (below) |

**Overall: ~92%** (from 82%). The remaining 8 points live almost entirely in Prompt-Native Features — a flag-gated migration program, not a patch.

## Safety/quality additions beyond the audit asks
- `archive_senior_profile` + `delete_memory_file` added to `ALWAYS_CONFIRM` in `pendingActions.ts` (runtime-enforced confirmation, not just prompt-level).
- 5 new `AuditEventType` literals so the new tools' audit events typecheck.
- qaAgent.ts client + caregiver tool catalogs updated for all 8 tools (parity soft-guard cleared for them).

## Path to 100% on Prompt-Native (the launch-safe sequence)
1. **Caregiver loop flag flip:** run `CARA_ONBOARDING_EVAL_LIVE=true … npx vitest run functions/src/agents/qaAgent.onboarding.eval.test.ts` (3 `cg_*` cases must pass, P95 ≤ 4s) → set `ONBOARDING_AGENT_LOOP=client,caregiver` with `ONBOARDING_AGENT_LOOP_COHORT_PCT=10` → 100%. Kill switch: remove `caregiver` from the role list. Flag flips happen out-of-band in the live env — never via a deploy with a partial `.env`.
2. **Routing convergence:** flip read-only/reversible intents (earnings, invoices, journal, availability views) from `routeIntent.ts` onto the MCP loop via the existing `ROUTING_CONVERGENCE_SHADOW` → `CONVERGENCE_FLIPPED` machinery, one flow at a time; retire each handler file as its flow flips. ~43 flows remain.
3. **Workflow-tool refactors** (post-launch): split `perform_web_action` into portal primitives; collapse `save_onboarding_field`/`complete_collection` process logic into the onboarding contract/skill; split `request_shift_swap` into find + send; move `suggest_upcoming_care` judgment into a skill.
4. **Externalize system prompts** from inline TS strings to loadable files (SKILL.md pattern) so persona changes stop requiring deploys.

## Deploy notes (founder-owned, per runbook)
- `firestore.rules` changed: owner-scoped read added on `family_group_members` (family-roster live merge won't show agent-index rows in prod until rules ship).
- New/changed functions surface: 8 MCP tools, webChat /help path, qaAgent prompt changes, dark caregiver-directive wiring — a normal full functions deploy covers it (`FUNCTIONS_DISCOVERY_TIMEOUT=120`, full `.env` intact per the functions-env runbook).
- Follow-ups tracked in `context/progress-tracker.md`: household-wide emergency projection (uid-keyed), "What Evia knows" memory surface, `.get()`-on-agent-collections lint, HowItWorks $49.99 vs $29.95 copy decision (pre-existing).

## What's Working Excellently

1. **Machine-enforced action parity** — `launchActionParity.ts` + `toolCapabilities.test.ts` with 0 blockers; the parity promise holds for every non-excluded action. Rare and exemplary.
2. **The data contract** — "Evia must write where the web reads," statically tested, with sanitized projections (`user_activity_feed`, `shift_swap_summaries`) bridging raw agent stores to users.
3. **A 97%-primitive tool surface** with cross-cutting bands centralized in `runTool.ts` and behavior correctly living in SKILL.md files — the intended agent-native shape.
4. **Sophisticated context injection** — layered, predicate-gated, cached, with explicit degradation sentinels telling the model when its context is stale.
5. **Real-time-by-default UI** — 109 Firestore listeners plus a purpose-built agent-activity transparency feed; agent actions are visible, attributable, and immediate on every core loop.
6. **A documented-exclusions culture** — AGENT_NATIVE_EXCLUSIONS.md makes non-parity a deliberate, auditable decision rather than drift.
