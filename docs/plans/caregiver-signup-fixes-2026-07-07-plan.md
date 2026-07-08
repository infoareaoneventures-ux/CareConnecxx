# Caregiver Signup Fixes — Implementation Plan (2026-07-07)

Source: end-to-end audit of the caregiver SMS signup flow (3-agent trace + manual verification, 2026-07-07).
Overall flow is solid — hardening fixes A–F from `docs/plans/caregiver-signup-hardening-plan.md` are all live.
This plan covers the remaining defects found. Ordered by priority; each item is self-contained.

**Ground rules for the implementer:**
- Follow the Evia AI-agentic rules in `CLAUDE.md` (no regex/keyword intent parsing of free-form SMS text — use `parseWithClaude`; strict YES/NO string checks only where the prompt says "Reply YES or NO").
- Build check: `npm --prefix functions run build`. Tests: `npm --prefix functions test` (and root `npm test -- --run` if you touch web code).
- **Do NOT deploy** as part of this work unless explicitly asked. If asked: deploy from this repo root only, use `node_modules/.bin/firebase` (global CLI not on PATH), set `FUNCTIONS_DISCOVERY_TIMEOUT=60` and verify `functions/.env` still has its complete var set (66+ vars) before any functions deploy — a partial `.env` full deploy wipes live secrets.

---

## P0 — Fix 1: Stripe Connect finalization is a single point of failure

### Problem
Caregiver activation (the `caregivers/{uid}` doc getting `status:"active"`, `onboardingStatus:"profile_complete"`, the celebration message, the permissions flow, and ultimately the profile + login links) happens in `advanceOnboardingStep(phone, "stripe_connect", ...)`. There are two intended triggers:

1. **Client-side:** caregiver's browser returns to `${APP_URL}/done?task=stripe_connect&t=<token>` → `components/pages/GenericSuccessPage.tsx` (lines ~26-36) calls the `v1-markTaskComplete` callable → advances the step.
2. **Server-side:** Stripe Connect webhook `account.updated` with `charges_enabled && payouts_enabled` → `functions/src/stripeConnectWebhook.ts` lines 51-89 → looks up the caregiver and advances the step.

Trigger 2 is **dead during first-time onboarding**: the webhook finds the caregiver via
`db.collection("caregivers").where("stripeAccountId", "==", accountId)` (stripeConnectWebhook.ts:55-58),
but during onboarding `stripeAccountId` is stored **only in the agent session** —
`functions/src/agents/onboardingConversation.ts:2639` (`mergeOnboardingData(phone, { stripeAccountId })` inside `handleCaregiverSendStripeConnect`) and line 2793 (same pattern inside `sendOnboardingLink`'s `caregiver_payouts` branch). The `caregivers` doc only receives `stripeAccountId` at finalization itself (line 3321) — a chicken-and-egg: the webhook that should trigger finalization can only match the caregiver *after* finalization already ran.

Net effect: activation depends 100% on the caregiver's browser hitting `/done` and the callable succeeding. Closed tab, expired token, or a callable error → caregiver is stuck at `caregiver_awaiting_stripe` forever. The `resendStuckStep` nudge only re-sends a fresh onboarding link (confusing — they already completed Connect) and never re-checks account status.

Note: a `caregivers/{uid}` doc DOES already exist at this point in the normal flow — it is pre-created (with `phone` set) by `handleCaregiverSendBgcheck` at onboardingConversation.ts:2504-2530, and `session.caregiverId` holds its doc id. The webhook also reads `phone` off the matched caregiver doc (stripeConnectWebhook.ts:80) to call `advanceOnboardingStep` — the pre-created doc has `phone`, so once matching works, the whole webhook path works.

### Fix
In `handleCaregiverSendStripeConnect` (onboardingConversation.ts:2618-2663), when the Express account id is known (both the newly-created and the reused branch), also merge it onto the caregiver doc so the webhook can match:

```ts
// after accountId is resolved (new or reused):
if (session.caregiverId) {
  await db.collection("caregivers").doc(session.caregiverId)
    .set({ stripeAccountId: accountId, phone }, { merge: true });
}
```

Details:
- Do this write **idempotently** (`set` with `merge: true`) and only when `session.caregiverId` is set. If it's absent (edge case: bgcheck pre-create failed), skip silently — the client-side `/done` → `markTaskComplete` path remains as the fallback, same as today.
- Apply the **same** merge in `sendOnboardingLink`'s `caregiver_payouts` branch (onboardingConversation.ts:~2784-2793), which has the identical create-or-reuse logic — an agent-tool resend must not leave the doc unmatched either.
- Read the fresh session (`session` passed in can be a stale snapshot from `resendStuckStep`); prefer re-reading `session.caregiverId` from Firestore right before the merge, or thread it carefully.

### Also (small, same fix): make `advanceOnboardingStep("stripe_connect", ...)` idempotent against double-fire
With the webhook now able to match, BOTH triggers (webhook + `/done` callable) can fire for the same completion. Check how `advanceOnboardingStep`'s `stripe_connect` case (onboardingConversation.ts:3281+) behaves if the session's `onboardingStep` is already past `caregiver_awaiting_stripe` — if it doesn't already guard on current step, add a guard at the top of the case: if `onboardingStep` is not `caregiver_awaiting_stripe`/`caregiver_send_stripe_connect`, log and return without re-sending celebration messages. (The webhook side already has exactly-once via the `claimWebhookEvent` ledger, but that doesn't dedupe webhook-vs-callable.)

