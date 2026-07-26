import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import Stripe from "stripe";
import { sendViaInteractionAgent } from "../agents/caraAgent";

const db = admin.firestore();
const MAX_REFUND_ATTEMPTS = 5;
const REFUND_LEASE_MS = 5 * 60 * 1000;

let stripeClient: Stripe | null = null;
function getStripe(): Stripe {
  if (!stripeClient) {
    stripeClient = new Stripe(
      functions.config().stripe?.secret || process.env.STRIPE_SECRET_KEY || "",
      { apiVersion: "2023-10-16" as any },
    );
  }
  return stripeClient;
}

async function requireAdmin(uid: string): Promise<void> {
  const snap = await db.collection("users").doc(uid).get();
  const user = snap.data();
  if (!snap.exists || (user?.userType !== "admin" && user?.isAdmin !== true)) {
    throw new functions.https.HttpsError("permission-denied", "Administrator access required");
  }
}

export const reviewRefundRequest = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Sign in required");
  await requireAdmin(context.auth.uid);

  const requestId = String(data?.requestId ?? "");
  const action = String(data?.action ?? "");
  if (!requestId || !["approve", "decline", "retry"].includes(action)) {
    throw new functions.https.HttpsError("invalid-argument", "requestId and a valid action are required");
  }

  const ref = db.collection("refundRequests").doc(requestId);
  const snap = await ref.get();
  if (!snap.exists) throw new functions.https.HttpsError("not-found", "Refund request not found");
  const request = snap.data()!;
  const now = new Date().toISOString();

  if (action === "decline") {
    if (!["requested", "under_review"].includes(String(request.status))) {
      throw new functions.https.HttpsError("failed-precondition", "Refund request cannot be declined in its current state");
    }
    await ref.update({
      status: "declined",
      decisionReason: String(data?.reason ?? ""),
      reviewedBy: context.auth.uid,
      reviewedAt: now,
      updatedAt: now,
    });
    return { success: true, status: "declined" };
  }

  if (action === "approve" && !["requested", "under_review"].includes(String(request.status))) {
    throw new functions.https.HttpsError("failed-precondition", "Refund request is not awaiting review");
  }
  if (action === "retry" && request.status !== "under_review") {
    throw new functions.https.HttpsError("failed-precondition", "Only a refund under review can be retried");
  }
  if (Number(request.attemptCount ?? 0) >= MAX_REFUND_ATTEMPTS) {
    throw new functions.https.HttpsError("failed-precondition", "Refund reached the retry limit and needs manual resolution");
  }

  await ref.update({
    status: "approved",
    approvedAmountCents: data?.amountCents == null ? request.approvedAmountCents ?? null : Number(data.amountCents),
    reviewedBy: context.auth.uid,
    reviewedAt: now,
    decisionReason: String(data?.reason ?? request.decisionReason ?? ""),
    updatedAt: now,
  });
  return { success: true, status: "approved" };
});

export const onRefundRequestWrite = functions.firestore
  .document("refundRequests/{requestId}")
  .onWrite(async (change, context) => {
    const after = change.after.exists ? change.after.data() : null;
    const before = change.before.exists ? change.before.data() : null;
    if (!after || after.status !== "approved" || before?.status === "approved") return;
    await processApprovedRefund(context.params.requestId);
  });

