---
title: "fix: Post-launch bug sweep — billing caps, authz regressions, trigger/notification fan-out"
type: fix
date: 2026-07-13
status: ready
depth: deep
origin: 4-agent parallel bug sweep of main @ 1341792 (this session)
---

# fix: Post-Launch Bug Sweep

## Summary

A 4-agent parallel audit of Evia at `main` @ `1341792` (which already includes the
2026-07-12 launch-blocker wave) surfaced **3 CRITICAL**, **4 HIGH**, and **4 MEDIUM**
defects. Every finding below was re-read against the live source and confirmed. The core
Stripe/webhook/payout rail (signature verification, `claimWebhookEvent` idempotency,
`executeInstantPayout` single-path, refund/reversal transaction) is solid and is **not**
touched by this plan.

The dangerous cluster is a set of **regressions of fixes the launch wave was supposed to
close**: the billing cap (U1/U3) is bypassed by a code path the fix didn't cover, the
caregiver-profile ownership check (U4) was never implemented, and the triple-cancellation
fan-out (U6) still fires through the SMS conversational path. Plus a cross-tenant PHI IDOR
and three auth-hardening gaps in the token/callable layer.

**The single most dangerous finding (B1):** the shift-hours *correction* and
*counter-proposal* flows compute billable hours with an uncapped helper
(`computeTotalHours`) that never calls the billing-policy enforcer. A client can propose a
correction of arbitrary duration; after 24h of caregiver silence `autoAcceptCorrection`
finalizes it and it flows straight into a real off-session Stripe charge. This is the same
vulnerability class U1 closed — it just lives on the correction door, which the fix didn't
touch. **Fix before any additional live payment methods are attached.**

---

## Problem Frame

Evia is a live, non-medical, SMS-first caregiving marketplace: Stripe subscriptions +
Connect payouts, PHI-adjacent data, an agent-native SMS onboarding/servicing loop, and a
parallel MCP agent-tool layer that "mirrors" many web callables. Two structural patterns
explain most of this sweep's findings:

1. **Mirror drift.** The MCP agent tools (`functions/src/mcp/server.ts`) reimplement logic
   that also exists as web callables. Several mirrors have drifted from the canonical
   version — dropping ownership checks (B2), writing the wrong fields (B9), or skipping the
   billing-operation lease reset (B8). Anywhere a tool "mirrors a callable," the two must
   call one shared helper or they *will* diverge.

2. **Enforcement at one door only.** Security/billing invariants were added to the primary
   entry point (submit, initial trigger) but not to the secondary ones (correction/counter,
   the SMS cancel path). B1 and B4 are both "the fix guarded door A; the exploit uses door
   B."

The findings group into three implementation phases below.

---

## Scope Boundaries

**In scope:** all 11 findings (B1–B11), each with a fix, a verification step, and a
regression test where practical.

### Outside this plan
- The core Stripe/webhook/payout rail (verified solid; do not touch).
- Any new feature work or product/positioning decisions.
- The `video_interviews` grace fallbacks and `api.ts` care-plan legacy fallbacks — tracked
  in prior memory with their own removal windows.

### Explicitly deferred follow-ups (noted, not fixed here)
- A shared `resolveShiftBillableAmount()` helper that all six shift-hours write paths call,
  so caps can never be bypassed by a new path again — B1's fix installs cap enforcement on
  every current path, and this helper is the consolidation to prevent recurrence. Fold into
  the B1 work if time allows; otherwise file immediately after.

---

## Severity Ledger

