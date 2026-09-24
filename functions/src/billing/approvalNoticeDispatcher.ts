import * as admin from "firebase-admin";
import * as functions from "firebase-functions";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { buildApprovalNoticeText, ApprovalNoticePayload } from "./approvalNoticeText";

const db = admin.firestore();
const LEASE_MS = 2 * 60 * 1000;
const DELIVERY_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;

type OutboxState = "pending" | "retry" | "processing" | "sent" | "delivered" | "requires_admin_review";

interface ApprovalOutboxRecord {
  appointmentId: string;
  recipientUid: string;
  payloadSnapshot?: ApprovalNoticePayload;
  state: OutboxState;
  attemptCount?: number;
  nextAttemptAt?: string | null;
  leaseExpiresAt?: string | null;
}

function retryAt(attemptCount: number, nowMs = Date.now()): string {
  const delaysMinutes = [1, 5, 15, 60, 240];
  const delay = delaysMinutes[Math.min(Math.max(attemptCount - 1, 0), delaysMinutes.length - 1)];
  return new Date(nowMs + delay * 60 * 1000).toISOString();
}

async function resolveRecipientPhone(recipientUid: string): Promise<string | null> {
  const userSnap = await db.collection("users").doc(recipientUid).get();
  const userPhone = userSnap.data()?.phone;
  if (typeof userPhone === "string" && userPhone) return userPhone;

  const sessionSnap = await db.collection("agent_sessions")
    .where("userId", "==", recipientUid)
    .limit(1)
    .get();
  return sessionSnap.empty ? null : sessionSnap.docs[0].id;
}

async function claimOutbox(outboxId: string, workerId: string): Promise<ApprovalOutboxRecord | null> {
  const ref = db.collection("billingApprovalOutbox").doc(outboxId);
  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) return null;
    const record = snap.data() as ApprovalOutboxRecord;
    const now = Date.now();
    const nextAttempt = record.nextAttemptAt ? Date.parse(record.nextAttemptAt) : 0;
    const leaseExpiry = record.leaseExpiresAt ? Date.parse(record.leaseExpiresAt) : 0;
    const claimableState = record.state === "pending" || record.state === "retry";
    if (!claimableState || nextAttempt > now || leaseExpiry > now) return null;

    const updatedAt = new Date(now).toISOString();
    transaction.update(ref, {
      state: "processing",
      attemptCount: Number(record.attemptCount ?? 0) + 1,
      leaseOwner: workerId,
      leaseExpiresAt: new Date(now + LEASE_MS).toISOString(),
      updatedAt,
    });
    return { ...record, state: "processing", attemptCount: Number(record.attemptCount ?? 0) + 1 };
  });
}

async function moveToRetryOrReview(outboxId: string, errorCode: string): Promise<void> {
  const outboxRef = db.collection("billingApprovalOutbox").doc(outboxId);
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(outboxRef);
    if (!snap.exists) return;
    const record = snap.data() as ApprovalOutboxRecord;
    if (record.state === "delivered") return;

    const attemptCount = Number(record.attemptCount ?? 0);
    const terminal = attemptCount >= MAX_ATTEMPTS;
    const now = new Date().toISOString();
    transaction.update(outboxRef, {
      state: terminal ? "requires_admin_review" : "retry",
      nextAttemptAt: terminal ? null : retryAt(attemptCount),
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: errorCode.slice(0, 100),
      updatedAt: now,
    });
    if (terminal) {
      transaction.update(db.collection("shiftHours").doc(record.appointmentId), {
        status: "requires_admin_review",
        approvalNoticeState: "failed",
        autoApproveAt: null,
        updatedAt: now,
      });
    }
  });
}

