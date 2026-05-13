import * as admin from "firebase-admin";

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

// Cara iMessage pivot — onboarding callables
export { markTaskComplete } from './agents/onboardingAgent';

// Cara scheduled jobs
export { sendMorningBriefings } from './scheduled/morningBriefing';
export { sendStaleSessionNudges } from './scheduled/staleSessionNudge';
export { consolidateMemoryNightly } from './scheduled/nightlyMemory';

// Proactive trigger engine (runs every 5 min)
export { runTriggerEngine } from './triggers/triggerEngine';

