import * as admin from "firebase-admin";
import { sendToPhone } from "../linq/client";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { getAppUrl } from "../config/appUrl";

const db = admin.firestore();

const SUPPORT_PHONE = process.env.SUPPORT_PHONE ?? "1-800-555-0199";

// NOTE: visit charges are handled exclusively by the shiftHours rail
// (functions/src/shiftHours.ts → onShiftHoursApproved → processShiftPayment),
// which charges the client incl. the 1.5% platform fee and transfers net pay to
// the caregiver's Stripe Connect account. The former createVisitPayment() here
// created a PaymentIntent with confirm:false that was never captured, so it took
// no money and double-promised payment — it has been removed and all callers
// (timesheet approval, SMS visit completion) now funnel into shiftHours.

export async function handlePaymentError(params: {
  appointmentId: string;
  clientId:      string;
  clientPhone:   string;
  caregiverId:   string;
  caregiverName: string;
  caregiverPhone?: string;
  amountCents:   number;
  errorMessage:  string;
}): Promise<void> {
  const { appointmentId, clientId, clientPhone, caregiverId, caregiverName, caregiverPhone, amountCents, errorMessage } = params;
  const now = new Date().toISOString();

  await db.collection("visit_payments").doc(appointmentId).set({
    status:      "failed",
    failedAt:    now,
    errorMessage,
  }, { merge: true });

  // Mark any pending booking task as payment_failed so the payment_method.attached
  // retry handler can find and re-execute it when the client updates their card.
  const taskSnap = await db.collection("agent_tasks")
    .where("appointmentIds", "array-contains", appointmentId)
    .where("status", "in", ["awaiting_approval", "approved"])
    .limit(1)
    .get();
  if (!taskSnap.empty) {
    await taskSnap.docs[0].ref.update({ status: "payment_failed", failedAt: now });
  }

  await db.collection("admin_alerts").add({
    type:          "payment_failed",
    appointmentId,
    clientId,
    caregiverId,
    amountCents,
    errorMessage,
    createdAt:     now,
    resolved:      false,
    severity:      "high",
  });

  const totalStr = `$${(amountCents / 100).toFixed(2)}`;

  // Notify client with a tap-to-fix link — immediate, can't drop
  try {
    const { generateToken } = await import("../agents/tokenService");
    const appUrl    = getAppUrl();
    const token     = generateToken({ phone: clientPhone, task: "payment" });
    const updateUrl = `${appUrl}/done?task=payment&t=${token}`;
    await sendViaInteractionAgent(clientPhone, {
      content:
        `There was an issue processing payment for the recent visit (${totalStr}). ` +
        `Tap the link to update your payment method and we'll retry automatically:\n${updateUrl}\n\n` +
        `Questions? Call us at ${SUPPORT_PHONE}.`,
      urgency:     "immediate",
      sourceAgent: "visit_billing",
      canDrop:     false,
    });
    await db.collection("appointments").doc(appointmentId).update({
      paymentFailureNotifiedAt: now,
    });
  } catch (notifyErr) {
    console.error("visitBilling: failed to notify client via iMessage:", notifyErr);
  }

  // Reassure caregiver they'll be paid
  if (caregiverPhone) {
    await sendToPhone(caregiverPhone,
      `Hi ${caregiverName.split(" ")[0]} — there was a payment processing issue on our end, ` +
      `but you will be paid for your visit. We're resolving it now.`
    ).catch(() => {});
  }
}
