import * as admin from "firebase-admin";
import * as functions from "firebase-functions/v1";
import {
  MEMORY_FINGERPRINT_KEY_NAME,
  MEMORY_FINGERPRINT_KEY_SECRET,
} from "./memory/fingerprintKey";
import { isPhoneAllowed } from "./config/phoneAllowlist";

// Initialize Admin globally if not already done
if (!admin.apps.length) {
    admin.initializeApp();
}

// Webhook payloads from Linq sometimes lack optional fields (message_id is
// absent on certain message.sent / reaction events). Writing those undefined
// values into Firestore throws SYNCHRONOUSLY from validateUserInput, bypassing
// .catch handlers and bubbling up to the webhook's top-level error handler —
// which then ack'd Linq but skipped the qaAgent reply, surfacing as Evia's
// "Give me a few minutes" deflection. Enabling ignoreUndefinedProperties on
// the default Firestore instance silently drops undefined fields instead.
admin.firestore().settings({ ignoreUndefinedProperties: true });

// BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID, CREDENTIAL_VAULT_KEY are injected
// via Firebase Secret Manager on linqWebhook (runWith secrets). Locally, load from .env.


// STRIPE FUNCTIONS - Payment processing for memberships
export * from './stripe';

// ACCOUNT DELETION + RECOVERY (accountDeletion.ts, accountRecovery.ts) - plain
// functions, not Cloud Functions themselves; see accountRecovery.ts's header
// comment. Reached via the account_action_requests Firestore-trigger queue
// below, or directly by Evia's MCP tools.
export { processAccountActionQueue } from './triggers/accountActionQueue';
// Recovery email confirmed at first entry — one write trigger per profile collection (2026-09-20).
export { onUserEmailWrite, onCaregiverEmailWrite } from './triggers/emailConfirmation';

// CHECKR - Background check initiation + webhook
export * from './checkr';

// Shared caregiver profile links (/p/{id}) — per-caregiver OG tags for rich previews
export { caregiverProfileMeta } from './caregiverProfileMeta';

// Onboarding upload pages (/upload/photo|document) — static OG tags so texted
// upload links render as branded rich cards instead of raw token URLs
export { uploadPageMeta } from './uploadPageMeta';

// Branded redirect pages (/verify/{id}, /pay/{id}) — Evia OG card + instant
// forward to the underlying Stripe Identity / Checkout URL
export { linkRedirect } from './linkRedirect';

// Public data source for the shareable /p/{id} caregiver profile page
// (client-side Firestore reads are rules-gated; this serves the safe subset)
export { publicCaregiverProfile } from './publicCaregiverProfile';
export * from './caregiverPublicProjection';
export * from './createVideoInterviewRequest';

// Export Notification Functions
export * from './notifications';

// Export Email Functions
export * from './email';

// Export Push Notification Functions
export * from './pushNotifications';

// CAREGIVER CALLOUT - emergency replacement when caregiver cancels

// Export SMS Functions
export { sendTestSMS } from './sms';

// Linq management utilities are imported by other modules — not exposed as Cloud Functions

// INSTANT PAYOUT (standard payouts are automatic — Stripe daily schedule, no callable)
export * from './instantPayout';

// STRIPE CONNECT (onboarding + account status)
export * from './stripeConnect';
export * from './referralLookup';

// STRIPE CONNECT WEBHOOK (account.updated → sync caregiver status)
export * from './stripeConnectWebhook';

// Appointment lifecycle: mark `completed` when scheduled end passes

// Export Care Coordinator Matching Functions
export * from './matching';

// Export AI Matching Function
export * from './aiMatching';

// Export Semantic AI Matching Triggers (background Gemini embeddings)
export * from './triggers/aiMatchTriggers';

// Export Job Application Triggers (maintains JobPost.applicantCount)
export * from './triggers/jobApplicationTriggers';

// Notification triggers (server-side, replaces client-side notification writes)
export * from './triggers/notificationTriggers';

// Interview call-link enforcement: any video_interviews doc reaching an agreed
// status gets a Meet link generated, delivered, and reminded (covers the web
// scheduling path, which writes Firestore directly)
export * from './triggers/interviewLinkTrigger';

// Export per-shift hours submission / review / payment
export * from './shiftHours';

// Export booking payment-method helpers
export * from './paymentMethods';

// Linq iMessage agent — webhook + user onCreate trigger
export * from './linq/webhooks';
export * from './triggers/userCreated';

