import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { generateCaraMessage } from "../utils/caraMessage";

const db = admin.firestore();

// A caregiver isn't paid until the family approves their hours, so don't let
// these sit — but give the family a day before the first reminder.
export const MIN_AGE_MS = 24 * 60 * 60 * 1000;
// At most one reminder per family per this window.
export const COOLDOWN_MS = 48 * 60 * 60 * 1000;

/** Robustly read a Firestore timestamp field (ISO string, epoch ms, or Timestamp). */
export function toMillis(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") { const n = Date.parse(v); return isNaN(n) ? null : n; }
  if (typeof v === "object") {
    const anyV = v as { toMillis?: () => number; seconds?: number; _seconds?: number };
    if (typeof anyV.toMillis === "function") return anyV.toMillis();
    if (typeof anyV.seconds === "number")  return anyV.seconds * 1000;
    if (typeof anyV._seconds === "number") return anyV._seconds * 1000;
  }
  return null;
}

/**
 * Pure decision: should this family get a pending-timesheet reminder now?
 * Extracted so the freshness + cooldown guard is unit-tested without Firestore.
 */
export function shouldNudgePendingTimesheets(p: {
  count:            number;
  oldestSubmittedMs: number | null;
  lastNudgedMs:     number | null;
  nowMs:            number;
}): boolean {
  if (p.count <= 0) return false;
  if (p.oldestSubmittedMs === null) return false;
  if (p.nowMs - p.oldestSubmittedMs < MIN_AGE_MS) return false;
  if (p.lastNudgedMs !== null && p.nowMs - p.lastNudgedMs < COOLDOWN_MS) return false;
  return true;
}

/**
 * Pending-timesheet reminder. Nothing currently nudges a family sitting on
 * caregiver hours awaiting approval — and the caregiver doesn't get paid until
 * they're approved. This follows up gently, at most once per 48h per family, so
 * pay isn't held up by an unread message.
 *
 * Read-only except the send + a per-family cooldown marker on the session; the
 * nudge does NOT approve anything (approval stays an explicit user action).
 * Mirrors the established scheduled-nudge pattern.
 */
export const sendPendingTimesheetNudges = functions.pubsub
  .schedule("0 17 * * *") // once daily, early evening; DND queueing handled downstream
  .onRun(async () => {
    const nowMs = Date.now();

    // Single-field equality → auto-indexed. Group + sort in memory to avoid a
    // composite index, mirroring staleApplicantNudge.
    const snap = await db.collection("shiftHours")
      .where("status", "==", "pending_client_review")
      .limit(500)
      .get();

    const byClient = new Map<string, admin.firestore.QueryDocumentSnapshot[]>();
    for (const d of snap.docs) {
      // Childcare skip (plan 2026-07-22-002 U8): the SMS timesheet nudge is a
      // senior Evia flow — childcare rows are reviewed in-app/web and their
      // Evia SMS surfaces are U10. Senior rows are unaffected.
      if (d.data().careVertical === "child") continue;
      const clientId = d.data().clientId as string | undefined;
      if (!clientId) continue;
      const arr = byClient.get(clientId);
      if (arr) arr.push(d);
      else byClient.set(clientId, [d]);
    }

    for (const [clientId, docs] of byClient) {
      try {
        const submittedTimes = docs
          .map((d) => toMillis(d.data().submittedAt))
          .filter((n): n is number => n !== null);
        const oldestSubmittedMs = submittedTimes.length ? Math.min(...submittedTimes) : null;

        const sessionQ = await db.collection("agent_sessions")
          .where("userId", "==", clientId)
          .limit(1)
          .get();
        if (sessionQ.empty) continue;
        const sessionDoc  = sessionQ.docs[0];
        const sessionData = sessionDoc.data();
        if (sessionData.optedOut) continue;
        if (sessionData.onboardingStep !== "complete") continue;

        const lastNudgedMs = toMillis(sessionData.pendingTimesheetNudgedAt);

        if (!shouldNudgePendingTimesheets({
          count: docs.length,
          oldestSubmittedMs,
          lastNudgedMs,
          nowMs,
        })) continue;

        const phone = (sessionData.phone ?? sessionDoc.id) as string;

        // Name the oldest timesheet's caregiver + its amount, for a concrete nudge.
        docs.sort((a, b) => (toMillis(a.data().submittedAt) ?? 0) - (toMillis(b.data().submittedAt) ?? 0));
        const oldest = docs[0].data();
        const cgSnap = oldest.caregiverId
          ? await db.collection("caregivers").doc(oldest.caregiverId as string).get().catch(() => null)
          : null;
        const cgName = ((cgSnap?.data()?.name ?? "your caregiver") as string).split(" ")[0] || "your caregiver";
        const amount = typeof oldest.amountCents === "number" ? `$${(oldest.amountCents / 100).toFixed(2)}` : null;
        const dateLabel = (oldest.date as string) ?? "a recent visit";
        const count = docs.length;

        const message = await generateCaraMessage({
          audience: "family",
          context: count === 1
            ? `${cgName}'s hours from ${dateLabel}${amount ? ` (${amount})` : ""} are waiting for the family's approval — and ${cgName} isn't paid until they approve. Gently nudge them to take a look; offer to pull it up. One or two warm sentences, no pressure or guilt.`
            : `The family has ${count} caregiver timesheets waiting for approval (oldest: ${cgName}, ${dateLabel}) — caregivers aren't paid until approved. Gently nudge them to review; offer to pull them up. One or two warm sentences.`,
          fallback: count === 1
            ? `${cgName}'s hours${amount ? ` (${amount})` : ""} are waiting for your OK — approving pays them. Want me to pull it up?`
            : `You've got ${count} timesheets waiting for your OK — approving pays your caregivers. Want me to pull them up?`,
          maxTokens: 100,
        });

        await sendViaInteractionAgent(phone, {
          content:     message,
          urgency:     "standard",
          sourceAgent: "pending_timesheet_nudge",
          canDrop:     true,
        });

        await sessionDoc.ref.update({ pendingTimesheetNudgedAt: new Date().toISOString() }).catch(() => {});
      } catch (err) {
        console.error(`[sendPendingTimesheetNudges] error for client ${clientId}:`, err);
      }
    }
  });
