# CareConnex — Progress Tracker

> Update this file after every meaningful implementation change. This is the one living "where we are" doc — it replaces the scattered point-in-time reports now archived under [`docs/archive/`](../docs/archive/).

## Current Phase

**Pre-release hardening.** The platform is built and integrated (Stripe, Checkr, Twilio, Firebase, Cara). Focus is now correctness, single-source-of-truth, and closing the gap between what the docs claim and what runs end-to-end.

## Current Goal

Adopt the spec-driven workflow (these `context/` files), make type-safety actually enforced, and verify the release-gating success criteria in [project-overview.md](./project-overview.md).

## Completed (most recent first)

- **2026-06-01** — **Fixed Cara hijacking interview-scheduling replies into a re-search.** Bug: with caregiver matches still pending in session, a family answering Cara's "What date and time works best?" with "Today at 11am" was misread by `matchRefilterDetector` as an availability *search filter*, so Cara re-ran matching ("Searching for available today at 11am — coming up") and re-listed caregivers instead of scheduling. Fix (3 parts, all LLM-context, no keyword parsing): (1) `detectMatchRefilter(text, lastAssistantMessage?)` now takes Cara's prior turn so it can tell a scheduling answer apart from a search-criteria change; (2) the webhook mid-match branch loads Cara's last message and passes it in; (3) the client qaAgent prompt now surfaces the just-shown `pendingMatches` (names + caregiverIds) and instructs it to `schedule_interview` with the right caregiverId — asking which one if ambiguous — rather than re-searching. Added a refilter test; qaAgent/golden suites green.
- **2026-06-01** — **Reconciled duplicate caregiver onboarding → Cara SMS is now the single canonical path.** Retired the web "Apply Online" form: `/caregiver/apply` redirects to `/start?role=caregiver`, footer link repointed, and `CaregiverSignupFlow` + `SignupLayout` + signup `types.ts` + `steps/` deleted (kept shared `constants.ts`). Demoted `CaregiverOnboardingWizard` to a legacy recovery tool (removed the dead `careconnex_show_caregiver_wizard` trigger; it now only opens for `onboardingStatus:'incomplete'` accounts). Fixed the status contract: Cara finalization now also sets `verificationStatus:'submitted'` (no-clobber guard preserves terminal Checkr results) so Cara caregivers enter the admin verification queue. Identity unification deferred (see Next Up #2).
- **2026-06-01** — **Full TypeScript `strict` mode is ON and green.** Migrated the whole frontend: fixed all 251 strict errors (one-agent-per-file parallel workflow across 53 files + manual stragglers). Dominant fix: guarding the possibly-undefined `db`/`auth`/`functions` exports from `lib/firebase` (early-return guards, or captured-const/`!` where used across `await`); plus optional chaining + `?? default` for nullable data fields, typed callback params, and a few dup-key/cast fixes. `npm run typecheck` + `npm run build` both green; tests unchanged (same 3 pre-existing `family.test.ts` failures, 0 new). ⚠️ Large diff (~52 files) — warrants a human skim, especially the few `?? 0` defaults and the `CarePlan` object-spread reorder.
- **2026-06-01** — Stood up `context/` spec system (`project-overview`, `ui-context`, this tracker); linked from CLAUDE.md. Archived ~25 stale root reports into `docs/archive/`.
- **2026-06-01** — Type-safety enforcement: excluded vendored `third_party/` from typecheck, fixed the 2 real type bugs (`CareJournalEntry` shape in `types.ts`), added an enforced **`npm run typecheck`** (green, 0 errors) and gated **`npm run build`** on `tsc --noEmit`. The strictness ramp itself is staged (see Next Up) — `strict` was NOT flipped on, because the fallout (noImplicitAny: 52, strictNullChecks: 187) is a multi-file migration, not a one-shot diff.
- **2026-06-01** — Closed the deploy type-gate (`npm run deploy` now runs `npm run build`, which typechecks). **Reverted an earlier mistaken deletion:** `CaregiverSignupFlow` (+ `SignupLayout`, signup `types.ts`, `steps/`) was NOT dead — it is the live component for the `/caregiver/apply` route (confirmed in HEAD). It was wrongly deleted on 2026-05-31; the new `tsc` gate caught the broken import (`vite build` had silently tolerated it). All signup files and the `CaregiverDashboard` sessionStorage trigger are restored.
- **2026-05-31** — Fixed caregiver-visibility bug: Cara onboarding now sets `onboardingStatus: 'profile_complete'` on finalization (`functions/src/agents/onboardingConversation.ts`), so Cara-onboarded caregivers appear in `FindCaregivers`. Wrapped `/caregiver/profile` and `/caregiver/inbox` in `CaregiverRoute`. *(Note: the "dead code removal" from this date was reverted — see 2026-06-01.)*

## In Progress

- None active. Pick the top "Next Up" item as a single verified unit.

## Next Up (ranked "make-it-releasable" backlog)

1. ~~Strictness ramp~~ — **DONE 2026-06-01** (see Completed). Full `strict` is on and enforced via `npm run typecheck` + build gate.
2. **Unify caregiver identity model (data-touching).** Cara writes phone-keyed, random-ID `caregivers` docs with **no Firebase Auth account**; legacy web caregivers used uid-keyed docs + a `users` doc + auth. Consequence: Cara caregivers can't log into the web dashboard and aren't cross-referenced with `users` (FindCaregivers reconciles `users` + `caregivers`). Decide the canonical identity (likely: create an auth account / link by uid during Cara onboarding), and migrate existing phone-keyed records. ~~Reconcile duplicate onboarding flows~~ — **DONE 2026-06-01** (Cara is now the sole path; see Completed).
3. **Decompose `services/api.ts` (~128KB).** Split by domain (auth, caregivers, bookings, payments, notifications) — violates "small, single-purpose modules."
4. **Reduce `any` in `functions/src` (~757 occurrences).** Start at system boundaries (webhook payloads, session objects). Replace `(session as any)` casts with typed interfaces.
5. **Verify release-gating success criteria end-to-end** (project-overview §Success Criteria) — add/confirm tests for: caregiver onboarding → visible → bookable; client signup → match → book → pay; webhook idempotency.

## Open Questions

- **Unattributed edit:** `functions/src/scheduled/staleSessionNudge.ts` has an uncommitted change (added `caregiver_awaiting_*` / `client_awaiting_identity` nudge steps) that appeared during the 2026-05-31 session and was NOT made by the onboarding fix work. Confirm authorship before committing.
- **Pre-existing stash:** `git stash@{0}: local-uncommitted-changes` holds a large unrelated changeset (AdminView, BackgroundCheckModal, checkr.ts, landing, etc.). Decide whether to apply, review, or drop it.
- **Full strict timing:** do we gate `npm run build` on `tsc` now (currently `build` runs typecheck) or keep typecheck a separate CI step until the strictNullChecks migration lands?

## Architecture Decisions

- **2026-06-01** — `context/` files are additive to CLAUDE.md (CLAUDE.md stays canonical and links to them) rather than replacing it, to avoid creating duplicate sources of truth.
- **2026-06-01** — Vendored `third_party/` is excluded from our typecheck; it carries its own (unmet) dependencies and is not CareConnex code.
- **2026-05-31** — Caregiver search visibility is gated on `onboardingStatus === 'profile_complete'`; both onboarding paths (Cara SMS, web wizard) must set it. This is now an invariant.

## Session Notes

- Type-safety scope was chosen deliberately. Measured fallout: full `strict` = ~253 CareConnex errors (187 null-safety); `noImplicitAny` alone = 52. Both would be large diffs with a red type gate, so instead we installed the *enforcement mechanism* green now (excluded `third_party`, fixed the 2 real bugs, added `typecheck` + build gate) and staged the strictness ramp as backlog item #1. A green gate today is worth more than a half-on `strict` with 50–250 failing checks.
- Build pipeline note: `vite build` (esbuild) does NOT typecheck — `npm run typecheck` is the real type gate.