// Linq Sprint 2 — proactive care alerts + emergency replacement
export { triggerFamilyEmergency } from './triggers/familyEmergency';
export { recomputeConfidenceScore } from './triggers/confidenceScoreTrigger';
export { projectActivityFeed } from './triggers/projectActivityFeed';
export { projectSwapRequestSummary, projectSwapOfferSummary } from './triggers/projectSwapSummary';

// Linq Sprint 3 — family group thread
export { createFamilyGroup, addFamilyGroupMember } from './agents/familyGroupManager';

// Token-scoped quick-confirm callable (replaces the QuickConfirmPage direct web
// writes to agent_tasks / agent_approvals).

// Linq Sprint 4 — weekly digest + monthly health trends
export { sendWeeklyDigests, triggerWeeklyDigestNow } from './scheduled/weeklyDigest';
export { sendMonthlyHealthTrends, triggerHealthTrendsNow } from './scheduled/healthTrends';

// Linq proactive — no-visit check-in (daily 9am ET)

// Sprint 4 — proactive reflection (hourly, drafts only, admin-review-first)
export { runProactiveReflection, triggerProactiveReflectionNow } from './scheduled/proactiveReflection';
export { sweepExpiredObjectives } from './scheduled/objectiveExpirySweeper';
export { intelligenceCanaryWatch } from './agents/intelligenceCanaryWatch';

// Proactive draft sender — every 5 min; consumes status="approved" drafts the admin reviewed.
export { runProactiveDraftSender, triggerProactiveDraftSendNow, sendApprovedDraftNow } from './scheduled/proactiveDraftSender';
export { reviewProactiveDraft } from './admin/reviewProactiveDraft';

// Transportation badge evaluation (daily) + on-demand refresh
export { evaluateTransportBadges, refreshTransportBadge } from './scheduled/transportBadge';

// Shift generation: instant on acceptance + daily rolling window
export { generateRollingShifts, onBookingAccepted, expireStaleShiftReplacements } from './scheduled/shiftGenerator';

// Evia iMessage pivot — onboarding callables (+ the /stripe-refresh redirect
// that re-mints expired single-use Connect account links)
export { markTaskComplete, uploadOnboardingFile, confirmBgcheckOnboarding, stripeConnectRefresh } from './agents/onboardingAgent';

// Admin invoicing (createInvoice/sendInvoiceEmail were called by the admin
// InvoicingTab but never deployed — this wires the backend up)
export {
  createInvoice,
  generateInvoicePDF,
  sendInvoiceEmail,
  processClientApproval,
  autoApproveInvoice,
  onInvoiceDeleted,
} from './invoicing';

// Evia scheduled jobs
export { dailyContactCardShare } from './scheduled/dailyContactCardShare';
export { sendMorningBriefings } from './scheduled/morningBriefing';
export { sendStaleSessionNudges } from './scheduled/staleSessionNudge';
export { familySilenceCheckinJob } from './scheduled/familySilenceCheckin';
export { consolidateMemoryNightly } from './scheduled/nightlyMemory';
export { memoryOperationWorker } from './scheduled/memoryOperationWorker';
export { wowMomentsDaily } from './scheduled/wowMomentsJob';
export { experimentScorecardWeekly } from './scheduled/experimentScorecard';
export { upcomingVisitReminder } from './scheduled/upcomingVisitReminder';
export { sendShiftTaskNudges } from './scheduled/shiftTaskNudges';
export { sendInShiftUpdates } from './scheduled/inShiftUpdate';
// Grouped family texts for tasks checked off / visit notes during a visit (minute sweep).
export { flushFamilyVisitUpdates } from './scheduled/flushFamilyVisitUpdates';
export { sendDayBeforeShiftReminders } from './scheduled/dayBeforeShiftReminder';
export { sendClientDayBeforeReminders } from './scheduled/clientDayBeforeReminder';
export { sendLocationRequestNudges } from './scheduled/locationRequestNudge';
export { sendThirtyMinShiftReminders } from './scheduled/thirtyMinShiftReminder';
export { processDndQueue } from './scheduled/dndQueueProcessor';
export { drainLinqOutboundQueue } from './scheduled/outboundQueueDrain';
// Agentic-reliability wave (2026-07): alert aging digest, hourly failure-spike
// pager, and learned quiet-hours inference.
export { adminAlertAgingDaily } from './scheduled/adminAlertAging';
export { opsAnomalyWatchHourly } from './scheduled/opsAnomalyWatch';
export { inferActiveHoursWeekly } from './scheduled/inferActiveHours';
export { expirePendingShiftOffers } from './scheduled/shiftOfferExpiry';
export { expireAccountRecoveryRequests } from './scheduled/accountRecoveryExpiry';
export { checkCaregiverInactivity } from './scheduled/caregiverInactivityCheck';
export { sendOnboardingReengagement } from './scheduled/onboardingReengagement';
export { sendPaywallWinback } from './scheduled/paywallWinback';
export { checkBackgroundCheckExpiry } from './scheduled/backgroundCheckExpiry';
export { wellbeingCheckinJob } from './scheduled/wellbeingCheckin';
export { dispatchBillingApprovalNotices } from './billing/approvalNoticeDispatcher';

