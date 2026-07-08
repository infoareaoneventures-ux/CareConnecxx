import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendSMS } from "../sms";

// Proactive draft sender — v1
//
// Companion to proactiveReflection.ts. That job creates drafts with
// status="pending_review". A human reviewer (admin UI) inspects and either
// approves → status="approved", rejects → status="rejected", or leaves them
// to expire. This file is the dispatcher: it picks up `status="approved"`
// drafts and sends them via the SMS pipeline, then transitions to "sent" or
// "send_failed".
//
// Lifecycle states (string union — kept in sync with the admin UI):
//   pending_review → approved → sent
//   pending_review → rejected
//   approved → send_failed (transient infra error; admin can retry)
//
// Schedule: every 5 minutes. The pool of approved drafts is small (admin-
// gated), so this cadence is fine. The cron can be tightened if needed.
//
// Send-time guards:
//   - Hard 24h expiry after createdAt — anything older than that is skipped
//     and transitioned to "expired" (admin can recreate by re-running the
//     reflection job manually).
//   - Per-call try/catch around sendSMS so one bad recipient doesn't poison
//     the batch.

const db = admin.firestore();

const MAX_DRAFTS_PER_RUN = 50;
const HARD_EXPIRY_MS     = 24 * 60 * 60 * 1000;

export type ProactiveDraftStatus =
  | "pending_review"
  | "approved"
  | "rejected"
  | "sent"
  | "send_failed"
  | "expired";

interface SendStats {
  scanned:  number;
  sent:     number;
  failed:   number;
  expired:  number;
}

export async function runProactiveDraftSenderPass(): Promise<SendStats> {
  const snap = await db.collection("proactive_drafts")
    .where("status", "==", "approved")
    .orderBy("approvedAt", "asc")
    .limit(MAX_DRAFTS_PER_RUN)
    .get();

  const stats: SendStats = { scanned: 0, sent: 0, failed: 0, expired: 0 };

  for (const doc of snap.docs) {
    stats.scanned += 1;
    const d = doc.data() as {
      phone?:      string;
      draftText?:  string;
      createdAt?:  string;
      userId?:     string;
    };

    if (!d.phone || !d.draftText) {
      // Defensive — should never happen if the reflection job is correct.
      await doc.ref.update({
        status:        "send_failed",
        sendError:     "missing phone or draftText",
        lastAttemptAt: new Date().toISOString(),
      }).catch(() => {});
      stats.failed += 1;
      continue;
    }

    // Hard expiry — don't send 2-day-old reflections.
    const createdMs = d.createdAt ? Date.parse(d.createdAt) : Date.now();
    if (Number.isFinite(createdMs) && Date.now() - createdMs > HARD_EXPIRY_MS) {
      await doc.ref.update({
        status:    "expired",
        expiredAt: new Date().toISOString(),
      }).catch(() => {});
      stats.expired += 1;
      continue;
    }

    // Atomically claim (approved → sent) BEFORE sending so an overlapping pass —
    // the */5 cron racing the admin triggerProactiveDraftSendNow, or racing
    // sendApprovedDraftNow — can't send the same draft twice. Only the
    // transaction that flips status off "approved" wins; the loser skips.
    // Claiming to "sent" up front means a crash between claim and send is a lost
    // nudge (acceptable) rather than a duplicate SMS.
    const claimed = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(doc.ref);
      if (!fresh.exists || fresh.data()?.status !== "approved") return false;
      tx.update(doc.ref, { status: "sent", sentAt: new Date().toISOString() });
      return true;
    }).catch(() => false);
    if (!claimed) continue;

    try {
      const result = await sendSMS({ to: d.phone, message: d.draftText });
      if (result.success) {
        stats.sent += 1;
      } else {
        await doc.ref.update({
          status:        "send_failed",
          sendError:     (result.error ?? "unknown").slice(0, 500),
          lastAttemptAt: new Date().toISOString(),
        });
        stats.failed += 1;
      }
    } catch (err) {
      await doc.ref.update({
        status:        "send_failed",
        sendError:     err instanceof Error ? err.message.slice(0, 500) : "unknown",
        lastAttemptAt: new Date().toISOString(),
      }).catch(() => {});
      stats.failed += 1;
    }

    // Light pacing — Linq has rate limits at the line level; a 200ms gap
    // keeps the burst well under any per-second cap.
    await new Promise((r) => setTimeout(r, 200));
  }

  console.info("proactiveDraftSender.pass", stats);
  return stats;
}

// Every 5 minutes. Approved drafts trickle in via admin reviews, so this
// cadence is plenty.
export const runProactiveDraftSender = functions.pubsub
  .schedule("*/5 * * * *")
  .timeZone("UTC")
  .onRun(() => runProactiveDraftSenderPass());

// Admin-only manual trigger — flushes the queue on demand.
export const triggerProactiveDraftSendNow = functions.https.onCall(async (_, context) => {
  if (!context.auth?.token.admin) {
    throw new functions.https.HttpsError("permission-denied", "Admin only");
  }
  return runProactiveDraftSenderPass();
});

// Admin-only callable to send a single approved draft immediately, skipping
// the cron wait. Updates the same status field the cron sender would.
export const sendApprovedDraftNow = functions.https.onCall(async (data: { draftId?: string }, context) => {
  if (!context.auth?.token.admin) {
    throw new functions.https.HttpsError("permission-denied", "Admin only");
  }
  const draftId = data?.draftId;
  if (!draftId || typeof draftId !== "string") {
    throw new functions.https.HttpsError("invalid-argument", "draftId required");
  }

  const ref  = db.collection("proactive_drafts").doc(draftId);
  // Atomically claim (approved → sent) so this manual send can't race the cron
  // pass and double-send the same draft. Validation happens inside the txn so
  // the status check and the claim are a single atomic step.
  const d = await db.runTransaction(async (tx) => {
    const fresh = await tx.get(ref);
    if (!fresh.exists) {
      throw new functions.https.HttpsError("not-found", `draft ${draftId} not found`);
    }
    const data = fresh.data() as { status?: string; phone?: string; draftText?: string };
    if (data.status !== "approved") {
      throw new functions.https.HttpsError("failed-precondition", `draft status is "${data.status}", must be "approved"`);
    }
    if (!data.phone || !data.draftText) {
      throw new functions.https.HttpsError("failed-precondition", "draft missing phone or draftText");
    }
    tx.update(ref, { status: "sent", sentAt: new Date().toISOString() });
    return data;
  });

  const result = await sendSMS({ to: d.phone!, message: d.draftText! });
  if (result.success) {
    // Already marked "sent" by the claim transaction above.
    return { success: true };
  }
  await ref.update({
    status:        "send_failed",
    sendError:     (result.error ?? "unknown").slice(0, 500),
    lastAttemptAt: new Date().toISOString(),
  });
  return { success: false, error: result.error ?? "send failed" };
});

// Exported for tests.
export const _internal = { runProactiveDraftSenderPass };