### Optional hardening (P2, only if time permits)
A scheduled sweep (piggyback on `functions/src/scheduled/staleSessionNudge.ts`) that, for sessions stuck at `caregiver_awaiting_stripe` with a known `stripeAccountId`, calls `stripe.accounts.retrieve(accountId)` and — if `charges_enabled && payouts_enabled` — calls `advanceOnboardingStep(phone, "stripe_connect", "")` directly instead of re-sending a new onboarding link. This self-heals any webhook loss.

### Acceptance
- Unit test: simulate `account.updated` (charges+payouts enabled) for an account id that was merged onto a pre-created `caregivers` doc → `advanceOnboardingStep` is called with the caregiver's phone.
- Unit test: double-fire (webhook then callable, or twice) does not send the celebration/activation messages twice.
- `npm --prefix functions run build` clean; existing onboarding tests green.

---

## P1 — Fix 2: `resendStuckStep` mints duplicate Checkr invitations

### Problem
`resendStuckStep` (onboardingConversation.ts:2823-2830), fired by the stale-session nudge for caregivers parked at `caregiver_awaiting_bgcheck`/`caregiver_send_bgcheck`, unconditionally re-calls `handleCaregiverSendBgcheck`, which **always** POSTs a new Checkr `/v1/invitations` (line 2484-2496). The first invitation URL was cached at line 2501 (`session.bgcheckInviteUrl`) precisely so resends could reuse it — `sendOnboardingLink`'s `caregiver_background_check` case does reuse it, but the step handler itself does not. Result: a stalled caregiver gets a second candidate + second invitation; both links are completable → possible duplicate reports/cost and split webhook state (the pre-created caregiver doc holds only the FIRST `checkrCandidateId`, so a report on the second candidate won't match).

### Fix
At the top of `handleCaregiverSendBgcheck` (onboardingConversation.ts:2470), before the Checkr POST:

```ts
const cachedUrl = (session as any).bgcheckInviteUrl as string | undefined;
if (cachedUrl && session.caregiverId) {
  await updateSession(phone, { onboardingStep: "caregiver_awaiting_bgcheck" });
  await sendMessage(chatId, "Here's your background-check link again — takes about 5 minutes:");
  await sendMessage(chatId, { parts: [{ type: "link", value: cachedUrl }] });
  return;
}
```

Details:
- Reuse is safe w.r.t. the MVR package choice: `mvrPaid` is set by the Stripe membership webhook BEFORE the first invite is created, so the cached invite always has the right package.
- Guard on `session.caregiverId` too (means the pre-create succeeded and the candidate id is tracked); if the first attempt failed entirely (`bgcheckInviteUrl` never set), fall through to the existing fresh-POST path — that's the retry working as designed.
- Checkr invitations do expire (default 7 days). If easy, tolerate that: if you want to be thorough, on reuse older than ~6 days fall through to a fresh POST and OVERWRITE `bgcheckInviteUrl` and the caregiver doc's `backgroundCheckData.checkrCandidateId` with the new candidate id so webhook matching stays consistent. If that's too invasive, keep simple reuse and leave a `// TODO expiry` note — duplicate-candidate avoidance is the priority.
- Do NOT touch `sendBgCheckRenewalLink` (line 2559+) — the renewal path is separate and intentionally always mints fresh.

### Acceptance
- Unit test: `resendStuckStep` on a session with `bgcheckInviteUrl` set → no axios POST to Checkr, cached link re-sent, step set to `caregiver_awaiting_bgcheck`.
- Unit test: no cached URL → POST happens exactly once (existing behavior preserved).

---