// Proactive trigger engine (runs every 5 min)
export { runTriggerEngine } from './triggers/triggerEngine';

// Admin alerts API (list, resolve, stats)
export { listAdminAlerts, resolveAdminAlert, getAlertStats } from './adminAlerts';

// Admin execution callables (U3) — admin-gated exception handling
export { admin_review_caregiver_exception, admin_review_document } from './admin/adminCaregiverActions';
export { admin_suspend_user, admin_restore_user } from './admin/adminUserActions';
export { admin_respond_support_ticket, admin_resolve_dispute, admin_review_invoice_exception } from './admin/adminSupportActions';
export { admin_retry_agent_action } from './admin/adminLedgerActions';

// Control Room executable recovery callables (U4) — backend-backed retry,
// replay (high-risk gated by confirm), cancel, assign owner, mark complete.
export { admin_retry_linq_delivery, admin_replay_pending_action, admin_cancel_pending_action, admin_assign_recovery_owner, admin_mark_recovery_complete } from './admin/adminRecoveryActions';

// Admin alert email notifier (Firestore trigger → admin_email_queue)
export { onAdminAlertCreated } from './triggers/adminAlertNotifier';

// Dispute resolution (Firestore trigger + hourly SLA check)


// CARE PLAN HISTORY trigger (saves version on every care plan write)
export * from './triggers/carePlanHistory';

// JOB POST GEOCODING — writes lat/lng back when a job_posts doc has an address but no coords
export { geocodeJobPost } from './triggers/jobPostGeocode';

// CLIENT INTAKE GEOCODING — writes lat/lng to users/{uid} when clientIntakes is saved
export { geocodeClientIntake } from './triggers/clientIntakeGeocode';

// CAREGIVER GEOCODING — re-geocodes lat/lng server-side when address fields change
export { geocodeCaregiverDoc } from './triggers/caregiverGeocode';

// CAREGIVER OPT-OUT MIRROR — denormalizes the real SMS opt-out onto the
// caregiver doc so isCaregiverBookable() (a pure, dependency-free function)
// can see it without a second collection lookup
export { mirrorCaregiverOptOut } from './triggers/caregiverOptOutMirror';

// INTERVIEW ACTION QUEUE — Firestore-trigger workaround (GCP org policy blocks
// new public Cloud Functions) giving the website caregiver-response parity
// with Evia's respond_to_interview_request (accept/decline/propose-a-time)
export { processInterviewActionQueue } from './triggers/interviewActionQueue';

// AI proxy — secure server-side Anthropic calls (auth-gated, rate-limited)
export { aiProxy } from "./aiProxy";

// ADMIN ADVANCE QUEUE — Firestore trigger; avoids the allUsers IAM callable requirement
export { processAdminAdvanceQueue } from './triggers/adminAdvanceQueue';

// RESET ACCOUNT QUEUE — Firestore trigger; wipes all data for a test account
export { processResetAccountQueue } from './triggers/resetAccountQueue';

// MATCH PATTERNS — U7 (plan 2026-07-18-001, R36/KTD14): hired/rejected
// aggregates are restricted to funnel/offline analytics and may not feed
// frontend ranking prompts. The callable keeps its shape (frontend is
// fail-soft on empty patterns) but intentionally returns no outcome data.
export const getMatchPatterns = functions.https.onCall(async (_data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  return { patterns: "" };
});

// JOB MATCH NOTIFICATIONS (daily 10am — texts caregivers about high-match new jobs)
export { sendJobMatchNotifications } from './scheduled/jobMatchNotifications';

// STALE APPLICANT NUDGE (daily 4pm — follows up with families sitting on unreviewed applicants)
export { sendStaleApplicantNudges } from './scheduled/staleApplicantNudge';

// PENDING TIMESHEET NUDGE (daily 5pm — reminds families to approve hours so caregivers get paid)
export { sendPendingTimesheetNudges } from './scheduled/pendingTimesheetNudge';

// INTERVIEW COMPLETION NUDGE (every 15min — asks the family whether a passed, still-"accepted" interview happened)
export { sendInterviewCompletionNudges } from './scheduled/interviewCompletionNudge';

