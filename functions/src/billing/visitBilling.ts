import * as admin from "firebase-admin";
import Stripe from "stripe";
import { sendToPhone } from "../linq/client";
import { sendViaInteractionAgent } from "../agents/caraAgent";
import { logBookingCreated } from "../observability/auditLog";

const db = admin.firestore();

let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "", { apiVersion: "2023-10-16" as any });
  }
  return _stripe;
}

const SUPPORT_PHONE = process.env.SUPPORT_PHONE ?? "1-800-555-0199";

export interface VisitPaymentParams {
  appointmentId: string;
  clientId:      string;
  clientPhone:   string;
  caregiverId:   string;
  caregiverName: string;
  caregiverPhone?: string;
  durationHours: number;
  hourlyRate:    number;
  date:          string;
}

export async function createVisitPayment(params: VisitPaymentParams): Promise<void> {
  const {
    appointmentId, clientId, clientPhone, caregiverId, caregiverName,
    caregiverPhone, durationHours, hourlyRate, date,
  } = params;

  const amountCents = Math.round(durationHours * hourlyRate * 100);
  const now = new Date().toISOString();

  // Retrieve client's Stripe customer ID + phone (if not supplied)
  const userSnap = await db.collection("users").doc(clientId).get();
  const resolvedPhone = clientPhone || (userSnap.data()?.phone as string | undefined) || "";
  const customerId = userSnap.data()?.stripeCustomerId as string | undefined;

  let paymentIntentId: string | undefined;

  if (customerId) {
    try {
      const pi = await getStripe().paymentIntents.create({
        amount:               amountCents,
        currency:             "usd",
        customer:             customerId,
        application_fee_amount: 0, // Caregivers keep 100%
        description:          `Care visit — ${caregiverName} on ${date}`,
        metadata: {
          appointmentId,
          clientId,
          caregiverId,
        },
        confirm:              false, // Confirm separately when client approves
      });
      paymentIntentId = pi.id;
    } catch (err) {
      console.error("createVisitPayment Stripe error:", err);
    }
  }

  // Write visit_payments doc
  await db.collection("visit_payments").doc(appointmentId).set({
    appointmentId,
    clientId,
    caregiverId,
    caregiverName,
    date,
    durationHours,
    hourlyRate,
    amountCents,
    status:          paymentIntentId ? "pending" : "no_payment_method",
    stripePaymentIntentId: paymentIntentId ?? null,
    createdAt:       now,
  });

  logBookingCreated(clientId, caregiverId, [date]).catch(() => {});

  // Notify client (low urgency — informational)
  const totalStr = `$${(amountCents / 100).toFixed(2)}`;
  if (resolvedPhone) await sendViaInteractionAgent(resolvedPhone, {
    content:
      `Visit complete! A payment of ${totalStr} will be processed for today's ` +
      `${durationHours}h visit with ${caregiverName}.`,
    urgency:     "low",
    sourceAgent: "visit_billing",
    canDrop:     true,
  }).catch(() => {});


  // Notify caregiver directly (bypass interaction agent — caregiver-initiated message path)
  if (caregiverPhone) {
    await sendToPhone(caregiverPhone,
      `Visit logged for ${date}. Your payment of ${totalStr} will be processed shortly.`
    ).catch(() => {});
  }
}

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
    const appUrl    = process.env.APP_URL ?? "https://cara.app";
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
