import * as admin from "firebase-admin";
import * as functions from "firebase-functions";

// Initialize Admin globally if not already done
if (!admin.apps.length) {
    admin.initializeApp();
}


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

// Linq Sprint 3 — family group thread
export { createFamilyGroup } from './agents/familyGroupManager';

// Linq Sprint 4 — weekly digest + monthly health trends
export { sendWeeklyDigests, triggerWeeklyDigestNow } from './scheduled/weeklyDigest';
export { sendMonthlyHealthTrends, triggerHealthTrendsNow } from './scheduled/healthTrends';

// Transportation badge evaluation (daily) + on-demand refresh
export { evaluateTransportBadges, refreshTransportBadge } from './scheduled/transportBadge';

// Rolling shift generator (daily) — keeps 1 week of shifts ahead for ongoing bookings
export { generateRollingShifts } from './scheduled/shiftGenerator';

// Cara iMessage pivot — onboarding callables
export { markTaskComplete } from './agents/onboardingAgent';

// Cara scheduled jobs
export { sendMorningBriefings } from './scheduled/morningBriefing';
export { sendStaleSessionNudges } from './scheduled/staleSessionNudge';
export { consolidateMemoryNightly } from './scheduled/nightlyMemory';

// Proactive trigger engine (runs every 5 min)
export { runTriggerEngine } from './triggers/triggerEngine';

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

