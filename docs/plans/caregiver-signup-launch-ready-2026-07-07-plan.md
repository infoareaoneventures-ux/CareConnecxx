# Caregiver Signup — Launch-Ready Plan (2026-07-07)

**Goal:** a caregiver texts Evia, answers questions, gets every link the moment they need it, and ends with a complete, visible profile on the webapp. One flow, no dead ends.

---

## Where things actually stand (verified in code today, after the 07-07 deploy)

**The flow is already ONE flow.** Every signup CTA routes to `/start?role=caregiver` → phone OTP → hands off to Evia over SMS. `/caregiver/apply` redirects into it; the old web wizard is recovery-only. `ONBOARDING_AGENT_LOOP=client,caregiver` at 100% — every caregiver goes through the same agent loop. **Nothing needs deleting at the entry level.** The breakage is inside the one flow, at three specific points:

### Break #1 — the background-check link can NEVER be generated (kills the whole back half)
All three places that mint a Checkr link POST `/v1/invitations` with only `{package, first_name, last_name}`. Checkr requires a **candidate to be created first** (with email) and the invitation to carry `candidate_id`. So the call fails every time in prod → caregiver gets "I hit a snag pulling up your background-check link… I'll text you the moment it's ready" → **and nothing ever retries it.** Worse: because the candidate never comes back, the caregiver doc is never pre-created and the resend/reuse guard never engages — every retry fails identically.

- Broken sites: `handleCaregiverSendBgcheck` (onboardingConversation.ts:2524-2532), `sendBgCheckRenewalLink` (:2632-2636), `sendOnboardingLink` bg-check branch (:2841-2846)
- The correct 2-step pattern already exists in `checkr.ts` `initiateCheckrCandidate` (:128-152) but it's a web-only callable that can't be reused from SMS as-is
- The caregiver's **email is already collected and sitting in the session** (`caregiver_ask_email` → `onboardingData.email`) — it's just never passed to Checkr
- Why our tests never caught it: `onboardingBgcheckReuse.test.ts` mocks the Checkr response with a fake `candidate_id` and **never inspects the request body**

**Why past fixes "didn't hit":** the 07-07 wave fixed real things *around* this (link reuse, START OVER, env-var precedence, Stripe Connect matching) — but not the malformed request itself. Everything downstream of the bg-check (Stripe Connect, activation, profile finalization) is now solid but unreachable.

### Break #2 — the photo link gets promised but never sent
The photo link is only delivered as a side effect of the `send_onboarding_link` tool call. Sometimes the model *narrates* "I'm pulling up your secure photo link — I'll send it here" without calling the tool, and there is **no safety net**: webhooks.ts has a post-turn net that recovers skipped field-saves (:1840-1904) but nothing equivalent for skipped link-sends; the turn-watchdog is actually *cleared by the promise message itself*; the commitment tracker has no "link" kind. The prompt says "confirm after the tool succeeds" but never forbids promising without calling.

### Break #3 — the webapp profile is all-or-nothing
The complete profile (name, photo, experience, skills, rate, availability, bio, languages…) is written to `caregivers/{uid}` **only at the final Stripe Connect step** (onboardingConversation.ts:3388-3471). Until then, everything lives in the agent session doc. A caregiver who stalls anywhere — and today, everyone stalls at the broken bg-check — has **no account data on the webapp at all**. Same class of bug we diagnosed on the client side ("Margaret remembered in chat but not on account").

---

## The plan (in order — each step unblocks the next)

### P0-A · Fix the Checkr call properly (unblocks everything)
1. In `checkr.ts`, extract a plain exported helper `createCheckrInvitation({firstName, lastName, email, zipCode, package})` that does candidate-first → invitation-with-candidate_id, reusing the existing `checkrPost` logic (export it). One implementation, used everywhere.
2. Replace the raw axios POST at all 3 broken sites with the helper, passing `onboardingData.email` (and zip, which is also collected). Keep the existing reuse guard, START OVER clearing, and dry-run guard.
3. **Tests that would have caught this:** assert the actual request bodies — candidate POST includes email, invitation POST includes `candidate_id`. Never mock-away the request shape again.

### P0-B · Links must be sent, not promised
1. Post-turn safety net in webhooks.ts, mirroring the field-save net: qaAgent already tracks `deliveredLinkArtifact` (true only when the tool actually fired). After the turn: if the flow is at a link step (photo / documents / membership / bg-check / payouts) or a quick LLM check says the reply told the user a link is coming, and no link tool fired → **deterministically call `sendOnboardingLink` for the current step ourselves.** The link arrives even when the model flakes.
2. Prompt hardening in qaAgent: an explicit hard rule — never say a link is coming; call `send_onboarding_link` first, then confirm.
3. Close the "I'll text you the moment it's ready" broken promise: when link generation *fails* (any link type), record a `link` commitment in `pending_commitments` so the existing triggerEngine sweep retries the send and escalates to ops if it keeps failing. Today that sentence is a promise with no mechanism behind it.

### P0-C · Profile data lands on the account as it's collected
1. Create the Firebase Auth account + `caregivers/{uid}` doc **as soon as required collection fields are complete** (at the existing gate-handoff point in webhooks.ts), not at bg-check-success or final Stripe step.
2. Merge profile fields onto the doc **incrementally at each gate** (after collection, after photo, after documents, after payment, after bg-check) instead of one giant write at the end. Keep the visibility gates exactly as-is (`status: active` + `onboardingStatus: profile_complete` still only at finalization) — families never see half-finished profiles, but the caregiver's own account is never empty and no data is lost if they pause mid-flow.
3. The finalization write at :3431 stays as the last merge — it already has the web-parity aliases (experience/skills/hasTransportation/weeklyAvailability) right.

### P1 · Hardening (same wave, after P0 is green)
- **Checkr invite expiry:** invitations die after ~7 days; the reuse guard would resend a dead link. Past ~6 days, fall through to a fresh POST and re-point the candidate (the TODO at :2498 — the re-point plumbing already exists).
- **Session-limit-killed audit follow-up:** finish the matching-engine field check (which caregiver doc fields matching requires vs what onboarding persists) once P0-C lands, since incremental persistence changes the answer.

### Verification gate (before we call it launch-ready)
1. `npm --prefix functions run build` + full test suite (expect only the 3 known onboardingReplay failures).
2. Deploy full functions from repo root (`FUNCTIONS_DISCOVERY_TIMEOUT=120`, root `node_modules/.bin/firebase`), verify 69 live env vars intact.
3. **Live end-to-end run on a fresh test number** (reset with `scripts/delete-phone.mjs <phone> --confirm`): complete signup start-to-finish and check every box —
   - [ ] photo link arrives at the photo step (and photo shows on webapp profile)
   - [ ] membership payment link works
   - [ ] **real Checkr background-check link arrives and opens**
   - [ ] Stripe Connect payout link arrives; finishing it activates the caregiver
   - [ ] log into the webapp with that phone → profile shows name, photo, experience, skills, rate, availability, bio
   - [ ] quit mid-flow on a second test number → webapp account still shows everything collected so far
   - [ ] text "send me the background check link again" → same link resent, no duplicate candidate

---

## What we are NOT changing
- Entry points (already one), the agent-loop flow (stays 100%), payment/Stripe Connect plumbing (fixed 07-07 and solid), visibility gates, Checkr package/pricing.
