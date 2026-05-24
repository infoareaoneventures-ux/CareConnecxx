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

// Linq management utilities are imported by other modules — not exposed as Cloud Functions

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
export * from './triggers/appointmentUpdated';
export { onCheckinCreated } from './triggers/checkinAlert';
export { triggerFamilyEmergency } from './triggers/familyEmergency';
export { onShiftStatusChanged } from './triggers/shiftStatusTrigger';

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
export { dailyContactCardShare } from './scheduled/dailyContactCardShare';
export { sendMorningBriefings } from './scheduled/morningBriefing';
export { sendStaleSessionNudges } from './scheduled/staleSessionNudge';
export { familySilenceCheckinJob } from './scheduled/familySilenceCheckin';
export { consolidateMemoryNightly } from './scheduled/nightlyMemory';
export { extendRecurringSchedules } from './scheduled/recurringScheduler';
export { upcomingVisitReminder } from './scheduled/upcomingVisitReminder';
export { sendShiftTaskNudges } from './scheduled/shiftTaskNudges';
export { sendPreShiftFamilyCheckin } from './scheduled/preShiftFamilyCheckin';
export { sendDayBeforeShiftReminders } from './scheduled/dayBeforeShiftReminder';
export { sendThirtyMinShiftReminders } from './scheduled/thirtyMinShiftReminder';
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

// CARE PLAN HISTORY trigger (saves version on every care plan write)
export * from './triggers/carePlanHistory';

// AI proxy — secure server-side Anthropic calls (auth-gated, rate-limited)
export { aiProxy } from "./aiProxy";

// MATCH PATTERNS — returns aggregated hire/reject outcome data for frontend Claude prompts
export const getMatchPatterns = functions.https.onCall(async (_data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  }
  const db = admin.firestore();
  const { getOutcomePatternSummary } = await import("./ai/outcomeAnalytics");
  const patterns = await getOutcomePatternSummary(db);
  return { patterns };
});

// JOB MATCH NOTIFICATIONS (daily 10am — texts caregivers about high-match new jobs)
export { sendJobMatchNotifications } from './scheduled/jobMatchNotifications';

// GPS CHECK-IN (callable — validates caregiver arrival within 200m, notifies family)
export { submitGpsCheckin } from './agents/gpsCheckin';

// 1099 TAX NOTIFICATIONS (Jan 31 — notifies eligible caregivers of earnings summary)
export { send1099Notifications } from './scheduled/taxReminder';

// MULTI-SENIOR MIGRATION — run once via HTTP with x-admin-secret header
export * from './migrations/migrateSeniorsToHousehold';

// ── initiateCara — unauthenticated callable: proactively sends Cara's greeting ──
// Called from the web "Continue with Phone" screen so desktop users receive an
// outbound SMS rather than relying on the sms: URI (which silently fails on desktop).
export const initiateCara = functions.https.onCall(async (data) => {
  const phone = (data.phone as string | undefined)?.trim();
  const role  = (data.role  as string | undefined) === "caregiver" ? "caregiver" : "client";

  // Basic E.164 validation (US/CA +1 only for now)
  if (!phone || !/^\+1\d{10}$/.test(phone)) {
    throw new functions.https.HttpsError("invalid-argument", "A valid US/CA phone number is required.");
  }

  const { sendMessage, createChat, getOrCreateSession } = await import("./linq/client");

  const db = admin.firestore();

  const sessionRef  = db.collection("agent_sessions").doc(phone);
  const sessionSnap = await sessionRef.get();

  if (sessionSnap.exists) {
    const existing = sessionSnap.data() as Record<string, unknown>;

    // If the session has userId, it's a known user — try sending to the existing chatId.
    // This avoids creating a new Linq chat (which is slow and can hang).
    // If the existing chatId is stale, the send will fail fast (15s timeout added to axios).
    if (existing.userId && existing.chatId) {
      const greeting = "Hi! I'm Cara, your care assistant. I'm here whenever you need help with your care.";
      const sent = await sendMessage(existing.chatId as string, greeting).then(() => true).catch(() => false);

      if (!sent) {
        // Existing chatId is stale — open a fresh Linq thread.
        const { chat_id } = await createChat(phone, {
          parts: [{ type: "text", value: greeting }],
        });
        await sessionRef.update({ chatId: chat_id });
      }
    } else {
      // Session exists but is missing userId — restore from users collection.
      const userQuery = await db.collection("users").where("phone", "==", phone).limit(1).get();
      if (!userQuery.empty) {
        const userDoc   = userQuery.docs[0];
        const userData  = userDoc.data();
        const userId    = userDoc.id;
        const seniorIds = (userData.seniorIds as string[] | undefined) ?? [];
        const seniorId  = (userData.seniorId  as string | undefined) ?? seniorIds[0] ?? "";

        const greeting = "Hi! I'm Cara, your care assistant. I'm here whenever you need help.";
        // Try sending to current chatId; open fresh chat if it fails.
        const chatId = existing.chatId as string | undefined;
        let finalChatId = chatId ?? "";
        if (chatId) {
          const sent = await sendMessage(chatId, greeting).then(() => true).catch(() => false);
          if (!sent) {
            const { chat_id } = await createChat(phone, { parts: [{ type: "text", value: greeting }] });
            finalChatId = chat_id;
          }
        } else {
          const { chat_id } = await createChat(phone, { parts: [{ type: "text", value: greeting }] });
          finalChatId = chat_id;
        }

        await sessionRef.update({
          chatId:         finalChatId,
          userId,
          seniorId,
          onboardingStep: "complete",
          userType:       (existing.userType as string | undefined) ?? role,
        });
      } else {
        // No user account — just open a fresh Linq chat for onboarding.
        const { chat_id } = await createChat(phone, {
          parts: [{ type: "text", value: "Hi! I'm Cara — your care assistant. I'm here whenever you need me." }],
        });
        await sessionRef.update({ chatId: chat_id, onboardingStep: "ask_role" });
      }
    }
  } else {
    // No session — look up the user's account data to pre-fill and skip re-onboarding.
    const userQuery = await db.collection("users").where("phone", "==", phone).limit(1).get();
    if (!userQuery.empty) {
      const userDoc   = userQuery.docs[0];
      const userData  = userDoc.data();
      const userId    = userDoc.id;
      const seniorIds = (userData.seniorIds as string[] | undefined) ?? [];
      const seniorId  = (userData.seniorId  as string | undefined) ?? seniorIds[0] ?? "";

      const { chat_id } = await createChat(phone, {
        parts: [{ type: "text", value: "Hi! I'm Cara — your care assistant. I'm here whenever you need me." }],
      });

      await sessionRef.set({
        chatId:         chat_id,
        service:        "iMessage",
        phone,
        userType:       role,
        userId,
        seniorId,
        onboardingStep: "complete",
        optedIn:        true,
        optedOut:       false,
        createdAt:      new Date().toISOString(),
      });
    } else {
      // No user account yet — minimal session for fresh onboarding.
      await getOrCreateSession(phone, { userType: role });
    }
  }

  return { success: true };
});

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

