import * as admin from "firebase-admin";
import * as functions from "firebase-functions";

// Initialize Admin globally if not already done
if (!admin.apps.length) {
    admin.initializeApp();
}

// BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID, CREDENTIAL_VAULT_KEY are injected
// via Firebase Secret Manager on linqWebhook (runWith secrets). Locally, load from .env.


// STRIPE FUNCTIONS - Payment processing for memberships
export * from './stripe';

// CHECKR - Background check initiation + webhook
export * from './checkr';

// Export Notification Functions
export * from './notifications';

// Export Email Functions
export * from './email';

// Export Push Notification Functions
export * from './pushNotifications';

// CAREGIVER CALLOUT - emergency replacement when caregiver cancels
export * from './caregiverCallout';

// Export SMS Functions
export { sendTestSMS } from './sms';

// INSTANT PAYOUT
export * from './instantPayout';

// STANDARD PAYOUT (free 2-3 day)
export * from './standardPayout';

// STRIPE CONNECT (onboarding + account status)
export * from './stripeConnect';

// STRIPE CONNECT WEBHOOK (account.updated → sync caregiver status)
export * from './stripeConnectWebhook';

// Appointment lifecycle: mark `completed` when scheduled end passes
export * from './appointmentCompletion';

// Export Care Coordinator Matching Functions
export * from './matching';

// Export AI Matching Function
export * from './aiMatching';

// Export Semantic AI Matching Triggers (background Gemini embeddings)
export * from './triggers/aiMatchTriggers';

// Export Job Application Triggers (maintains JobPost.applicantCount)
export * from './triggers/jobApplicationTriggers';

// Export per-shift hours submission / review / payment
export * from './shiftHours';

// Export booking payment-method helpers
export * from './paymentMethods';

// Linq iMessage agent — webhook + user onCreate trigger
export * from './linq/webhooks';
export * from './triggers/userCreated';

// Linq Sprint 2 — proactive care alerts + emergency replacement
export * from './triggers/journalCreated';
export * from './triggers/appointmentUpdated';
export { onCheckinCreated } from './triggers/checkinAlert';
export { triggerFamilyEmergency } from './triggers/familyEmergency';

// Linq Sprint 3 — family group thread
export { createFamilyGroup } from './agents/familyGroupManager';

// Linq Sprint 4 — weekly digest + monthly health trends
export { sendWeeklyDigests, triggerWeeklyDigestNow } from './scheduled/weeklyDigest';
export { sendMonthlyHealthTrends, triggerHealthTrendsNow } from './scheduled/healthTrends';

// Linq proactive — no-visit check-in (daily 9am ET)
export { runNoVisitCheck } from './scheduled/noVisitCheck';

// Transportation badge evaluation (daily) + on-demand refresh
export { evaluateTransportBadges, refreshTransportBadge } from './scheduled/transportBadge';

// Shift generation: instant on acceptance + daily rolling window
export { generateRollingShifts, onBookingAccepted } from './scheduled/shiftGenerator';

// Cara iMessage pivot — onboarding callables
export { markTaskComplete } from './agents/onboardingAgent';

// Cara scheduled jobs
export { sendMorningBriefings } from './scheduled/morningBriefing';
export { sendStaleSessionNudges } from './scheduled/staleSessionNudge';
export { consolidateMemoryNightly } from './scheduled/nightlyMemory';
export { extendRecurringSchedules } from './scheduled/recurringScheduler';
export { upcomingVisitReminder } from './scheduled/upcomingVisitReminder';
export { processDndQueue } from './scheduled/dndQueueProcessor';
export { expirePostVisitFeedback } from './scheduled/feedbackExpiry';
export { checkCaregiverInactivity } from './scheduled/caregiverInactivityCheck';
export { checkBackgroundCheckExpiry } from './scheduled/backgroundCheckExpiry';
export { wellbeingCheckinJob } from './scheduled/wellbeingCheckin';

// Proactive trigger engine (runs every 5 min)
export { runTriggerEngine } from './triggers/triggerEngine';