// INTERVIEW FEEDBACK NUDGE (every 15min — asks for the hire/pass decision on a completed interview with none recorded)
export { sendInterviewFeedbackNudges } from './scheduled/interviewFeedbackNudge';

// BOOKING FOLLOW-UP NUDGE (every 15min — a 'strong' fit decision with no real booking started yet gets followed up)
export { sendBookingFollowupNudges } from './scheduled/bookingFollowupNudge';

// FIRST-VISIT ACTIVATION (daily 3pm — offers to help families who onboarded but never booked)
export { sendFirstVisitActivation } from './scheduled/firstVisitActivation';

// GPS CHECK-IN (callable — validates caregiver arrival within 200m, notifies family)
export { submitGpsCheckin } from './agents/gpsCheckin';

// 1099 TAX NOTIFICATIONS (Jan 31 — notifies eligible caregivers of earnings summary)
export { send1099Notifications } from './scheduled/taxReminder';

// MULTI-SENIOR MIGRATION — run once via HTTP with x-admin-secret header
export * from './migrations/migrateSeniorsToHousehold';
export * from './migrations/backfillCaregiverSessionUserIds';
export * from './migrations/linkPhoneProviders';
// Field-parity backfill for pre-2026-07-05 Evia signups (experience/skills/
// hasTransportation/weeklyAvailability on caregivers; recipientName/careTypes/
// schedule on clientIntakes; users.uid) — dry-run first: ?dryRun=1
export * from './migrations/backfillEviaProfileFields';
// Care-services + availability parity (2026-07-09): canonicalize skills/services
// to the webapp checkbox enum, re-derive weeklyAvailability at aligned block
// boundaries, mirror jobType → jobTypes. Dry-run first: ?dryRun=1
export * from './migrations/backfillCaregiverServiceAvailability';
// Identity unification: re-key legacy random-ID caregivers docs to the Auth
// uid + re-point caregiverId child refs — dry-run first: ?dryRun=1
export * from './migrations/rekeyLegacyCaregiverDocs';

// Care-plan consolidation onto canonical care_plans/{clientId} + versions
// subcollection (bug-audit §6.1) — DRY-RUN first: ?apply=true to write.
export * from './migrations/migrateCarePlansToCanonical';

// Web care-plan data (senior_profiles/{uid}/care_plans/default) → canonical
// care_plans/{clientId} (web cutover 2026-07-12). Additive union-merge only,
// legacy doc untouched. DRY-RUN first: ?apply=true to write.
export * from './migrations/consolidateWebCarePlans';

// Caregiver PII → caregivers/{id}/private/background: move legal name / DOB /
// SSN-4 / ZIP off the world-readable parent doc. Dry-run first: ?dryRun=1
export * from './migrations/backfillCaregiverPrivateBackground';

// Caregiver payout fields → caregivers/{id}/private/payout + stripe_accounts
// reverse map. Phase 1 (copy) safe immediately; ?deleteParent=1 only after the
// reader-cutover deploy is verified. Dry-run first: ?dryRun=1
export * from './migrations/backfillCaregiverPayoutPrivate';
export * from './migrations/backfillAppointmentScheduleFields';

// fixAcceptedCounterPay migration already executed — not exported

// ── initiateCara — DEPRECATED no-op stub (do not extend) ──────────────────────
// The original callable proactively sent Evia's greeting SMS from the old web
// "Continue with Phone" screen (PhoneSignupPage). It was removed from source
// when onboarding moved to the inbound-first model (see createWebOnboardingSession
// below), but the deployed v1-initiateCara function kept getting called by stale
// cached PWA clients whose service worker still serves the old bundle — each call
// fired an unauthenticated outbound SMS (an A2P 10DLC / abuse / cost liability).
//
// This stub neutralizes that: it sends NO SMS, writes NOTHING, and returns the same
// { success: true } shape the cached frontend expects so those clients degrade
// gracefully (no errors) instead of triggering outbound traffic. Keeping it in
// source also restores clean `firebase deploy --only functions` (the orphaned
// function no longer aborts the deploy on its deletion prompt).
//
// Once telemetry shows zero invocations for a sustained window (cached clients
// aged out), this export can be removed and the function hard-deleted:
//   firebase functions:delete v1-initiateCara --region us-central1
export const initiateCara = functions.https.onCall(async (data) => {
  const phone = (data?.phone as string | undefined)?.trim();
  console.warn("initiateCara: DEPRECATED no-op invoked by a stale client — no SMS sent", {
    phoneSuffix: phone ? phone.slice(-4) : "none",
  });
  return { success: true, deprecated: true };
});

