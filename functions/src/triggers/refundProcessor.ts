import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import Stripe from "stripe";
import { sendViaInteractionAgent } from "../agents/caraAgent";

const db = admin.firestore();

let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "", { apiVersion: "2023-10-16" as any });
  }
  return _stripe;
}

// ── onRefundRequestWrite — execute Stripe refund when status → "approved" ─────

export const onRefundRequestWrite = functions.firestore
  .document("refundRequests/{requestId}")
  .onWrite(async (change, context) => {
    const requestId = context.params.requestId;
    const after     = change.after.exists ? change.after.data() : null;
    const before    = change.before.exists ? change.before.data() : null;
    if (!after) return;

    // Only act when status transitions to "approved"
    if (after.status !== "approved" || before?.status === "approved") return;
    // Prevent re-processing
    if (after.stripeRefundId) return;

    try {
      await processRefund(requestId, after);
    } catch (err) {
      console.error(`[onRefundRequestWrite] processRefund failed for ${requestId}:`, err);
      await change.after.ref.update({
        status:      "failed",
        errorMessage: String(err),
        failedAt:    new Date().toISOString(),
      });
    }
  });

async function processRefund(requestId: string, req: any): Promise<void> {
  const { appointmentId, clientId, amount } = req;

  // Look up Stripe payment intent from visit_billing records
  let paymentIntentId: string | undefined;

  const billingSnap = await db.collection("visit_billing")
    .where("appointmentId", "==", appointmentId)
    .orderBy("createdAt", "desc")
    .limit(1)
    .get();

  if (!billingSnap.empty) {
    paymentIntentId = billingSnap.docs[0].data().stripePaymentIntentId as string | undefined;
  }

  // Fall back to appointment document
  if (!paymentIntentId) {
    const apptSnap = await db.collection("appointments").doc(appointmentId ?? "").get();
    paymentIntentId = apptSnap.data()?.stripePaymentIntentId as string | undefined;
  }

  if (!paymentIntentId) {
    // No payment intent found — mark as manual (admin must refund through Stripe dashboard)
    await db.collection("refundRequests").doc(requestId).update({
      status:       "manual_required",
      manualNote:   "No Stripe payment intent found — please refund via Stripe dashboard",
      updatedAt:    new Date().toISOString(),
    });
    await db.collection("admin_alerts").add({
      type:      "refund_manual_required",
      requestId,
      clientId,
      appointmentId,
      amount,
      createdAt: new Date().toISOString(),
      resolved:  false,
    });
    return;
  }

  // Execute the Stripe refund
  const amountCents = Math.round((amount as number) * 100);
  const refund = await getStripe().refunds.create(
    {
      payment_intent: paymentIntentId,
      ...(amountCents > 0 ? { amount: amountCents } : {}),
      reason: "requested_by_customer",
      metadata: { requestId, clientId: clientId ?? "" },
    },
    { idempotencyKey: `refund-${requestId}` }
  );

  // Update refund request
  await db.collection("refundRequests").doc(requestId).update({
    status:        "completed",
    stripeRefundId: refund.id,
    completedAt:   new Date().toISOString(),
  });

  // Update appointment status
  if (appointmentId) {
    await db.collection("appointments").doc(appointmentId).update({
      status:    "refunded",
      refundedAt: new Date().toISOString(),
    }).catch(() => {});
  }

  // Notify client
  if (clientId) {
    const userSnap = await db.collection("users").doc(clientId).get();
    const clientPhone = userSnap.data()?.phone as string | undefined;
    if (clientPhone) {
      await sendViaInteractionAgent(clientPhone, {
        content:
          `Your refund of $${Number(amount ?? 0).toFixed(2)} has been processed and will appear ` +
          `on your statement within 5–10 business days.`,
        urgency:     "standard",
        sourceAgent: "refund_processor",
        canDrop:     false,
      }).catch(() => {});
    }
  }

  console.log(`[processRefund] Refund ${refund.id} executed for request ${requestId}`);
}