export async function claimApprovedRefund(requestId: string): Promise<{
  request: Record<string, any>;
  shift: Record<string, any>;
  amountCents: number;
  attempt: number;
} | null> {
  const requestRef = db.collection("refundRequests").doc(requestId);
  return db.runTransaction(async (transaction) => {
    const requestSnap = await transaction.get(requestRef);
    if (!requestSnap.exists) return null;
    const request = requestSnap.data() as Record<string, any>;
    if (request.status !== "approved") return null;

    const appointmentId = String(request.appointmentId ?? "");
    const shiftRef = db.collection("shiftHours").doc(appointmentId);
    const shiftSnap = await transaction.get(shiftRef);
    if (!shiftSnap.exists) {
      transaction.update(requestRef, { status: "under_review", lastErrorCode: "paid_timesheet_not_found" });
      return null;
    }
    const shift = shiftSnap.data() as Record<string, any>;
    if (shift.clientId !== request.clientId || shift.status !== "paid" || !shift.stripeChargeId) {
      transaction.update(requestRef, { status: "under_review", lastErrorCode: "refund_not_authorized_for_payment" });
      return null;
    }

    const grossCents = Number(shift.amountCents ?? Math.round(Number(shift.grossPay ?? 0) * 100));
    const refundedCents = Number(shift.refundedAmountCents ?? 0);
    const reservedCents = Number(shift.refundReservedCents ?? 0);
    const existingReservation = Number(request.reservedAmountCents ?? 0);
    const remainingCents = grossCents - refundedCents - reservedCents + existingReservation;
    const requestedCents = Number(
      request.approvedAmountCents ??
      request.amountCents ??
      (request.amount == null ? remainingCents : Math.round(Number(request.amount) * 100)),
    );
    if (!Number.isInteger(requestedCents) || requestedCents <= 0 || requestedCents > remainingCents) {
      transaction.update(requestRef, {
        status: "under_review",
        lastErrorCode: "refund_amount_exceeds_remaining_balance",
        remainingRefundableCents: Math.max(0, remainingCents),
      });
      return null;
    }

    const attempt = Number(request.attemptCount ?? 0) + 1;
    if (attempt > MAX_REFUND_ATTEMPTS) {
      transaction.update(requestRef, { status: "under_review", lastErrorCode: "refund_attempt_limit_exceeded" });
      return null;
    }

    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const leaseOwner = `refund-${requestId}-${nowMs}`;
    transaction.update(requestRef, {
      status: "processing",
      amountCents: requestedCents,
      paymentIntentId: shift.stripeChargeId,
      transferId: shift.stripeTransferId ?? null,
      paymentGeneration: Number(shift.paymentGeneration ?? 1),
      attemptCount: attempt,
      reservedAmountCents: requestedCents,
      leaseOwner,
      leaseExpiresAt: new Date(nowMs + REFUND_LEASE_MS).toISOString(),
      updatedAt: now,
      lastErrorCode: null,
    });
    if (!existingReservation) {
      transaction.update(shiftRef, {
        refundReservedCents: reservedCents + requestedCents,
        updatedAt: now,
      });
    }
    return { request: { ...request, appointmentId }, shift, amountCents: requestedCents, attempt };
  });
}

