import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { generateCaraMessage } from "../utils/caraMessage";

const db = admin.firestore();

// ── Data loaders ──────────────────────────────────────────────────────────────

export const EARNED_SHIFT_STATUSES: ReadonlySet<string> = new Set([
  "approved",
  "auto_approved",
  "paid",
]);

// Resolve a shift's gross caregiver pay in cents. The rails disagree on field
// names: in-app submitShiftHours writes grossPay (dollars); the Evia MCP and
// care-notes rails write amountCents. Mirror processShiftPayment's resolution
// and never return a non-finite or negative value.
export function shiftGrossCents(shift: any): number {
  const cents =
    typeof shift?.grossPay === "number"      ? shift.grossPay * 100
    : typeof shift?.amountCents === "number" ? shift.amountCents
    : Number(shift?.finalTotalHours ?? shift?.submittedTotalHours ?? 0) *
      Number(shift?.payRate ?? shift?.hourlyRate ?? 0) * 100;
  return Number.isFinite(cents) && cents > 0 ? Math.round(cents) : 0;
}

// True when an earned shift falls in the digest window. submittedAt is written
// by every rail; createdAt is a fallback. ISO strings compare lexicographically.
export function isShiftEarnedSince(shift: any, sinceIso: string): boolean {
  if (!EARNED_SHIFT_STATUSES.has(shift?.status)) return false;
  const ts = (shift?.submittedAt ?? shift?.createdAt ?? "") as string;
  return ts >= sinceIso;
}

// ── Core logic (shared by scheduled + manual trigger) ────────────────────────

// Process work in bounded-concurrency batches instead of one-at-a-time. The old
// sequential loop (one user per iteration, each awaiting a Claude call + several
// Firestore reads + a 200ms sleep) grows linearly and breaches the Cloud
// Function deadline at a few hundred users. Returns the count of items that the
// callback reported as sent (true). Per-item failures are isolated by the
// callback's own try/catch and counted as not-sent.
const DIGEST_BATCH_SIZE = 15;

async function runInBatches<T>(items: T[], size: number, fn: (item: T) => Promise<boolean>): Promise<number> {
  let sent = 0;
  for (let i = 0; i < items.length; i += size) {
    const results = await Promise.allSettled(items.slice(i, i + size).map(fn));
    sent += results.filter(r => r.status === "fulfilled" && r.value === true).length;
  }
  return sent;
}

// Send one client's weekly care digest. Returns true when a digest was sent.
export async function runWeeklyDigests(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);

  // 2026-09-20 (founder): the FAMILY digest was removed — Evia-only, no site
  // counterpart, and every visit already reaches the family as it happens
  // (start, tasks, notes, recap, hours). The caregiver earnings summary below
  // stays for the caregiver pass.
  // ── Caregiver earnings summaries ─────────────────────────────────────────────
  const cgSessionsSnap = await db
    .collection("agent_sessions")
    .where("userType",  "==", "caregiver")
    .where("optedOut",  "==", false)
    .get();

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const cgSent = await runInBatches(cgSessionsSnap.docs, DIGEST_BATCH_SIZE, (doc) =>
    sendCaregiverEarnings(doc, weekAgo, today).catch((err) => {
      console.error(`caregiver earnings digest error for ${doc.id}:`, err);
      return false;
    }),
  );

  console.log(`weeklyDigest: sent ${cgSent} caregiver earnings digests`);
  return cgSent;
}

// Send one caregiver's weekly earnings summary. Returns true when sent.
async function sendCaregiverEarnings(cgDoc: any, weekAgo: string, today: string): Promise<boolean> {
  const cgSession = cgDoc.data();
  if (!cgSession.caregiverId || cgSession.optedIn === false) return false;

  const cgPhone = cgDoc.id;
  // Successful visits bill through shiftHours now (visit_payments is retired
  // for them). Query by caregiver only — no composite index required — then
  // filter to "earned this week" in memory via the shared helpers.
  const shiftSnap = await db
    .collection("shiftHours")
    .where("caregiverId", "==", cgSession.caregiverId)
    .get();

  const visits = shiftSnap.docs
    .map(d => d.data())
    .filter(v => isShiftEarnedSince(v, weekAgo));

  if (visits.length === 0) return false;

  const totalCents = visits.reduce((s, v) => s + shiftGrossCents(v), 0);
  const totalStr = `$${(totalCents / 100).toFixed(2)}`;
  const cgSnap   = await db.collection("caregivers").doc(cgSession.caregiverId).get();
  const cgName   = (cgSnap.data()?.name as string | undefined)?.split(" ")[0] ?? "there";

  const visitLines = visits.slice(0, 5).map(v =>
    `· ${v.date ?? (v.submittedAt as string | undefined)?.slice(0, 10) ?? "this week"} — $${(shiftGrossCents(v) / 100).toFixed(2)}`
  ).join("\n");

  const earningsMsg = await generateCaraMessage({
    audience: "caregiver",
    context:
      `Caregiver first name: ${cgName}. ` +
      `This week's earnings summary: ${visits.length} visit${visits.length !== 1 ? "s" : ""}, ${totalStr} total, on its way. ` +
      `Visit breakdown:\n${visitLines}\n` +
      "Write a warm morning earnings summary. Express genuine appreciation for the work they do for these families. " +
      "Mention that payments hit within 2 business days.",
    fallback:
      `Morning ${cgName}. ${visits.length} visit${visits.length !== 1 ? "s" : ""} this week, ${totalStr} on its way to you.\n\n` +
      `${visitLines}\n\n` +
      `That's real work. Thank you for taking care of these families.\n\n` +
      `Payments hit within 2 business days.`,
  });

  await sendViaInteractionAgent(cgPhone, {
    content:     earningsMsg,
    urgency:     "standard",
    sourceAgent: "weekly_digest",
    canDrop:     true,
  });

  await db.collection("weekly_digests").doc(`cg_${cgSession.caregiverId}_${today}`).set({
    caregiverId: cgSession.caregiverId,
    phone:       cgPhone,
    sentAt:      new Date().toISOString(),
    totalCents,
    visitCount:  visits.length,
  });
  return true;
}

// ── Scheduled function — every Sunday at 8am ET (caregiver earnings only since 2026-09-20) ───────────────────────────────

export const sendWeeklyDigests = functions.pubsub
  .schedule("0 13 * * 0") // 8am ET = 13:00 UTC
  .timeZone("UTC")
  .onRun(() => runWeeklyDigests());

// ── Manual trigger for testing (admin only) ───────────────────────────────────

export const triggerWeeklyDigestNow = functions.https.onCall(async (_, context) => {
  if (!context.auth?.token.admin) {
    throw new functions.https.HttpsError("permission-denied", "Admin only");
  }
  const sent = await runWeeklyDigests();
  return { sent };
});