| ID | Sev | Area | File | One-line |
|----|-----|------|------|----------|
| B1 | 🔴 CRITICAL | Billing | `functions/src/shiftHours.ts` | Correction/counter/admin/auto-accept paths charge uncapped amounts (bypass MAX_BILLABLE) |
| B2 | 🔴 CRITICAL | Authz | `functions/src/mcp/server.ts:4429` | `update_caregiver_profile` has no ownership check; can rewrite any caregiver's phone/rate |
| B3 | 🔴 CRITICAL | Authz | `functions/src/aiMatching.ts:24` | `runAiMatching` trusts caller-supplied `matchAssignmentId` — cross-tenant PHI IDOR |
| B4 | 🟠 HIGH | Fan-out | `functions/src/agents/caregiverCancelShiftHandler.ts:298` | SMS caregiver-cancel double-sends family alert + replacement (U6 regression) |
| B5 | 🟠 HIGH | Auth | `functions/src/agents/tokenService.ts:59` | Token signature compared with `!==` (timing side-channel) instead of `timingSafeEqual` |
| B6 | 🟠 HIGH | Authz | `functions/src/sms.ts:307` | `sendTestSMS` has no admin gate; any user can SMS any number |
| B7 | 🟠 HIGH | Fan-out | `functions/src/triggers/triggerEngine.ts:487` | Proactive sends have no claim-before-send; crash/redelivery double-sends |
| B8 | 🟡 MEDIUM | Billing | `functions/src/mcp/server.ts:6446` | `retry_shift_payment` MCP tool omits lease reset → permanently strands payment |
| B9 | 🟡 MEDIUM | Billing | `functions/src/mcp/server.ts:5188` | `review_shift_hours` dispute writes wrong fields → shift stalls forever |
| B10 | 🟡 MEDIUM | Auth | `functions/src/agents/replacementAgent.ts:150`, `triggers/appointmentUpdated.ts:281` | Confirm token minted with `Math.random()` (predictable) |
| B11 | 🟡 MEDIUM | Rules | `firestore.rules:697` | Offline-pay self-confirm rule allows only `cash`; UI writes venmo/zelle → permission-denied |

---

## Phase 1 — Billing integrity (B1, B8, B9, B11)

The billing rail's amount enforcement lives in `evaluateShiftBillingPolicy()`
(`functions/src/billing/shiftBillingPolicy.ts`), which throws `ShiftBillingPolicyError` on
`visit_too_long` (> `MAX_BILLABLE_HOURS_PER_VISIT`, 24h) and `amount_too_high`
(> `MAX_BILLABLE_AMOUNT_CENTS`, $2,500). It is currently called **only** from
`createValidatedShiftHours` (the submit path). Every other path uses the bare
`computeTotalHours()` helper (`shiftHours.ts:42`), which enforces nothing beyond `end > start`.

### B1 — Enforce billing caps on ALL shift-hours write paths 🔴

**Defect.** Five write paths compute billable hours/pay with `computeTotalHours()` + manual
math and never call `evaluateShiftBillingPolicy()`:

- `reviewShiftHours` → `propose_correction` — `shiftHours.ts:287-298` (client-proposed)
- `respondToCorrection` → `counter_propose` — `shiftHours.ts:480-489` (caregiver-proposed)
- `reviewShiftHours` → `accept_counter` — `shiftHours.ts:337-345`
- `adminResolveShiftHours` — `shiftHours.ts:551-557`
- `autoAcceptCorrection` (scheduled) — `shiftHours.ts:712-716` finalizes `proposedGrossPay`
  with no cap and **no admin-review gate regardless of size**

**Failure scenario.** Client calls `reviewShiftHours({action:'propose_correction',
proposedStartTime, proposedEndTime})` with an interval of, e.g., 500 hours. `propose_correction`
stores `proposedGrossPay` uncapped. After 24h caregiver silence, `autoAcceptCorrection`
sets `status:'approved'` with that `grossPay`, `onShiftHoursApproved` fires, and
`processShiftPayment` charges the client's saved card off-session. Symmetrically via
caregiver `counter_propose` → client `accept_counter`.

**Fix.** Route every hours/pay computation on these paths through
`evaluateShiftBillingPolicy()` instead of `computeTotalHours()` + hand-rolled math, using
the shift's booked rate (`shift.payRate`) and the sanitized line-item cents. On a
`ShiftBillingPolicyError`:
- Interactive callables (`reviewShiftHours`, `respondToCorrection`, `adminResolveShiftHours`):
  throw `functions.https.HttpsError('invalid-argument', err.message)` so the proposer sees
  the cap immediately.
- `autoAcceptCorrection` (scheduled, no user present): do **not** finalize/charge. Instead
  set `status:'disputed_admin_review'` (+ a `correctionHistory` entry noting
  `auto_accept_blocked: amount_too_high`) and `notifyAdmins(...)`, matching the fail-closed
  posture of `computeGrossCents`. Never silently charge an over-cap correction.