// Admin alerts API (list, resolve, stats)
export { listAdminAlerts, resolveAdminAlert, getAlertStats } from './adminAlerts';

// Admin alert email notifier (Firestore trigger → admin_email_queue)
export { onAdminAlertCreated } from './triggers/adminAlertNotifier';

// Dispute resolution (Firestore trigger + hourly SLA check)
export { onDisputeCreated, checkDisputeSLAs } from './triggers/disputeResolution';

// Refund auto-processing (executes Stripe refund when status → "approved")
export { onRefundRequestWrite } from './triggers/refundProcessor';

// AI proxy — secure server-side Anthropic calls (auth-gated, rate-limited)
export { aiProxy } from "./aiProxy";

// ── chatWithCara — web callable: routes authenticated web users through qaAgent ─
// Bridges Firebase Auth UID → phone → agent_sessions so web users get the same
// Cara experience (memory, tool use, booking) as Linq iMessage users.
export const chatWithCara = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }

  const uid     = context.auth.uid;
  const message = (data.message as string | undefined)?.trim();
  if (!message) throw new functions.https.HttpsError("invalid-argument", "message is required");

  const db = admin.firestore();

  // Per-user sliding window: max 10 calls per 60 seconds
  const rateRef  = db.collection("rate_limits").doc(`web_${uid}`);
  const rateSnap = await rateRef.get();
  const now      = Date.now();
  const rateData = rateSnap.data() ?? { count: 0, windowStart: now };
  if (rateData.windowStart < now - 60_000) {
    await rateRef.set({ count: 1, windowStart: now });
  } else if ((rateData.count as number) >= 10) {
    return {
      available:   true,
      rateLimited: true,
      reply:       "I'm getting a lot of messages right now — give me a moment before trying again.",
      showMatches: false,
    };
  } else {
    await rateRef.update({ count: admin.firestore.FieldValue.increment(1) });
  }

  // Resolve phone from the user's Firestore doc (populated during onboarding)
  const userSnap = await db.collection("users").doc(uid).get();
  const phone    = userSnap.data()?.phone as string | undefined;
  if (!phone) {
    return { available: false, reply: "Please complete your account setup to chat with Cara." };
  }

  // Load the agent session keyed by phone
  const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
  if (!sessionSnap.exists) {
    return { available: false, reply: "Your Cara account isn't set up yet. Finish onboarding first." };
  }

  const session    = sessionSnap.data()!;
  const userId     = session.userId     as string;
  const seniorId   = session.seniorId   as string;
  const zepThreadId = session.zepThreadId as string | undefined;

  // Collect MCP tool names called during this invocation so we can signal the UI
  const toolsCalled: string[] = [];

  const { runQaAgent } = await import("./agents/qaAgent");
  let reply: string;
  try {
    reply = await runQaAgent({
      text:          message,
      phone,
      chatId:        "",       // no Linq chat for web — skipSend prevents any send attempt
      userId,
      seniorId,
      zepThreadId,
      session,
      skipSend:      true,
      _toolCallsOut: toolsCalled,
      sourceChannel: "[USER]",
    });
  } catch (err) {
    console.error("chatWithCara: qaAgent threw", err);
    throw new functions.https.HttpsError("internal", "Cara is unavailable right now.");
  }

  // Signal the frontend to surface caregiver cards when the matching flow was triggered
  const MATCH_TOOLS = new Set(["find_replacement_caregivers", "request_booking"]);
  const showMatches = toolsCalled.some(t => MATCH_TOOLS.has(t));

  return { available: true, reply, showMatches, toolsCalled };
});

// ── One-time Zep setup: create context template + backfill existing users ─────
// Call once with header x-setup-key: cara-zep-setup-2026, then leave in place
// (subsequent calls are safe — already-initialized users are skipped)
export const zepSetup = functions.https.onRequest(async (req, res) => {
  if (req.headers["x-setup-key"] !== "cara-zep-setup-2026") {
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

