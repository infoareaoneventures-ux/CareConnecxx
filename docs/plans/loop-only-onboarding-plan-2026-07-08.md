# Master plan: fix the double-ask, then make the agent loop the ONLY onboarding collection flow

**Decision (founder, 2026-07-08):** the agent loop (`ONBOARDING_AGENT_LOOP=client,caregiver`)
becomes the sole conversational-collection path; the scripted collection steps get deleted.
The deterministic gates (photo/documents/MVR/membership/Checkr/Stripe Connect), OTP,
ask_role, and confirm-name handlers are NOT part of this and stay scripted forever.

Execute phases in order. Phase 4 (deletion) is gated on Phase 3 (validation) passing —
do not skip the gate; the scripted path is the only rollback we have until then.

---

## Phase 0 — Safety prerequisites (do FIRST, ~30 min)

1. **This repo is NOT a git repository.** Before any deletion wave, either `git init` +
   initial commit (preferred — makes every later phase reviewable and reversible), or at
   minimum create a dated backup zip beside the repo (precedent: the 2026-07-02 dead-code
   cleanup zip). Do not start Phase 4 without one of these.
2. Confirm live env still matches `functions/.env` (69 vars) before any deploy.

---

## Phase 1 — Fix the double-ask bug (already specced)

Implement `docs/plans/fix-caregiver-jobtype-double-ask-2026-07-08.md` in full:
- **Fix 1:** pre-turn field absorption merged into `session.onboardingData` before
  `runQaAgent` (deduped with the existing location pre-gate at `webhooks.ts:1833-1866`).
- **Fix 2:** sentence-level repeated-question detection in `detectAgentSelfRepeat`
  (regression test = the exact "Full time" screenshot pair).
- **Fix 3:** normalize `jobType` (and enum-ish values) in `save_onboarding_field`.

Fix 1 is the keystone for loop-only: it gives the loop a deterministic persistence
guarantee per turn instead of relying on the model calling the tool.

---

## Phase 2 — Close the gaps that make the scripted path still necessary

These are the ONLY things the scripted collection path still does that the loop doesn't.
Each must be closed before deletion. (Dependency map source: agent sweep 2026-07-08.)

### 2a. Location pins during collection
`shouldRouteOnboardingToLoop` skips the loop when `hasLocation` (`onboardingContract.ts:174`),
so a shared location pin today relies on the bespoke `handleClientAskLocation` /
`handleCaregiverAskLocation` (reverse-geocode + service-area gate).
**Fix:** in `webhooks.ts`, BEFORE the routing predicate, convert `inboundLocation` to text
(reverse-geocode → "San Jose, 95112") and treat it as a text turn, letting the existing
pre-turn service-area gate + absorber handle it. Then drop `hasLocation` from the
predicate. The loop's location handling becomes strictly better than scripted (works at
ANY collection step, not just the location step).

### 2b. Media (image/document) during collection
Loop is skipped on `hasMedia`. Today `handleOnboardingStep`'s pre-switch guard calls
`handleInboundMedia` (`onboardingConversation.ts:716-718, 2540`), which serves the photo
and document GATES and sends a "not at that step yet" nudge during collection
(`:2562-2565`). **Keep this exactly as is** — `handleInboundMedia` and the gates survive;
media turns keep falling through to `handleOnboardingStep`. No work needed beyond NOT
deleting it in Phase 4.

### 2c. Empty-text turns (stickers, failed voice transcription)
Loop requires `hasText`. After Phase 4 there is no scripted collection handler to fall
back to. **Fix:** small deterministic nudge in the webhook for empty-text turns at a
collection step ("I couldn't read that — mind typing it?"). Voice memos are already
transcribed to text pre-routing (`webhooks.ts:664-689`), so this only covers failures.

### 2d. `runQaAgent` throws before replying
Today that falls through to the scripted handler (`webhooks.ts:2007→2042`). After
deletion, replace the fallback with: one retry of `runQaAgent`; if that also throws,
send a short apology + create an `admin_alert` (mirror the existing loopReplied-true
error path at `:2008-2029`). Never leave the turn silent.

