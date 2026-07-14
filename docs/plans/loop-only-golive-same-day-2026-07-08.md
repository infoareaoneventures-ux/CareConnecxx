# Same-day go-live: compressed Phase 3 (validation) + Phase 4 (deletion)

**Supersedes the bake period in `loop-only-onboarding-plan-2026-07-08.md` (founder call,
2026-07-08: no 1–2 week bake — live today).** Phases 0–2 of that plan must be code-complete
before starting this. Everything below happens in one day.

**Strategy: two deploys, not one.** Deploy A ships the fixes and gap-closures while the
scripted path still exists (untouched, as instant fallback). You validate LIVE against
Deploy A. Deploy B is pure code deletion of a path that Deploy A just proved unused.
Rollback for B is `git checkout` of A + redeploy — minutes, not hours. Never combine
A and B into one deploy: that turns "validated deletion" back into "hope".

---

## Hour 0 — Preflight (~20 min)

- [ ] Phase 0 done: `git init` + commit (or dated backup zip). **Hard gate — do not proceed without it.**
- [ ] Phases 1–2 code-complete: double-ask fixes + all six gap closures (2a–2h).
- [ ] `npm --prefix functions run build` clean.
- [ ] Full unit suite green (only known-pre-existing failures: 3 × onboardingReplay — these
      get deleted in Deploy B anyway).
- [ ] Two fresh test numbers reset: `scripts/delete-phone.mjs <phone> --confirm` (each).
- [ ] Confirm live env == `functions/.env` (69 vars) before touching anything.

## Hour 0.5 — Real-model eval (replaces the bake's statistical confidence) (~30 min)

- [ ] `npm run eval:onboarding` with `CARA_EVAL_LIVE` set (spend-gated; this is the U8 gate).
- [ ] PASS = go. FAIL on any scenario = stop, fix, re-run. Do NOT waive this because of
      time pressure — with no bake period, this eval and the live matrix below are the
      ONLY validation the deletion gets.
- [ ] Record results in `docs/runbooks/launch-config-baseline.md`.

## Hour 1 — Deploy A (fixes + gap closures; scripted path still present)

- [ ] Commit ("loop hardening: pre-turn absorb, repeat guard, loop-only gap closures").
- [ ] Deploy full functions from `CareConnecxx-main` (ROOT `node_modules/.bin/firebase`,
      `FUNCTIONS_DISCOVERY_TIMEOUT` raised). Verify exit 0, 44 fns, env count intact.

## Hour 1.5 — Live E2E matrix against prod (the compressed bake, ~60–90 min)

Caregiver (test number 1), full run to the photo gate:
- [ ] Name → city → **front-loaded story** ("12 years, mostly dementia, CNA") — verify all
      fields absorbed in ONE turn (no re-ask of experience/specialties).
- [ ] **One mid-flow question** ("how do I get paid?") — answered + returns to collection.
- [ ] Availability → **"Full time"** — THE regression: next message must ask hourly rate,
      never repeat the job-type question.
- [ ] Combined profile ask appears once (gender/languages/canDrive) and doesn't block skip.
- [ ] **Send an image mid-collection** → polite nudge, flow continues.
- [ ] **Send a location pin** → absorbed as city/zip, service-area gate correct.
- [ ] Rate → email → bio → verify handoff: photo-upload message arrives (gate machine).
- [ ] Firestore check: `agent_sessions/{phone}.onboardingData` has ALL fields, normalized
      (`jobType: "full_time"`, not "Full time").

Client (test number 2), full run to payment handoff:
- [ ] Front-load ("I'm Sara, my mom Ruth is 84, needs mornings help, San Jose") — one-turn absorb.
- [ ] One mid-flow question; one **voice memo** answer (transcription → loop).
- [ ] **START OVER** mid-flow → clean restart. Then re-run to completion → payment link arrives.
- [ ] **RESUME** test: go silent mid-collection, send RESUME → picks up correctly (2f path).

Any failure = fix on Deploy A (scripted fallback still live, users unaffected), redeploy A, re-run
the failed scenario. Deploy B waits until the matrix is 100% green.

## Hour 3 — Go/No-Go for Deploy B

GO requires ALL of: eval passed · matrix 100% green · no new `admin_alerts` /
`agent_uncertainty_log` entries from the test runs beyond expected · git commit of Deploy A
tagged (`pre-deletion`).

## Hour 3.5 — Deploy B (the deletion)

- [ ] Execute Phase 4 of the master plan exactly (deletion list, keep list, routing
      simplification, flag removal, defensive default case, docs updates).
- [ ] Port-then-delete tests per the master plan; suite green.
- [ ] Build clean; commit ("loop-only: delete scripted collection path").
- [ ] Deploy full functions. Verify exit 0 + env count (NEW baseline — `ONBOARDING_AGENT_LOOP*`
      removed intentionally; record the new count in the runbook).
- [ ] Smoke re-run (15 min, reset test number 1): caregiver name → story → jobType →
      handoff. Client: two questions in. Both green = live.

## Hours 4–48 — Monitoring IS the bake now

- [ ] Watch `cara_turn_metrics` (re-greet, self-repeat, persistence-net fire rate — should
      trend ~0 after Fix 1), `admin_alerts`, `agent_uncertainty_log`, and the
      onboardingCanaryWatch output. Check at +1h, +4h, +24h, +48h.
- [ ] Re-engagement sweep sanity: nudges still label steps correctly.
- [ ] Any real-user stuck signup → `delete-phone` reset is the user-level fix;
      `git checkout pre-deletion` + redeploy is the system-level rollback (minutes).

## What we are consciously accepting by skipping the bake

Low-frequency conversation shapes (unusual phrasings, rare front-load combos, odd media)
won't have been seen before real users hit them. Mitigation: the persistence net + absorber
mean the failure mode is a clumsy reply, not lost data or a dead signup; monitoring
checkpoints above catch clusters fast; rollback is one command. Accepted by founder 2026-07-08.