Concretely, replace each block like:
```ts
const proposedTotalHours = computeTotalHours(proposedStartTime, proposedEndTime);
const proposedBasePay  = Math.round(proposedTotalHours * shift.payRate * 100) / 100;
const proposedGrossPay = Math.round((proposedBasePay + proposedLineItemsTotal) * 100) / 100;
with a call to evaluateShiftBillingPolicy({ startTime, endTime, bookedRateDollars: shift.payRate, approvedLineItemsTotalCents }), then derive the dollar fields from the returned
*Cents values. Preserve requiresExplicitApproval on the doc so large-but-legal
corrections still route to explicit approval rather than auto-accept.

Also carry requiresExplicitApproval into autoAcceptCorrection's guard: like
autoApproveShiftHours already does at shiftHours.ts:669 (if (... shift.requiresExplicitApproval === true) continue;),
autoAcceptCorrection must skip auto-finalizing a correction_proposed shift whose
proposed amount exceeds EXPLICIT_APPROVAL_THRESHOLD_CENTS.

Verification.

Unit test: propose_correction / counter_propose with a 500h interval → HttpsError('invalid-argument'), doc unchanged.
Unit test: autoAcceptCorrection on a doc with over-cap proposedGrossPay → status becomes disputed_admin_review, notifyAdmins called, no grossPay written.
Unit test: a legal 6h correction still finalizes and charges as before (no regression).
Grep guard: grep -n computeTotalHours functions/src/shiftHours.ts — every remaining call site either feeds evaluateShiftBillingPolicy or is display-only.
Follow-up (recommended, same PR if time): extract a single
resolveShiftBillableAmount(shift, {startTime, endTime, lineItems}) used by all six paths
so a future 7th path can't reintroduce the bypass.

B8 — retry_shift_payment MCP tool strands the payment 🟡
Defect. mcp/server.ts:6463 does only
ref.update({ status:"approved", retryCount: ... }). The canonical callable
(retryShiftPayment, shiftHours.ts:636-645) also resets the billing-operation lease:


const generation = Math.max(1, Number(shift.paymentGeneration ?? 1));
await updateShiftPaymentOperation(shiftPaymentOperationKey(appointmentId, generation), 'retry', {
  nextAttemptAt: nowIso(), lastErrorCode: null,
});
await ref.update({ status:'approved', nextPaymentAttemptAt: nowIso(), retryCount: ... });
Failure scenario. Family asks Evia to retry a failed charge inside the 5-min–12h retry
backoff. The tool flips status to approved; onShiftHoursApproved → processShiftPayment
→ claimShiftPaymentOperation refuses the claim (nextAttemptAt > now) and returns a
silent no-op. The doc is now approved (not payment_failed), so the scheduled
retryFailedShiftPayments sweep (queries status == 'payment_failed') never touches it
again, and a second retry_shift_payment fails its own status === 'payment_failed' guard.
Caregiver never paid; unrecoverable without manual admin lease surgery. The tool's response
text ("being retried now") actively misleads.

Fix. Make the MCP tool call the same lease-reset logic as the callable. Best: extract
the callable's body into a shared resetShiftPaymentForRetry(appointmentId) in
shiftHours.ts and have both retryShiftPayment and the MCP tool call it. Minimum: copy
the updateShiftPaymentOperation(... 'retry', { nextAttemptAt: nowIso(), lastErrorCode: null })

nextPaymentAttemptAt writes into the tool before/with the status update.
Verification. Unit test: fail a payment, advance to payment_failed with a future
nextAttemptAt, invoke the MCP tool, assert the billing-operation doc's nextAttemptAt
is reset to ~now and the subsequent processShiftPayment actually claims and charges.

B9 — review_shift_hours MCP dispute writes the wrong fields 🟡
Defect. mcp/server.ts:5198-5203 on decision === "dispute" sets status: "correction_proposed" but writes only correctedHours/disputeReason — never
proposedTotalHours, proposedGrossPay, proposedStartTime/proposedEndTime,
proposedLineItems, or correctionRespondByAt, which are the exact fields the two
consumers of correction_proposed require.

Failure scenario.

autoAcceptCorrection filters .where('correctionRespondByAt','<=',now); a missing field is excluded from the range query, so the shift sits in correction_proposed forever.
If the caregiver accepts via web, respondToCorrection computes Math.round(shift.proposedTotalHours * shift.payRate * 100) where proposedTotalHours is undefined → NaN → computeGrossCents fails closed (no wrong charge) but the shift cycles to requires_admin_review. Caregiver's pay stuck pending manual action.
Fix. Mirror reviewShiftHours's real propose_correction branch
(shiftHours.ts:283-334). On dispute, derive an interval from correctedHours (or require
explicit start/end), run it through evaluateShiftBillingPolicy (see B1), and write
proposedStartTime/proposedEndTime/proposedTotalHours/proposedGrossPay/
proposedLineItems/proposedLineItemsTotal/correctionRespondByAt (now + 24h). Ideally
call the same shared correction helper the callable uses so they can't diverge again.

Verification. Unit test: MCP dispute with correctedHours: 4 → doc has
correctionRespondByAt set and proposedGrossPay computed; autoAcceptCorrection picks it
up after the window and finalizes at the capped amount.

B11 — Offline-payment self-confirm rule only allows cash 🟡
Defect. firestore.rules:697 restricts the caregiver's client-SDK self-confirm update
to resource.data.paymentMethod == 'cash', but the UI button
(components/caregiver/CaregiverPaymentsPage.tsx → shiftHoursService.confirmCashReceived
in services/api.ts:~3887) writes directly via the client SDK and supports
['cash','venmo','zelle'] (matching isOfflinePaymentMethod in
functions/src/billing/paymentMethods.ts).

Failure scenario. Caregiver taps "confirm received" on a Venmo/Zelle shift → Firestore
rejects with permission-denied; the payment can't be marked paid from the UI.

Fix. Broaden the rule's paymentMethod guard to the offline set, keeping every other
constraint (status transition + hasOnly affected-keys) intact:


resource.data.paymentMethod in ['cash', 'venmo', 'zelle'] &&
Confirm during implementation that services/api.ts:confirmCashReceived writes only the 5
whitelisted keys the hasOnly(...) clause permits (status, paidMethod, paidAt,
cashConfirmedAt, updatedAt); if it also writes paidMethod-adjacent fields, reconcile
the affected-keys list. Prefer routing the UI button at the Admin-SDK callable
confirmCashReceived (which already handles all three correctly and bypasses rules) — if
that's a small change, do it instead of loosening the rule, and leave create: if false
and the rule as-is. Decide based on which is the smaller, safer diff at implementation.

Verification. Rules unit test (@firebase/rules-unit-testing): caregiver self-confirm
on a venmo shift in approved status writing only the 5 keys → allowed; writing a 6th key
→ denied; a non-owner → denied.

Phase 2 — Authorization & auth hardening (B2, B3, B5, B6, B10)
B2 — update_caregiver_profile MCP tool has no ownership check 🔴
Defect. mcp/server.ts:4429-4443 takes caregiverId + fields from model-supplied
input and writes db.collection("caregivers").doc(caregiverId).set(patch, {merge:true})
with no acting-phone ownership check and no hourlyRate range clamp — while the adjacent
pause_account/reactivate_account (4445-4476) fail closed:
if (!actingPhone || !ownerPhone || ownerPhone !== actingPhone) return toolError("PERMISSION_DENIED", ...).

Failure scenario. Any caregiver (or a prompt-injected turn) invokes
update_caregiver_profile with another caregiver's caregiverId and rewrites their phone
(the SMS/session identity key → account hijack), bio, city, or an arbitrary/negative/huge
hourlyRate.

Fix. Add the exact fail-closed pattern from pause_account:

Require phone (actingPhone) in the input; load the doc; compare ownerPhone === actingPhone, else PERMISSION_DENIED.
Clamp hourlyRate to a sane numeric range (e.g. 15–150) — reject out-of-range with INVALID_INPUT.
Treat phone as a sensitive field: do not allow the tool to mutate the identity phone at all (drop it from the writable set), or gate it behind an explicit verified phone-change flow. Editing phone via a profile-update tool is the account-takeover vector — remove it from patch.
Verification. Unit test: acting phone ≠ owner phone → PERMISSION_DENIED, no write;
hourlyRate: -5 or 9999 → INVALID_INPUT; a phone field in input is ignored/rejected;
owner updating their own bio still succeeds.

B3 — runAiMatching cross-tenant PHI IDOR 🔴
Defect. aiMatching.ts:24-43 checks only context.auth, then loads and mutates
match_assignments/{matchAssignmentId} (caller-supplied) via the Admin SDK — bypassing the
firestore.rules scoping that restricts match_assignments reads to the owning client or
admin.

Failure scenario. Any authenticated user passes another family's matchAssignmentId
and receives that family's AI match results (reasoning, redFlags, prior-history hints),
overwrites their assignment doc (aiSuggestedMatches, status), and burns a paid Claude
call (cost/DoS).

Fix. After loading the assignment, enforce ownership before any processing/writes:


const isOwner = assignment.clientId === context.auth.uid;
const isAdminUser = await isAdmin(context.auth.uid).catch(() => false);
if (!isOwner && !isAdminUser) {
  throw new functions.https.HttpsError('permission-denied', 'Not your match assignment');
}
Mirror the match_assignments read rule in firestore.rules. Place the check immediately
after assignmentDoc loads (before ensureIntakeEmbedding, the caregiver scan, or any
write).

Verification. Unit/emulator test: caller uid ≠ assignment.clientId and non-admin →
permission-denied, no Claude call, no doc write; owner still runs matching normally.

B5 — Non-constant-time token signature comparison 🟠
Defect. agents/tokenService.ts:59 — if (sig !== expected) return null;. This
verifier is the sole auth factor for markTaskComplete, stripeConnectRefresh,
uploadOnboardingFile, confirmBgcheckOnboarding, and the family-join flow (every
/upload, /bgcheck, /stripe-refresh action).

Fix. Use crypto.timingSafeEqual on equal-length buffers, guarding length first (as
linq/webhooks.ts:93-100 and checkr.ts:150-161 already do):


const sigBuf = Buffer.from(sig);
const expBuf = Buffer.from(expected);
if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
Verification. Unit test: a valid token verifies; a token with a tampered signature byte
returns null; the length-mismatch branch returns null without throwing.

B6 — sendTestSMS has no admin gate 🟠
Defect. sms.ts:307-333 — comment says "admin/test" but the handler only checks
context.auth + rate limit. Any signed-up user can send arbitrary SMS to any number
(harassment/spam, A2P 10DLC compliance, Twilio cost).

Fix. Add await requireAdmin(context.auth.uid); immediately after the auth check
(matching every admin_* callable). Keep the rate limit as defense-in-depth.

Verification. Unit test: non-admin authed caller → permission-denied; admin → sends.

B10 — Confirm token minted with Math.random() 🟡
Defect. agents/replacementAgent.ts:150 and triggers/appointmentUpdated.ts:281:
const confirmToken = Math.random().toString(36).slice(2) + Date.now().toString(36);. This
token is the only auth factor for confirmAgentTask/getAgentTaskByToken (confirming
replacement bookings and appointment changes). Math.random() is a non-cryptographic PRNG
whose state is recoverable from consecutive outputs on a warm instance.

Fix. Mint with a CSPRNG, as utils/linkRedirects.ts:31 already does:


const confirmToken = crypto.randomBytes(16).toString("base64url");
Add import * as crypto from "crypto"; (or reuse the existing import) in both files.

Verification. Grep both files for Math.random → gone; confirm-token round-trip test
(mint → getAgentTaskByToken → confirm) still passes.

Phase 3 — Trigger / notification fan-out (B4, B7)
B4 — SMS caregiver-cancel double-sends alert + replacement 🟠
Defect. U6 made appointmentUpdated.ts the sole owner (among Firestore-trigger
handlers) of the caregiver-cancellation fan-out: its caregiverCancellation branch
(appointmentUpdated.ts:91-116) claims an idempotent operation and runs
handleCaregiverCancellation (family alert + emergency replacement). But
agents/caregiverCancelShiftHandler.ts — the SMS conversational cancel path, wired via
linq/routeIntent.ts and linq/routeCaregiver.ts — writes the appointment with
status:"cancelled", cancelledBy:"caregiver" (:263-270, which trips that trigger) and
also directly sends its own family alert (:308-328) and calls
runEmergencyReplacement() fire-and-forget (:341-354).

Failure scenario. A caregiver cancelling over SMS (the primary path per the loop-only
architecture) produces up to three family messages: the direct alert, the direct
replacement offer (its own agent_tasks doc + confirmToken), and the trigger's separate
replacement offer. Exactly the "triple handler" symptom U6 targeted.

Fix. Make the SMS handler defer the family-facing fan-out to the single trigger owner.
In caregiverCancelShiftHandler.ts:

Keep the caregiver-facing acknowledgment (:284-296) and the appointment write (:263-270) and flow-state cleanup.
Remove the direct family alert (:298-329) and the direct runEmergencyReplacement call (:331-356). handleCaregiverCancellation, fired by the appointment write, is now the sole path that alerts the family and starts replacement.
Confirm that handleCaregiverCancellation sends an equivalent family alert (it does — the
trigger branch is the owner U6 designated); if its alert copy is weaker than the SMS
handler's, port the warmer copy into handleCaregiverCancellation rather than re-adding a
second sender. Preserve the cancellationReason/cancelledByCaregiverId fields the handler
writes so the trigger has full context.

Verification. Emulator/integration test: drive the SMS cancel flow end-to-end; assert
the family receives exactly one alert and exactly one replacement offer
(agent_tasks count == 1) for the appointment; the caregiver still gets their ack.

B7 — runTriggerEngine proactive sends have no claim-before-send 🟠
Defect. triggers/triggerEngine.ts:379-494 sends the message
(sendViaInteractionAgent, and for source:"claude" triggers regenerates the text first)
and only after success writes firedAt (:494). No atomic claim, unlike
claimWebhookEvent/claimVisitFeedback/commitmentTracker.sweepOverdueCommitments. The
query (:334-337) also has no .limit(), and the whole onRun runs the trigger loop plus
several sweeps sequentially in one default-60s budget.

Failure scenario. Function killed (timeout/OOM/deploy) after send but before the
firedAt write, or Pub/Sub redelivers the tick → next run re-fetches the still-firedAt:null
doc and re-sends. The generic outbound dedup only covers a 60s window, and claude-source
triggers regenerate non-hash-matching content, defeating dedup. Result: duplicate
appointment/medication/checkin messages. On a large backlog, the unbounded loop can also
starve the no-show and commitment sweeps in the same invocation.

Fix.

Claim before send. Wrap the per-trigger send in a transaction that claims the doc first — set firedAt (or a firingLeaseUntil + status:"firing") before sendViaInteractionAgent, mirroring claimVisitFeedback. On send failure, release the claim so it retries next tick. This trades a rare missed send for no duplicate sends — the correct bias for reminders. (For health/safety triggers where a missed send is worse than a duplicate, keep send-then-mark but add a short-window content dedup key so a redelivery within ~10 min is suppressed.)
Bound the query. Add .limit(N) (e.g. 100) to :334-337 and let the next tick drain the rest.
(Recommended, can defer) Split the no-show/arrival sweep and the commitment sweeps into their own scheduled functions so a slow trigger loop can't starve them, and give runTriggerEngine an explicit runWith({ timeoutSeconds }) budget.
Verification. Unit test with a mocked send that throws after delivering: assert the
doc is claimed (not re-sendable) and a second runTriggerEngine pass does not re-send.
Unit test: .limit() respected on a >N backlog; remaining docs fire next pass.

Sequencing & Rollout
Phase 1 (billing) first — B1 is the launch-critical off-session-charge bug. B8/B9/B11 are same-area and cheap to include. Ship Phase 1 as its own deploy + smoke test (submit → correction → auto-accept happy path, plus an over-cap rejection).
Phase 2 (authz) — B2/B3/B5/B6/B10 are independent, low-blast-radius edits; batch into one deploy. B2 and B3 are the two exploitable-today items in this phase.
Phase 3 (fan-out) — B4/B7 change proactive/notification behavior; deploy last and watch the pager + agent_alerts_log for a cycle to confirm no missed sends.
Deploy hygiene (per prior memory): deploy from CareConnecxx-main, diff env VALUES
pre-deploy, raise FUNCTIONS_DISCOVERY_TIMEOUT, build with
NODE_OPTIONS=--max-old-space-size=8192. Run vitest in two halves (full suite OOMs). Note
7 drifted live functions may still force targeted functions:v1.NAME deploys — verify drift
status before a full functions deploy.

Test Plan Summary
New unit tests: B1 (3 cases), B8, B9, B2, B3, B5, B6, B7 (2 cases) — colocated with each module's existing *.test.ts.
New rules test: B11 (allow venmo/zelle self-confirm; deny 6th key; deny non-owner).
New integration/emulator test: B4 (single alert + single replacement on SMS cancel).
Grep guards: no computeTotalHours feeding an uncapped charge; no Math.random in the two token sites.
Run both vitest halves + the functions build before each phase deploy.
Out-of-Scope Confirmed-Solid (do not touch)
Stripe/Connect webhook signature verification, claimWebhookEvent/settleWebhookEvent
idempotency, executeInstantPayout single-path guarantee, refund/reversal transaction, the
awaiting-step classifyAwaitingReply/sendAwaitingAck pattern, STOP/opt-out at all layers,
U7 auto-completion date filter, U2 generation-bump webhook handling, and the
America/Los_Angeles timezone utilities.