export async function processApprovedRefund(requestId: string): Promise<void> {
  const claim = await claimApprovedRefund(requestId);
  if (!claim) return;

  const { request, shift, amountCents } = claim;
  const requestRef = db.collection("refundRequests").doc(requestId);
  const shiftRef = db.collection("shiftHours").doc(request.appointmentId);
  let stripeRefundId: string | null = null;
  let reversalId: string | null = null;

  try {
    // Childcare U8 (R39/R57): childcare refunds carry the booking correlation
    // on top of the senior keys (opaque IDs only). Senior metadata unchanged.
    const refundMetadata: Record<string, string> = {
      requestId,
      clientId: String(request.clientId ?? ""),
      appointmentId: String(request.appointmentId),
      paymentGeneration: String(shift.paymentGeneration ?? 1),
      ...(shift.careVertical === "child"
        ? {
            careVertical: "child",
            childcareBookingId: String(shift.childcareBookingId ?? ""),
          }
        : {}),
    };
    const refund = await getStripe().refunds.create({
      payment_intent: shift.stripeChargeId,
      amount: amountCents,
      reason: "requested_by_customer",
      metadata: refundMetadata,
    }, { idempotencyKey: `shift-refund-${requestId}` });
    stripeRefundId = refund.id;

    if (shift.stripeTransferId) {
      const reversal = await getStripe().transfers.createReversal(
        shift.stripeTransferId,
        { amount: amountCents, metadata: { requestId, appointmentId: String(request.appointmentId) } },
        { idempotencyKey: `shift-refund-reversal-${requestId}` },
      );
      reversalId = reversal.id;
    }

    const now = new Date().toISOString();
    await db.runTransaction(async (transaction) => {
      const [requestSnap, shiftSnap] = await Promise.all([
        transaction.get(requestRef),
        transaction.get(shiftRef),
      ]);
      if (!requestSnap.exists || !shiftSnap.exists) return;
      const currentRequest = requestSnap.data()!;
      if (currentRequest.status === "refunded") return;
      const currentShift = shiftSnap.data()!;
      const priorRefunded = Number(currentShift.refundedAmountCents ?? 0);
      const priorReserved = Number(currentShift.refundReservedCents ?? 0);
      const grossCents = Number(currentShift.amountCents ?? Math.round(Number(currentShift.grossPay ?? 0) * 100));
      const totalRefunded = priorRefunded + amountCents;

      transaction.update(requestRef, {
        status: "refunded",
        stripeRefundId,
        stripeTransferReversalId: reversalId,
        refundedAt: now,
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      });
      transaction.update(shiftRef, {
        refundedAmountCents: totalRefunded,
        refundReservedCents: Math.max(0, priorReserved - amountCents),
        refundStatus: totalRefunded >= grossCents ? "refunded" : "partially_refunded",
        updatedAt: now,
      });
      transaction.set(db.collection("appointments").doc(request.appointmentId), {
        paymentStatus: totalRefunded >= grossCents ? "refunded" : "partially_refunded",
        refundedAt: now,
      }, { merge: true });
    });

    if (shift.careVertical === "child") {
      // Childcare U8: generic child-safe IN-APP notice (Evia SMS flows for
      // childcare are U10). Amount + status only — never child data.
      await db.collection("users").doc(String(request.clientId ?? "")).collection("notifications").add({
        userId: String(request.clientId ?? ""),
        type: "childcare_refund_processed",
        title: "Refund Processed",
        body: `Your $${(amountCents / 100).toFixed(2)} refund was processed. It may take 5-10 business days to appear.`,
        data: { refId: String(request.appointmentId) },
        isRead: false,
        createdAt: new Date().toISOString(),
      }).catch(() => {});
    } else {
      const clientSnap = await db.collection("users").doc(String(request.clientId ?? "")).get();
      const clientPhone = clientSnap.data()?.phone;
      if (typeof clientPhone === "string" && clientPhone) {
        await sendViaInteractionAgent(clientPhone, {
          content: `Your $${(amountCents / 100).toFixed(2)} refund was processed. It may take 5-10 business days to appear.`,
          urgency: "standard",
          sourceAgent: "refund_processor",
          canDrop: false,
          preferredService: "SMS",
        }).catch(() => {});
      }
    }
  } catch (error) {
    const now = new Date().toISOString();
    const errorMessage = error instanceof Error ? error.message : String(error);
    await db.runTransaction(async (transaction) => {
      const [requestSnap, shiftSnap] = await Promise.all([
        transaction.get(requestRef),
        transaction.get(shiftRef),
      ]);
      if (!requestSnap.exists) return;
      const currentRequest = requestSnap.data()!;
      transaction.update(requestRef, {
        status: "under_review",
        stripeRefundId,
        stripeTransferReversalId: reversalId,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: stripeRefundId && !reversalId ? "transfer_reversal_failed" : "refund_processing_failed",
        lastErrorMessage: errorMessage.slice(0, 500),
        updatedAt: now,
      });
      if (shiftSnap.exists && currentRequest.reservedAmountCents) {
        const shiftDoc = shiftSnap.data()!;
        transaction.update(shiftRef, {
          refundReservedCents: Math.max(0, Number(shiftDoc.refundReservedCents ?? 0) - Number(currentRequest.reservedAmountCents)),
          updatedAt: now,
        });
      }
    });
    await db.collection("admin_alerts").add({
      type: "refund_processing_failed",
      requestId,
      appointmentId: request.appointmentId,
      stripeRefundId,
      transferId: shift.stripeTransferId ?? null,
      error: errorMessage.slice(0, 500),
      severity: "high",
      resolved: false,
      createdAt: now,
    });
  }
}