// Terminal, no send: the family has already acted on (or the system has already
// resolved) this timesheet, or the transport accepted the text but can never
// confirm delivery. Either way there is nothing left for this notice to do.
async function closeOutbox(outboxId: string, appointmentId: string, providerStatus: "superseded" | "assumed_delivered"): Promise<void> {
  const now = new Date().toISOString();
  const outboxRef = db.collection("billingApprovalOutbox").doc(outboxId);
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(outboxRef);
    if (!snap.exists || snap.data()?.state === "delivered") return;
    transaction.update(outboxRef, {
      state: "delivered", providerStatus, completedAt: now, nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null, updatedAt: now,
    });
    transaction.update(db.collection("shiftHours").doc(appointmentId), {
      approvalNoticeState: "delivered", approvalNoticeDeliveredAt: now, updatedAt: now,
    });
  });
}

export async function dispatchApprovalNotice(outboxId: string, workerId: string): Promise<boolean> {
  const record = await claimOutbox(outboxId, workerId);
  if (!record) return false;
  // 2026-09-18 (live-caught): the family had already sent a correction, yet the
  // same "submitted hours — reply APPROVE" notice went out a second time a day
  // later (see the receipt-timeout note in processApprovalNoticeOutbox). A notice
  // only exists while the timesheet is waiting on the family; once it is not,
  // the notice is done — never re-sent, on any retry path.
  const shiftSnap = await db.collection("shiftHours").doc(record.appointmentId).get().catch(() => null);
  if (shiftSnap?.exists && shiftSnap.data()?.status !== "pending_client_review") {
    await closeOutbox(outboxId, record.appointmentId, "superseded");
    return false;
  }

  const phone = await resolveRecipientPhone(record.recipientUid);
  if (!phone) {
    await moveToRetryOrReview(outboxId, "recipient_phone_not_found");
    return false;
  }

  // The Timesheets card in words (approvalNoticeText.ts) — the family reads the
  // same facts over text that the page shows: clock in/out, duration, scheduled
  // window, rate, base pay, charges, total, and the auto-approve time (or why not).
  const payload = record.payloadSnapshot ?? {};
  const content = buildApprovalNoticeText(payload);
  // Kept on the session for the APPROVE / DISPUTE keyword reply (routeClient.ts).
  const caregiverName = payload.caregiverName ?? "Your caregiver";
  const amount = (Number(payload.grossPayCents ?? 0) / 100).toFixed(2);
  const providerMessageIds: string[] = [];

  try {
    const sent = await sendViaInteractionAgent(phone, {
      content,
      urgency: "standard",
      sourceAgent: "billing_approval_notice",
      canDrop: false,
      preferredService: "SMS",
      // This outbox already owns its own idempotent retry schedule (below) —
      // a transport failure must throw back to it (caught below, see
      // moveToRetryOrReview) rather than also get dead-lettered into Linq's
      // own generic redelivery queue, which would send this notice twice.
      noQueueOnFailure: true,
      onTransportReceipt: (messageId) => { providerMessageIds.push(messageId); },
    });
    if (!sent) {
      // sendViaInteractionAgent only returns false for a genuine non-send
      // (opted out, no session, content-hash duplicate) — noQueueOnFailure
      // means a real transport failure throws instead (caught below). It
      // does NOT mean "sent but no receipt" — Linq's response occasionally
      // omits message_id on an otherwise-successful, delivered send, and
      // treating that as a failure caused this same notice to be resent on
      // the retry schedule below even though the family already got it.
      await moveToRetryOrReview(outboxId, "message_suppressed");
      return false;
    }

    const providerMessageId = providerMessageIds[0] ?? null;
    const now = new Date().toISOString();
    const outboxRef = db.collection("billingApprovalOutbox").doc(outboxId);
    await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(outboxRef);
      if (!snap.exists || snap.data()?.state !== "processing") return;
      transaction.update(outboxRef, {
        state: "sent",
        providerMessageId,
        providerOperationId: providerMessageId,
        providerStatus: "sent",
        nextAttemptAt: new Date(Date.now() + DELIVERY_TIMEOUT_MS).toISOString(),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        updatedAt: now,
      });
      transaction.update(db.collection("shiftHours").doc(record.appointmentId), {
        approvalNoticeState: "sent",
        updatedAt: now,
      });
      // The bell beside the text (routes to Timesheets). Deterministic id so a
      // re-send after a transport failure overwrites rather than duplicates.
      transaction.set(
        db.collection("users").doc(record.recipientUid).collection("notifications")
          .doc(`shift_hours_submitted:${record.appointmentId}`),
        {
          userId: record.recipientUid,
          type: "shift_hours_submitted",
          title: "Hours submitted for your review",
          body: `${caregiverName} submitted hours — $${amount}. Review and approve on your Timesheets page.`,
          data: { appointmentId: record.appointmentId },
          isRead: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      );
      transaction.set(db.collection("agent_sessions").doc(phone), {
        pendingShiftApproval: {
          appointmentId: record.appointmentId,
          amount,
          caregiverName,
        },
        pendingShiftApprovalSetAt: now,
      }, { merge: true });
    });
    return true;
  } catch (error) {
    await moveToRetryOrReview(outboxId, error instanceof Error ? error.name : "send_failed");
    return false;
  }
}