### 2e. Confirm-name fall-throughs into collection handlers (KEPT handlers, live coupling)
- `handleClientConfirmName` calls `handleClientAskSenior` (`onboardingConversation.ts:1323`)
- `handleCaregiverConfirmName` calls `handleCaregiverAskLocation` (`:1975`)
**Fix:** when the confirm-name reply is a substantive non-name answer, set the cursor to
the first collection step and route the SAME text into the loop (call `runQaAgent`
onboardingMode directly, or return a marker the webhook uses to re-dispatch). The
absorber (Fix 1) will capture whatever the message contained.

### 2f. `__RESUME__` checkpoint resume targeting a collection step
`webhooks.ts:1264` re-enters a saved step via `handleOnboardingStep(…,"__RESUME__",…)`;
for collection steps that currently hits `conversationStep.ts:124` (re-ask). **Fix:** when
the checkpoint step is a collection step, build the re-ask from the loop's world instead:
compose a short "picking back up" message from `missingRequiredFields(role, onboardingData)`
(deterministic template or one `generateCaraMessage` call), send it, and leave the cursor
on the collection step. The `__RESUME__` drive to `caregiver_send_photo`
(`webhooks.ts:1989`) targets a GATE and is untouched.

### 2g. Profile-field parity (loop under-collects vs scripted)
Scripted `caregiver_ask_profile` always asked gender / languages / canDrive; the loop
treats them as optional extras and skips them (observed live). **Fix:** add a directive
line in `caregiverOnboardingDirective.ts` instructing one combined ask ("families often
filter by gender, languages, and driving — quick version?") positioned after specialties;
absorber already extracts them if volunteered. Decide with founder whether to promote any
of the three into `CAREGIVER_REQUIRED_FIELDS` (default: no — never hold up signup, but
always ask once).

### 2h. Client parity check
The client scripted path also had bespoke steps (`client_ask_location`,
`handleClientAskStory`-style absorption at `:792`). Verify the client directive +
absorber cover: multi-recipient households (`additionalRecipients`), self-care
(`relationship: "self"`), and the location gate — all already in the directive; just
add/keep replay-style loop tests for each before deletion.

---

## Phase 3 — Validation gate (must pass before ANY deletion)

1. `npm --prefix functions run build` + full test suite green (3 known onboardingReplay
   failures are pre-existing; they disappear in Phase 4 when replay tests are rewritten).
2. **Real-model eval:** `npm run eval:onboarding` with `CARA_EVAL_LIVE` — the U8 gate the
   100% flip was supposed to have. Record results in the launch-config baseline doc.
3. **Live E2E, fresh numbers, BOTH roles** (`scripts/delete-phone.mjs <phone> --confirm`
   to reset): full caregiver collection → photo gate handoff; full client collection →
   payment handoff. Include: front-loaded answer, mid-flow question, voice memo,
   location pin, an image sent mid-collection, START OVER, and a RESUME.
4. **Bake period:** 1–2 weeks at 100% with `onboardingCanaryWatch` metrics clean (no
   re-greets, no self-repeats, no stuck signups, persistence-net capture rate trending
   to ~0 after Fix 1 — the net firing often means the model is still skipping saves).

---

## Phase 4 — Deletion (scripted collection only)

### Delete
- `onboardingConversation.ts`: switch cases + handlers for `client_ask_name`,
  `client_ask_senior`, `client_ask_needs`, `client_ask_location`, `client_ask_schedule`
  (`:941-945`), `caregiver_ask_name` … `caregiver_ask_bio` (`:984-994`, handlers
  `:1980-2320` region); `CLIENT_STEPS`/`CAREGIVER_STEPS` builders (`:1360,1366`);
  `CLIENT_STEP_ORDER`/`CLIENT_STEP_FIELD` (`:494,504`); the client absorption preamble
  that only feeds scripted steps (`:792` region — verify nothing kept uses it);
  `stepDeps`/`clientStepCtx` wiring (`:1371-1394`).
- `onboardingSteps.client.ts`, `onboardingSteps.caregiver.ts`, `conversationStep.ts`
  (imported ONLY by the above + own tests — verified).
- `onboardingDispatcher.ts` + its dark U12 wiring (`:689-692, 701`) and the
  `CONVERGENCE_FLIPPED`/`UNFLIPPED` "onboarding" flow handling — it only ever routed to
  scripted client handlers; orphaned after this phase.
- Tests: `onboardingReplay.test.ts`, `onboardingConversation.client/caregiver/story.test.ts`,
  `onboardingContractSync.test.ts`, `conversationStep.test.ts`,
  `conversationStep.resume.test.ts`, `onboardingSteps.client.self.test.ts`. Port any
  scenario not already covered by `qaAgent.onboarding.test.ts` / `goldenTranscripts.test.ts`
  into loop-path tests BEFORE deleting (especially the caregiver gate-walk seeding —
  rewrite `caraGateWalk.test.ts` to seed directly at `caregiver_send_photo`).

### Keep (do NOT touch)
- `stepHandler.ts` — its `isQuestionOrOther` is a live NON-onboarding dependency
  (`webhooks.ts:423` group disambiguation; `onboardingConversation.ts:35`).
- All gate/awaiting handlers, `verify_phone`, `ask_role`, `client_confirm_name`,
  `caregiver_confirm_name` (rewired per 2e), `handleInboundMedia`, permissions flows.
- `onboardingReengagement.ts` (reads step names as cursor labels only — still valid;
  optionally add the missing `caregiver_ask_story` label while there).
- `onboardingCanaryWatch.ts`, absorbers, `onboardingContract.ts` (now the SINGLE source
  of truth — delete the "must stay in sync with legacy" mirror comments).

### Simplify routing
- `shouldRouteOnboardingToLoop` becomes: role valid && step ∈ collection list && hasText
  (media still falls to `handleOnboardingStep` for `handleInboundMedia`; location handled
  by 2a; empty text by 2c). **Remove the `ONBOARDING_AGENT_LOOP` flag check** — loop-only
  must not be revertable by a config typo to a path that no longer exists. Remove
  `ONBOARDING_AGENT_LOOP*` from `featureFlags.ts` and `functions/.env`
  (`isOnboardingAgentLoopEnabled`, cohort pct/phones, `phoneCohortBucket` if unused).
- `handleOnboardingStep`: collection steps no longer have cases — add a defensive
  `default` for any collection-step cursor that reaches it (empty-text nudge from 2c),
  never a crash.
- In-flight sessions mid-collection at deploy time keep working: their cursor values
  remain valid loop-routable steps.

### Docs
- Update CLAUDE.md ("Caregiver Onboarding" section: loop is the sole collection path),
  `context/progress-tracker.md`, and `docs/runbooks/launch-config-baseline.md`
  (flag removed; eval results recorded).

---

## Phase 5 — Deploy + verify

- Deploy from `CareConnecxx-main` only; ROOT `node_modules/.bin/firebase`;
  `FUNCTIONS_DISCOVERY_TIMEOUT` raised; verify env var count intact post-deploy.
  Note: removing `ONBOARDING_AGENT_LOOP*` intentionally changes the env-var count —
  update the recorded baseline (69 → new count) in the runbook as part of this deploy.
- Post-deploy: repeat the Phase 3 live E2E matrix on fresh numbers.
- Watch `cara_turn_metrics` + admin alerts for 48h (re-greet, self-repeat,
  stuck-signup, persistence-net fire rate).

## Rollback story
- Phases 1–2: normal deploy rollback (previous functions build).
- After Phase 4: rollback = redeploy the pre-deletion commit/zip from Phase 0. That is
  the ONLY rollback — which is why Phase 3's gate is mandatory.