// ── createWebOnboardingSession — authenticated callable, NEVER sends outbound SMS ──
// Called from /start after the user verifies their phone with Firebase Phone Auth.
// Records role + consent on a TTL'd bridge doc that the LINQ inbound webhook reads
// when the user texts "Hey Evia" — letting us skip the SMS-side OTP step (their phone
// possession is already proven by Firebase) and route them straight into the role-aware
// onboarding flow.
//
// A2P 10DLC posture: zero outbound LINQ traffic until the user initiates with their
// own inbound message. This callable only writes Firestore.
export const createWebOnboardingSession = functions.https.onCall(async (data, context) => {
  // Auth gate — caller must have just completed Firebase Phone Auth so their uid is
  // bound to this phone number. Web flow signs in with signInWithPhoneNumber() before
  // calling this; an unauthenticated request would be a misuse.
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Phone verification required.");
  }

  const phone   = (data.phone   as string | undefined)?.trim();
  const role    = (data.role    as string | undefined) === "caregiver" ? "caregiver" : "client";
  const consent = (data.consentText as string | undefined) ?? "v1.0";
  const referralId = (data.referralId as string | undefined)?.trim();
  const rawName = (data.name as string | undefined) ?? "";
  const cleanStr = (s: string) => Array.from(s)
    .filter((ch) => { const code = ch.charCodeAt(0); return code >= 32 && code !== 127; })
    .join("").replace(/\s+/g, " ").trim().slice(0, 80) || undefined;
  // Keep printable chars only, collapse whitespace, bound length. Empty/blank →
  // undefined so the webhook's name-present check (and the legacy "ask name"
  // fallback) stays clean. Safe to persist and to interpolate into a greeting.
  const name = cleanStr(rawName);
  const firstName = cleanStr((data.firstName as string | undefined) ?? "");
  const lastName  = cleanStr((data.lastName  as string | undefined) ?? "");
  // 2026-09-06: recovery email, now collected on /start itself (parity with
  // Evia's SMS loop, which already requires this field for both roles —
  // onboardingContract.ts). Strip ALL whitespace, not just the ends — mobile
  // keyboard autocomplete (Gboard's "@" suggestion strip especially) can
  // insert a stray space mid-address, which trim() alone never catches.
  // Silently dropped if malformed rather than rejecting the whole signup
  // over a secondary field — the SMS loop still asks again if this is empty.
  const rawEmail = ((data.email as string | undefined) ?? "").replace(/\s+/g, "");
  const email = /^\S+@\S+\.\S+$/.test(rawEmail) ? rawEmail.toLowerCase().slice(0, 254) : undefined;

  if (!phone || !/^\+1\d{10}$/.test(phone)) {
    throw new functions.https.HttpsError("invalid-argument", "A valid US/CA phone number is required.");
  }
  // ALLOWLIST: remove before public launch
  if (!isPhoneAllowed(phone)) {
    throw new functions.https.HttpsError("permission-denied", "Evia is currently in private testing. Your number is not on the access list.");
  }
  if (referralId && !/^[A-Za-z0-9_-]{1,128}$/.test(referralId)) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid referral link.");
  }

  // Caller's Firebase Auth token must have phone_number matching what they're claiming.
  // Without this check, a user could verify their own number and then submit someone
  // else's in the callable payload to grief them. token.phone_number is set by the
  // Firebase Phone Auth provider — not user-controlled.
  const tokenPhone = (context.auth.token.phone_number as string | undefined) ?? "";
  if (tokenPhone !== phone) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Phone number must match the verified token.",
    );
  }

  const db = admin.firestore();

  const now            = new Date();
  const ttlExpireAt    = new Date(now.getTime() + 30 * 60 * 1000); // 30 min — Firestore TTL purges
  const linqPhoneNumber = process.env.LINQ_PHONE_NUMBER ?? "";

  await db.collection("web_onboarding_sessions").doc(phone).set({
    uid:         context.auth.uid,
    role,
    phone,
    consentText: consent,
    ...(name      ? { name }      : {}),
    ...(firstName ? { firstName } : {}),
    ...(lastName  ? { lastName }  : {}),
    ...(email     ? { email }     : {}),
    ...(referralId && role === "caregiver" ? { referralId } : {}),
    status:      "awaiting_inbound",
    createdAt:   admin.firestore.Timestamp.fromDate(now),
    ttlExpireAt: admin.firestore.Timestamp.fromDate(ttlExpireAt),
  }, { merge: true });
  try {
    const userRef = db.collection("users").doc(context.auth.uid);
    const userSnap = await userRef.get();
    const userData = userSnap.exists ? userSnap.data() ?? {} : {};
    const userPatch: Record<string, unknown> = {
      uid:       context.auth.uid,
      phone,
      ...(email ? { email } : {}),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (!userSnap.exists) {
      userPatch.createdAt = admin.firestore.FieldValue.serverTimestamp();
    }
    if (!userData.userType) {
      userPatch.userType = role;
    }
    if (role === "caregiver") {
      // Caregivers stay on one combined `name` field everywhere in the app
      // (profile page, admin, matching) — no separate firstName/lastName.
      if (name) userPatch.name = name;
    } else {
      // Bug fix: this used to always write the COMBINED "First Last" string
      // (`name`) into `firstName`, and never wrote `lastName` at all — the
      // web /start form collects both, but the last name was silently
      // dropped. Prefer the real split fields when the form sent them.
      if (firstName || name) userPatch.firstName = firstName || name;
      if (lastName) userPatch.lastName = lastName;
    }
    await userRef.set(userPatch, { merge: true });
    // Auth displayName backfill: Firebase Phone Auth creates the user with NO
    // displayName, and several webapp surfaces render Auth displayName directly
    // (Settings "Name" row, dashboard greeting) — without this, SMS/web-bridge
    // signups show "—" forever even though the users doc has the name.
    if (name) {
      const authUser = await admin.auth().getUser(context.auth.uid).catch(() => null);
      if (authUser && !authUser.displayName) {
        await admin.auth().updateUser(context.auth.uid, { displayName: name }).catch((err) =>
          console.error("createWebOnboardingSession: displayName backfill failed", {
            uid: context.auth?.uid, err: err instanceof Error ? err.message : String(err),
          }));
      }
    }
  } catch (err) {
    console.error("createWebOnboardingSession: failed to seed users doc", {
      phone,
      role,
      uid: context.auth.uid,
      err: err instanceof Error ? err.message : String(err),
    });
    await db.collection("admin_alerts").add({
      type:      "auth_account_create_failed",
      role,
      phone,
      uid:       context.auth.uid,
      error:     err instanceof Error ? err.message : String(err),
      createdAt: new Date().toISOString(),
      resolved:  false,
      severity:  "high",
    }).catch((alertErr) => {
      console.error("createWebOnboardingSession: failed to write auth_account_create_failed admin alert", {
        phone,
        uid: context.auth?.uid,
        err: alertErr instanceof Error ? alertErr.message : String(alertErr),
      });
    });
  }
  if (referralId && role === "caregiver") {
    const referralRef = db.collection("referrals").doc(referralId);
    const authUid = context.auth.uid;
    let mismatchExpectedPhone: string | null = null;
    // Atomic claim: a generic referral link (no referredPhone) can be opened by
    // many caregivers concurrently. Read-and-claim inside a transaction so only
    // the FIRST signup wins; a link already claimed by a different user is left
    // intact instead of being overwritten by a later concurrent signup.
    await db.runTransaction(async (tx) => {
      const referralSnap = await tx.get(referralRef);
      if (!referralSnap.exists) return;
      const referral = referralSnap.data() ?? {};
      const referredPhone = (referral.referredPhone as string | undefined)?.trim();
      if (referredPhone && referredPhone !== phone) {
        mismatchExpectedPhone = referredPhone;
        return;
      }
      if (referral.referredUserId && referral.referredUserId !== authUid) {
        return; // already claimed by another caregiver
      }
      const terminalStatuses = new Set(["approved", "first_booking_completed", "rejected", "successful"]);
      tx.set(referralRef, {
        status: terminalStatuses.has(String(referral.status ?? "")) ? referral.status : "started",
        referredUserId: authUid,
        signupPhone: phone,
        // Preserve the original claim time — only stamp startedAt on the first
        // claim so a re-opened onboarding session by the same user doesn't reset it.
        startedAt: referral.startedAt ?? admin.firestore.Timestamp.fromDate(now),
        updatedAt: now.toISOString(),
      }, { merge: true });
    });
    if (mismatchExpectedPhone) {
      await db.collection("admin_alerts").add({
        type: "referral_phone_mismatch",
        severity: "medium",
        referralId,
        expectedPhone: mismatchExpectedPhone,
        verifiedPhone: phone,
        userId: authUid,
        createdAt: now.toISOString(),
        resolved: false,
      }).catch((err) => {
        console.error("createWebOnboardingSession: failed to write referral_phone_mismatch admin alert", {
          referralId,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  return {
    success:     true,
    linqPhone:   linqPhoneNumber,
    smsBody:     "Hey Evia",
    expiresInMs: 30 * 60 * 1000,
  };
});

// ── chatWithCara — web callable: routes authenticated web users through qaAgent ─
// Bridges Firebase Auth UID → phone → agent_sessions so web users get the same
// Evia experience (memory, tool use, booking) as Linq iMessage users.
//
// Unified-thread contract (docs/plans/2026-07-02-001-feat-cara-web-chat-phone-login-plan.md):
// rate check → resolve session → onboarding guard → opt-out check → per-phone
// lock → await user-message mirror → agent. With a live Linq chat the agent
// runs WITHOUT skipSend so sendSplit delivers the reply over SMS/iMessage and
// auto-mirrors it into the web thread (one thread everywhere); otherwise
// skipSend returns the reply and we mirror it manually. Rejections before the
// mirror never leave an unanswered user bubble in the web thread.
export const chatWithCara = functions
  .runWith({
    timeoutSeconds: 180,
    secrets: [MEMORY_FINGERPRINT_KEY_SECRET?.name ?? MEMORY_FINGERPRINT_KEY_NAME],
  })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
    }

    const message         = (data.message as string | undefined)?.trim();
    const clientMessageId = (data.clientMessageId as string | undefined)?.trim() || undefined;
    if (!message) throw new functions.https.HttpsError("invalid-argument", "message is required");

    const { handleWebChatTurn, AgentUnavailableError } = await import("./linq/webChat");
    try {
      return await handleWebChatTurn({
        uid:        context.auth.uid,
        tokenPhone: context.auth.token.phone_number as string | undefined,
        message,
        clientMessageId,
      });
    } catch (err) {
      if (err instanceof AgentUnavailableError) {
        throw new functions.https.HttpsError(
          "internal",
          "Evia is unavailable right now.",
          { status: "error", ...(clientMessageId ? { clientMessageId } : {}) },
        );
      }
      throw err;
    }
  });

// ── One-time Zep setup: create context template + backfill existing users ─────
// Gated on MIGRATION_ADMIN_SECRET like every other migration endpoint (the key
// used to be a constant baked into source — anyone reading the repo could
// trigger an unbounded PII push into Zep). Fails closed when the env var is
// unset. (Subsequent calls are safe — already-initialized users are skipped.)
export const zepSetup = functions.https.onRequest(async (req, res) => {
  const setupKey = req.headers["x-setup-key"];
  if (!process.env.MIGRATION_ADMIN_SECRET || setupKey !== process.env.MIGRATION_ADMIN_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const {
    createCaraContextTemplate,
    initializeZepOnFirstContact,
    pushOnboardingDataToZep,
  } = await import("./memory/zepClient");

  const db = admin.firestore();
  const results: { template: boolean; backfilled: number; skipped: number; errors: string[] } = {
    template: false, backfilled: 0, skipped: 0, errors: [],
  };

  // 1. Create eldercare context template
  try {
    await createCaraContextTemplate();
    results.template = true;
  } catch (err) {
    results.errors.push(`template: ${String(err)}`);
  }

  // 2. Backfill every session that lacks a zepThreadId
  const sessions = await db.collection("agent_sessions").get();

  for (const doc of sessions.docs) {
    const session = doc.data();
    const phone   = doc.id;

    if (session.zepThreadId || session.optedOut) {
      results.skipped++;
      continue;
    }

    try {
      await initializeZepOnFirstContact(phone);
      results.backfilled++;

      // Push structured data for fully-onboarded clients
      const d = session.onboardingData ?? {};
      if (session.userType === "client" && d.seniorName) {
        await pushOnboardingDataToZep({
          phone,
          firstName:   (d.firstName   ?? "") as string,
          seniorName:  (d.seniorName  ?? "") as string,
          seniorAge:   d.age          ? Number(d.age)          : undefined,
          conditions:  Array.isArray(d.conditions) ? d.conditions as string[] : undefined,
          careNeeds:   Array.isArray(d.careNeeds)  ? d.careNeeds  as string[] : undefined,
          city:        d.city         as string | undefined,
          relationship: d.relationship as string | undefined,
          daysPerWeek: d.daysPerWeek  ? Number(d.daysPerWeek)  : undefined,
          timeOfDay:   d.timeOfDay    as string | undefined,
        });
      }
    } catch (err) {
      results.errors.push(`${phone}: ${String(err)}`);
    }
  }

  res.json(results);
});


// ── Caregiver booked slots sync ──────────────────────────────────────────────
// Keeps caregiver_booked_slots/{caregiverId} up-to-date whenever a shift
// is created, updated, or deleted. Clients read this lightweight doc (no
// sensitive data) to display availability in the booking modal tooltip.

const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

async function rebuildBookedSlots(caregiverId: string): Promise<void> {
  const db = admin.firestore();
  const snap = await db.collection('shifts')
    .where('caregiverId', '==', caregiverId)
    .where('status', 'in', ['pending', 'scheduled', 'in-progress'])
    .get();

  const slots: Record<string, Array<{ s: number; e: number }>> = {};
  snap.docs.forEach(doc => {
    const shift = doc.data();
    if (!shift.date || !shift.startTime) return;
    const day = DAY_ABBR[new Date(shift.date + 'T12:00:00').getDay()];
    if (!slots[day]) slots[day] = [];
    const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    const s = toMin(shift.startTime);
    const e = shift.endTime ? toMin(shift.endTime) : s + 120;
    slots[day].push({ s, e });
  });

  // Deduplicate recurring shifts with identical time ranges on the same day
  Object.keys(slots).forEach(day => {
    const seen = new Set<string>();
    slots[day] = slots[day].filter(slot => {
      const key = `${slot.s}-${slot.e}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

  await db.collection('caregiver_booked_slots').doc(caregiverId).set({ slots, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
}

export const onShiftWritten = functions.firestore
  .document('shifts/{shiftId}')
  .onWrite(async (change) => {
    const after  = change.after.exists  ? change.after.data()  : null;
    const before = change.before.exists ? change.before.data() : null;
    const caregiverId = (after ?? before)?.caregiverId;
    if (!caregiverId) return;
    // Only rebuild when status or timing changes
    const statusChanged = after?.status !== before?.status;
    const timeChanged   = after?.startTime !== before?.startTime || after?.endTime !== before?.endTime || after?.date !== before?.date;
    if (!statusChanged && !timeChanged && change.after.exists && change.before.exists) return;
    await rebuildBookedSlots(caregiverId);
  });

// ── Caregiver rating aggregation ─────────────────────────────────────────────
// Fires whenever a review is created or deleted. Recalculates the caregiver's
// aggregated rating from all reviews using admin access (bypasses client rules).

export const onReviewWritten = functions.firestore
  .document('reviews/{reviewId}')
  .onWrite(async (change, context) => {
    const after  = change.after.exists  ? change.after.data()  : null;
    const before = change.before.exists ? change.before.data() : null;
    const caregiverId = (after ?? before)?.caregiverId;
    if (!caregiverId) return;

    // U3: new review → notify the caregiver (server-owned; the browser no longer
    // peer-writes this). Idempotent + create-if-absent so a trigger retry
    // converges to one notification. Only on true creation (before absent).
    if (!before && after && after.caregiverId) {
      try {
        const { writeUserNotification } = await import('./notifications/userNotification');
        const stars = typeof after.rating === 'number' ? `${after.rating}-star ` : '';
        await writeUserNotification({
          sourcePath: `reviews/${context.params.reviewId}`,
          eventId: context.eventId,
          recipientId: after.caregiverId,
          transitionType: 'review_created',
          type: 'review_received',
          title: 'New Review',
          body: `${after.clientName || 'A client'} left you a ${stars}review.`,
          data: { reviewId: context.params.reviewId },
        });
      } catch (err) {
        console.error('[onReviewWritten] notification error:', (err as Error)?.name ?? 'Error');
      }
    }

    const db = admin.firestore();
    const snap = await db.collection('reviews')
      .where('caregiverId', '==', caregiverId)
      .get();

    const reviews = snap.docs.map(d => d.data());
    const count = reviews.length;

    if (count === 0) {
      await db.collection('caregivers').doc(caregiverId).update({
        rating: 0, reviewCount: 0,
        fiveStarCount: 0, fourStarCount: 0, threeStarCount: 0, twoStarCount: 0, oneStarCount: 0,
      }).catch(() => {});
      return;
    }

    const avg = reviews.reduce((sum, r) => sum + (r.rating || 0), 0) / count;
    const stars = { fiveStarCount: 0, fourStarCount: 0, threeStarCount: 0, twoStarCount: 0, oneStarCount: 0 };
    reviews.forEach(r => {
      if (r.rating === 5) stars.fiveStarCount++;
      else if (r.rating === 4) stars.fourStarCount++;
      else if (r.rating === 3) stars.threeStarCount++;
      else if (r.rating === 2) stars.twoStarCount++;
      else if (r.rating === 1) stars.oneStarCount++;
    });

    await db.collection('caregivers').doc(caregiverId).update({
      rating: Math.round(avg * 10) / 10,
      reviewCount: count,
      ...stars,
    }).catch(() => {});
  });
