# Spec 2026-07-09-002 — Live-state grounding for ALL awaiting/gate steps (+ stale-nudge cron)

**For:** Opus implementation agent
**From:** Fable session 2026-07-09 (founder-requested follow-up to the bg-check live-fact fix)
**Reference implementation:** `buildLiveBgcheckFact` in `functions/src/agents/onboardingConversation.ts` (~line 4279) — DEPLOY-PENDING code from earlier today; treat it as the pattern AND refactor target.

## Problem

Founder screenshot 2026-07-09: a caregiver at `caregiver_awaiting_bgcheck` asked "Can you tell my background status?" and got a canned "if you've finished the form…" hedge. Root cause: awaiting/gate steps are handled by the scripted path (never the qaAgent tool loop), and their question branch (`answerQuestionMidFlow`) grounds only in **static** `STEP_QUESTION_FACTS` — no per-user live state. We fixed the 3 bg-check steps by injecting a live fact read from Firestore. **Every other awaiting/gate step has the same blind spot**, and the three CLIENT gate steps have *no facts entry at all*. The `staleSessionNudge` cron is worse: its per-step nudges assert states it never checks (e.g. the bg-check nudge says "hasn't finished Checkr's form yet" even if the check already cleared).

## Goal

A caregiver or client who asks "where am I / did it go through / what's my status?" at ANY gate step gets an answer grounded in their actual live state. The stale-nudge cron composes from the same live state and can never assert a state that contradicts Firestore.

## Architecture (required shape)