## P1 — Fix 3: bad-news background-check texts can be silently suppressed

### Problem
In `functions/src/checkr.ts`, the non-clear report branches (`consider` / `suspended` / `disputed`, roughly lines 628-756) notify the caregiver via `sendViaInteractionAgent(...)` with `urgency: "standard"` and `canDrop: true`. `sendViaInteractionAgent` (functions/src/agents/caraAgent.ts, `evaluateProactiveCap` ~lines 223-241) subjects standard-urgency messages to the daily proactive-message cap, and `canDrop: true` allows outright suppression. A caregiver who already hit their daily cap silently never learns their background check needs attention — a compliance-adjacent message class that must always deliver.

### Fix
For every caregiver-facing send in the `consider`/`suspended`/`disputed` branches of `checkr.ts` (find each `sendViaInteractionAgent` call in those branches):
- set `canDrop: false`, and
- set `urgency: "immediate"` (bypasses the proactive cap the same way the renewal-clear message already sets `canDrop: false`).

Leave the admin `admin_alerts` writes in those branches untouched. Leave the `clear` path untouched.

### Acceptance
- Unit test (or extend existing checkr webhook tests): consider/suspended/disputed report → the caregiver notification call carries `canDrop: false` and immediate urgency.

---

## P2 — Minor items (batch these after P0/P1)

### M1. Waitlist dead-end only escapes on exact text
`WAITLISTED_STEP` handling (onboardingConversation.ts:~507-521) re-enters onboarding only on literal `"START OVER"` / `"RESTART"`. A waitlisted caregiver typing "can I try again" or "let me redo this" stays stuck. Per CLAUDE.md rules this should be LLM-classified: keep the exact-match fast path, then add a `parseWithClaude` classification ("does the user want to restart signup / try a different location? → restart | other") and route `restart` the same way. On `other`, keep current behavior (waitlist reminder).

### M2. `CHECKR_API_KEY` vs `CHECKR_KEY` env split
The direct `axios.post` Checkr calls in onboardingConversation.ts (lines ~2493, ~2585, and the MVR handler) read only `process.env.CHECKR_API_KEY`, while `checkr.ts`/`stripe.ts` prefer `CHECKR_KEY`. Unify: at each site read `process.env.CHECKR_KEY || process.env.CHECKR_API_KEY` (matching checkr.ts precedence). No env var changes needed (`.env` populates `CHECKR_API_KEY` today; this is latent-breakage insurance only).

### M3. Mislabeled admin alert after approval
`functions/src/agents/permissionsConversation.ts:330-338` writes `admin_alerts type:"caregiver_pending_review"` AFTER the caregiver is already active/approved. Rename the type to `caregiver_onboarding_complete` (or similar) and adjust the alert copy to say the caregiver finished onboarding, not that review is pending. Check for any dashboard/admin code filtering on the old type string before renaming (`grep caregiver_pending_review` across repo) — if something consumes it, update both sides.

### M4. Stale CLAUDE.md identity paragraph
`CLAUDE.md`, "Caregiver Onboarding" section, "Known follow-up" paragraph still claims Evia writes phone-keyed random-ID caregiver docs with no Auth account. That was fixed (uid-keyed docs + `ensureWebAccount` + `rekeyLegacyCaregiverDocs` migration already run in prod). Rewrite the paragraph to describe the current state: caregivers get a Firebase Auth account at `/start` OTP verify (web path) or at the photo step (cold-SMS path), and `caregivers/{uid}` = `users/{uid}` = Auth uid. Also update `context/progress-tracker.md` if it still lists the identity unification as open.

### M5 (optional, needs product decision — do NOT implement without founder sign-off). Cold-SMS dropout → orphan login
A caregiver who cold-texts the Linq number, abandons before the photo step, then visits `/login` gets a brand-new empty Auth account disconnected from their partial `agent_sessions/{phone}` data. Options: (a) on login, if `users/{uid}` is empty but an `agent_sessions/{phone}` with partial onboarding exists, show a "finish signup by texting Evia" screen instead of the empty dashboard; (b) create the account earlier in the cold-SMS flow (e.g., right after name+location). Flag for founder; skip in this pass.

---

## Verification (whole plan)
1. `npm --prefix functions run build` — clean.
2. `npm --prefix functions test` — green (note: `onboardingReplay` has 3 pre-existing failures unrelated to this work; do not chase them).
3. New tests for Fix 1 webhook matching, Fix 1 double-fire guard, Fix 2 invite reuse, Fix 3 canDrop/urgency.
4. No changes to `firestore.rules`, no new env vars required.
