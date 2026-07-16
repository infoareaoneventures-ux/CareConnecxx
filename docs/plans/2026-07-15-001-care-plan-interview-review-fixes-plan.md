# Fix Plan: Care-Plan Interview Review Findings (2026-07-15)

**Source:** Post-deploy bug review of the care-plan interview wave (`ea52d95`, deployed + flag ON 2026-07-15).
**Verdict at review:** Ready with fixes — no P0s; two P2s worth shipping immediately, two small P3s, one accepted risk.
**Scope:** functions-only (no hosting, no rules, no indexes). One commit, one targeted-or-full functions deploy.

## Requirements

- R1 — The all-declined rematch path (`notifyFamilyIfAllDeclined`) must keep working for every job after care-plan follow-ups are sent (fixes review finding #1, P2).
- R2 — Medication names/dosages must not reach caregivers via task strings (finding #2, P2).
- R3 — Job-post description enrichment must not truncate family text containing the literal marker (finding #3, P3).
- R4 — Interview kickoff must be single-send under racing completion paths (finding #4, P3).
- R5 — Tests cover R1's guard read/write; full suite + parity guard stay green.

## Implementation Units

### U1. Guard storage redesign — stop minting marker docs in `job_notifications` (R1)

**Problem:** `notifyEngagedCaregiversOfCarePlan` (carePlanInterview.ts) writes its sent-guard for application-only caregivers as a NEW doc in `job_notifications` keyed by the application's docId, with no `status` field. `notifyFamilyIfAllDeclined` requires every `job_notifications` doc for a job to be `declined|applied` — a status-less marker blocks the family notification + rematch forever. Secondary: the `applied` stamp's `phone+jobId limit(1)` query can hit the marker instead of the real notification.

**Fix:**
1. For caregivers sourced from `job_applications`, store the guard ON the application doc itself: `carePlanUpdateSentAt` field via `doc.ref.set({carePlanUpdateSentAt}, {merge:true})`. Never create docs in `job_notifications` from this path.
2. Poison the dedupe map from BOTH sources: notification docs with `carePlanUpdateSentAt`, and application docs with `carePlanUpdateSentAt`.
3. Defensive hardening in `notifyFamilyIfAllDeclined` (jobNotifications.ts): only count docs that represent real sends (`sentAt` present) toward the all-declined check, so any stray legacy marker can never wedge a job.
4. Prod hygiene check (post-deploy, read-only): query `job_notifications` for docs with `carePlanUpdateSentAt` and no `sentAt` — expected ZERO (feature is hours old, no completion has fired); delete any found with founder-named consent.

### U2. Privacy line for task strings (R2)

Two prose-only edits, no tool-count change:
1. `buildCarePlanInterviewDirective`: add rule — task entries describe the ACTIVITY ("morning medication reminder"), never drug names or dosages; medication specifics go only through `update_care_plan` field `medications`.
2. `save_care_task_detail` tool description (mcp/server.ts): same instruction sentence, so the rule holds even on turns where the directive is absent (interrupt turns with the tool force-included).

### U3. Safe description-marker anchoring (R3)

`enrichJobPostFromCarePlan`: anchor the marker as `\n\nDay-to-day tasks:` (the exact string WE append) — split on that anchored form instead of the bare marker, so family text containing the phrase mid-sentence survives. Keep replace-not-stack idempotency (existing test asserts it; extend for the mid-sentence case).

### U4. Transactional kickoff claim (R4)

`startCarePlanInterview`: replace the read-then-set flag write with a transaction — claim `carePlanInterviewActive: true` only if not already set/completed (same pattern as `maybeCompleteCarePlanInterview`); send the first question only when this call won the claim. Kills the double-SMS window between racing completion paths.

### U5. Tests + verification (R5)

1. Unit tests (carePlanInterview.test.ts): guard written to `job_applications` doc (never a new `job_notifications` doc); application-doc guard poisons the dedupe map; marker-tolerant all-declined behavior (jobNotifications side, if cheaply mockable); U3 mid-sentence marker case.
2. Run: new test file + `toolCapabilities.test.ts` + `caraGateWalk.test.ts` + `flowDispatch.test.ts` + `permissionsConversation.test.ts`; `npm --prefix functions run build` clean.
3. Commit `fix(evia): care-plan interview review fixes — guard storage, privacy line, marker anchor, kickoff claim`; push branch + `branch:main`; deploy functions (hosting unchanged).
4. U1 step 4 prod hygiene check.

## Accepted risk (no code change)

- **Finding #5 (P3):** interview kickoff can interleave with fire-and-forget matching sends at onboarding completion. Matching texts are minutes-out in practice ("within the hour" copy); reordering buys no guarantee. Revisit only if a real transcript shows confusing interleave.

## Out of scope

- Fresh-number E2E and the named-consent backfill — already owed separately (see memory/progress tracker); unchanged by this plan.
- Relaunching the independent multi-agent review — optional, on founder request.