1. **New module `functions/src/agents/liveGateFacts.ts`** containing:
   - One `buildLive<Gate>Fact` function per gate (specs below). Each returns a `string` — a `"LIVE STATUS RIGHT NOW: …"` fact for the LLM prompt — or `""` (fail-soft; any thrown error must be caught → `console.warn` → `""`).
   - **Move `buildLiveBgcheckFact` here** from onboardingConversation.ts unchanged in behavior (export it; update the two existing call sites).
   - An exported map `LIVE_GATE_FACT_BUILDERS: Record<string, (phone: string, session: AgentSession) => Promise<string>>` keyed by onboarding step, covering every step listed below (a builder may be registered under several step keys).
   - Builders take `(phone, session)` — several need a **fresh `agent_sessions/{phone}` read** (the in-hand session may be stale if a webhook raced the user's question; that race is exactly when a live answer matters most). Do the fresh read inside the builder, fail-soft to the in-hand session.
2. **`answerQuestionMidFlow`** (onboardingConversation.ts ~4318): replace the bgcheck-only `BGCHECK_QUESTION_STEPS` special case with a generic lookup in `LIVE_GATE_FACT_BUILDERS` — if a builder exists for the current step, await it and prepend its output to `stepFacts` exactly as the bgcheck injection does today.
3. **Inline `other`-branch fallbacks**: the `caregiver_awaiting_bgcheck` case already prepends the live fact to its `generateCaraMessage` context (~line 1005). Do the same for the other inline Pattern-A `other` branches (`caregiver_awaiting_photo` ~918, `caregiver_awaiting_documents` ~968, `caregiver_awaiting_stripe` ~1029, `client_awaiting_payment` ~879, `client_awaiting_identity` ~858) and the Pattern-B resend helpers where a stale link would be re-sent after payment already landed (`handleCaregiverResendMembership` ~2236, `handleCaregiverResendMvr` ~2324): if the live fact says the payment/action already completed, the composed message must reflect that instead of nudging them to tap the link again.
4. **`scheduled/staleSessionNudge.ts`**: for each per-step nudge branch, await the step's builder from `LIVE_GATE_FACT_BUILDERS` and prepend the fact to the `generateCaraMessage` `context`. Highest priority: the `caregiver_awaiting_bgcheck` branch (~104–106) currently asserts "hasn't finished Checkr's form yet" unconditionally — after this change the composer must be grounded so a cleared/considered check never gets that copy. Do NOT change which sessions get nudged or the cadence — grounding only.
5. **New `STEP_QUESTION_FACTS` entries** (static process facts; the live fact is prepended on top):
   - `client_send_payment` / `client_awaiting_payment` — derive the money copy from `handleClientSendPayment` (~1859): $29.95/month family membership; do NOT invent amounts, read the real copy/env in the handler.
   - `client_awaiting_identity` — why the identity check exists (Stripe Identity, secure, one-time), what happens after (payment step).
   - `caregiver_send_photo` / `caregiver_awaiting_photo` — why the photo (families see it on their profile), the link Evia sent opens a phone-friendly upload page that returns them to Messages.
   - `caregiver_send_documents` / `caregiver_awaiting_documents` — certifications are optional; they can skip; what happens next (MVR question, membership).
   - `caregiver_send_mvr` / `caregiver_awaiting_mvr` — standalone Approved-Driver add-on; derive price/facts from `handleCaregiverSendMvr` (~2251), do not invent.
   Keep each entry short, factual, money/compliance-accurate — match the tone of the existing `MEMBERSHIP_STEP_FACTS`.

## Per-gate live-fact builders (fields verified against code 2026-07-09)

> ⚠️ **Identity caveat (verified):** `session.caregiverId` is FIRST set at bg-check consent (`confirmBgcheckConsent` ~2657). Builders for membership/photo/documents/MVR-ask MUST NOT read `caregivers/{caregiverId}` — read `agent_sessions/{phone}` (fresh) and `session.onboardingData`. `session.userId` (Auth uid) is set from `handleCaregiverSendPhoto` onward (~2337–2339). For clients, uid lands on `users/{uid}` via `getUserByPhoneNumber` inside `advanceOnboardingStep` — client builders should read the fresh session first and only fall back to `users/{session.userId}` when `session.userId` is set; do NOT call `admin.auth().getUserByPhoneNumber` on the question path.

1. **`buildLiveMembershipFact`** — steps `caregiver_send_membership`, `caregiver_awaiting_membership`, `caregiver_ask_mvr`:
   - Fresh session read. `caregiverSubscriptionId` present → payment LANDED (webhook processed; if `onboardingStep` already advanced, say the payment went through and the next step is under way — the user's session doc may have advanced between inbound and reply). `mvrPaid === true` → MVR add-on paid too.
   - No `caregiverSubscriptionId` but `membershipCheckoutUrl` present → payment not received yet; the checkout link Evia sent is the way (Evia can resend).
   - Neither → the payment link hasn't been minted yet (send-step question before link).
2. **`buildLivePhotoFact`** — `caregiver_send_photo`, `caregiver_awaiting_photo`:
   - Fresh session read. `onboardingData.profilePhoto` present → photo RECEIVED (say so; next is documents).
   - Absent → not received yet; the upload link is the way.
3. **`buildLiveDocumentsFact`** — `caregiver_send_documents`, `caregiver_awaiting_documents`:
   - Fresh session read. `onboardingData.documents` non-empty array → N document(s) received. Absent/empty → none yet; uploading is optional (SKIP allowed).
4. **`buildLiveBgcheckConsentFact`** — `caregiver_awaiting_bgcheck_consent` (ADD; today this step only has static consent facts):
   - If `session.caregiverId` set, read `caregivers/{caregiverId}.backgroundCheckData`: `consentGiven === true` / `checkrCandidateId` present → consent ALREADY submitted, Checkr has emailed their secure completion link (don't re-push the consent page). Else (or `session.bgcheckInviteUrl` absent) → consent page not completed yet.
5. **`buildLiveBgcheckFact`** — `caregiver_send_bgcheck`, `caregiver_awaiting_bgcheck_consent`?, `caregiver_awaiting_bgcheck`: **move as-is** (keep its existing step registrations from `BGCHECK_QUESTION_STEPS`: `caregiver_send_bgcheck`, `caregiver_awaiting_bgcheck_consent`, `caregiver_awaiting_bgcheck`). Where both #4 and #5 apply (`caregiver_awaiting_bgcheck_consent`), run #5 first; if it returns "" fall back to #4 (a single composed builder for that key is fine).
6. **`buildLivePayoutSetupFact`** — `caregiver_send_stripe_connect`, `caregiver_awaiting_stripe`:
   - `session.caregiverId` IS set by now. Read `caregivers/{caregiverId}`: no `stripeAccountId` → setup not started. `stripeAccountId` + `detailsSubmitted !== true` → started but Stripe form not finished (link Evia sent resumes it). `detailsSubmitted === true` + `payoutsEnabled !== true` → Stripe reviewing, nearly there. `stripeOnboardingComplete === true` or `payoutsEnabled === true` → payouts ARE live (daily automatic payouts; free instant payouts) — congratulate, don't nudge.
7. **`buildLiveMvrFact`** — `caregiver_send_mvr`, `caregiver_awaiting_mvr`:
   - Fresh session read. `mvrPaid === true` → MVR payment landed, driving check under way. Else `mvrCheckoutUrl` present → payment link out, not paid yet. Neither → not started.
8. **`buildLiveClientPaymentFact`** — `client_send_payment`, `client_awaiting_payment`:
   - Fresh session read. `stripeSubscriptionId`/`stripeCustomerId` present → membership payment LANDED. Optionally corroborate via `users/{session.userId}.membershipStatus === "active"` when `session.userId` set. Else `onboardingData`/session checkout link state → not paid yet.
9. **`buildLiveClientIdentityFact`** — `client_awaiting_identity`:
   - Fresh session read. `onboardingData.needsIdentityVerification === false` or `onboardingData.identityVerifiedAt` present → identity VERIFIED (next: payment). Corroborate via `users/{session.userId}.identityCheckStatus === "verified"` when available. Else → not verified yet; the secure Stripe Identity link Evia sent is the way.

Fact-string style: start with `"LIVE STATUS RIGHT NOW: "`, ≤ 2 sentences, give the model explicit anti-hedge instructions when state is definitive (mirror the bgcheck builder's "do NOT hedge…" phrasing), and calm no-speculation instructions for review-ish states. Never include raw URLs in the fact (link delivery stays with the existing senders).

## Non-goals / must-NOT

- NO external API calls in builders (no Stripe/Checkr network reads on the question path) — Firestore only.
- Do not change step routing, gate advancement, `resendStuckStep` link re-issue logic, or which sessions the cron nudges.
- Do not touch the qaAgent loop, MCP tools, or collection steps.
- No new env vars, no schema changes, no new Firestore writes (builders are read-only).
- CLAUDE.md rules apply: no keyword/regex intent parsing anywhere; all copy composed via the existing `generateCaraMessage`/`answerQuestionMidFlow` prompts.

## Tests (required, all must pass)

- Extend `agents/__tests__/caraGateWalk.test.ts` following the existing "bg-check status questions are grounded in live backgroundCheckData" describe block: per builder, at least (a) definitive-state injection asserted via the `quickComplete` prompt containing the expected `LIVE STATUS` phrasing, (b) fail-soft (missing doc/fields → static facts only, reply still sent). ⚠️ vitest gotcha (documented in that file): never return a value from `beforeEach` — `beforeEach(() => { vi.mocked(x).mockClear(); })` with braces, or vitest invokes the returned mock as a no-arg cleanup hook.
- New unit tests for `liveGateFacts.ts` builders directly (mock firestore; cover each state branch incl. the fresh-read race: in-hand session stale, fresh doc shows paid).
- `staleSessionNudge` tests: extend the existing suite (find it under `scheduled/`) to assert the bg-check nudge context contains the live fact when the check has cleared (i.e. the "hasn't finished the form" copy can no longer ship ungrounded).
- Gates: `npm --prefix functions run build` (transpile 0 errors); targeted suites (`caraGateWalk`, `onboardingContract`, `handleInbound.routing`, `staleSessionNudge`, new `liveGateFacts`); then FULL `src/agents/` + `src/scheduled/` suites green (baseline today: agents 992 passed / 8 skipped).

## Verification checklist for the implementer

- [ ] `buildLiveBgcheckFact` moved, both original call sites updated, behavior identical (existing 3 caraGateWalk live-fact tests still green unmodified).
- [ ] Every step key in the table in §"Per-gate" registered in `LIVE_GATE_FACT_BUILDERS`.
- [ ] `answerQuestionMidFlow` consults the map generically (no step-name special cases left).
- [ ] Client steps have static facts AND live builders (they had neither).
- [ ] Membership/photo/documents builders never touch `caregivers/{caregiverId}` (not set yet at those steps).
- [ ] Pattern-B resend helpers can't re-push a checkout link when the fresh read says paid.
- [ ] staleSessionNudge branches grounded; no cadence/selection change.
- [ ] All builders fail-soft (throw → warn → "").