export async function recordApprovalNoticeProviderStatus(
  providerMessageId: string,
  status: "delivered" | "failed",
  errorCode?: string,
): Promise<boolean> {
  const snap = await db.collection("billingApprovalOutbox")
    .where("providerMessageId", "==", providerMessageId)
    .limit(1)
    .get();
  if (snap.empty) return false;

  const outboxDoc = snap.docs[0];
  if (status === "failed") {
    await moveToRetryOrReview(outboxDoc.id, errorCode ?? "provider_delivery_failed");
    return true;
  }

  const now = new Date().toISOString();
  await db.runTransaction(async (transaction) => {
    const current = await transaction.get(outboxDoc.ref);
    if (!current.exists || current.data()?.state === "delivered") return;
    const record = current.data() as ApprovalOutboxRecord;
    transaction.update(outboxDoc.ref, {
      state: "delivered",
      providerStatus: "delivered",
      completedAt: now,
      nextAttemptAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: now,
    });
    transaction.update(db.collection("shiftHours").doc(record.appointmentId), {
      approvalNoticeState: "delivered",
      approvalNoticeDeliveredAt: now,
      updatedAt: now,
    });
  });
  return true;
}

export async function processApprovalNoticeOutbox(): Promise<{ attempted: number; sent: number }> {
  const now = new Date().toISOString();
  const workerId = `approval-notice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ready = await db.collection("billingApprovalOutbox")
    .where("state", "in", ["pending", "retry"])
    .where("nextAttemptAt", "<=", now)
    .orderBy("nextAttemptAt", "asc")
    .limit(20)
    .get();

  let sent = 0;
  for (const doc of ready.docs) {
    if (await dispatchApprovalNotice(doc.id, workerId)) sent += 1;
  }

  // "sent" with no delivery receipt after 24h. This used to go back to retry and
  // RE-SEND the notice (2026-09-18, live: the transport had accepted the text but
  // returned no message id, so no receipt could ever arrive; the family got the
  // same notice again a day after they had already acted, and would have again
  // every day until the 5th attempt parked the timesheet in admin review). A
  // missing receipt is not evidence of non-delivery — only a "failed" receipt is
  // (recordApprovalNoticeProviderStatus handles that). Close it out instead.
  const staleSent = await db.collection("billingApprovalOutbox")
    .where("state", "==", "sent")
    .where("nextAttemptAt", "<=", now)
    .limit(20)
    .get();
  for (const doc of staleSent.docs) {
    const record = doc.data() as ApprovalOutboxRecord;
    await closeOutbox(doc.id, record.appointmentId, "assumed_delivered");
  }

  return { attempted: ready.size, sent };
}

export const dispatchBillingApprovalNotices = functions.pubsub
  .schedule("every 1 minutes")
  .timeZone("UTC")
  .onRun(async () => {
    await processApprovalNoticeOutbox();
  });
