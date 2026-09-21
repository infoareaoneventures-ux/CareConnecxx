// The Timesheets page's review modal (components/payroll/ReviewShiftHoursModal.tsx
// → v1-reviewShiftHours), as ONE server function shared by the callable the
// website invokes and Evia's review_shift_hours tool — approve /
// propose_correction / accept_counter / escalate: same guards, same writes,
// same notifications. Kept free of the Stripe client so it can be imported
// anywhere (shiftHours.ts re-exports it).
import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { resolveShiftBillableAmount } from "./shiftBillingAmounts";
import { ShiftBillingPolicyError } from "./shiftBillingPolicy";

const db = admin.firestore();
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export type ReviewShiftHoursAction = "approve" | "propose_correction" | "accept_counter" | "escalate";
export const REVIEW_SHIFT_HOURS_ACTIONS: ReviewShiftHoursAction[] = ["approve", "propose_correction", "accept_counter", "escalate"];

export function fmtHours(hours: number): string {
  const totalSecs = Math.round(hours * 3600);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function resolveBillableOrHttpsError(input: Parameters<typeof resolveShiftBillableAmount>[0]) {
  try {
    return resolveShiftBillableAmount(input);
  } catch (error) {
    if (error instanceof ShiftBillingPolicyError) {
      throw new functions.https.HttpsError("invalid-argument", error.message);
    }
    throw error;
  }
}

export async function pushNotification(userId: string, type: string, title: string, message: string, data: any) {
  await db.collection("users").doc(userId).collection("notifications").add({
    userId,
    type,
    title,
    body: message,
    data,
    isRead: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

export async function notifyAdmins(type: string, title: string, message: string, data: any) {
  const admins = await db.collection("users").where("userType", "==", "admin").get();
  const batch = db.batch();
  admins.docs.forEach((docSnap) => {
    const ref = db.collection("users").doc(docSnap.id).collection("notifications").doc();
    batch.set(ref, {
      userId: docSnap.id,
      type,
      title,
      body: message,
      data,
      isRead: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  await batch.commit();
}

export interface ReviewShiftHoursInput {
  appointmentId?: string;
  action?: string;
  proposedStartTime?: string;
  proposedEndTime?: string;
  proposalReason?: string;
  lineItems?: unknown;
}

// `uid` is the family member acting — context.auth.uid on the website, the
// session's clientId for Evia. Throws HttpsError exactly like the callable.
export async function reviewShiftHoursAs(uid: string, data: ReviewShiftHoursInput): Promise<{ success: boolean }> {
  const { appointmentId, action, proposedStartTime, proposedEndTime, proposalReason, lineItems: rawLineItems } = data;
  if (!appointmentId || !REVIEW_SHIFT_HOURS_ACTIONS.includes(action as ReviewShiftHoursAction)) {
    throw new functions.https.HttpsError("invalid-argument", "appointmentId and valid action required");
  }

  const ref = db.collection("shiftHours").doc(appointmentId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new functions.https.HttpsError("not-found", "Shift hours not found");
  }
  const shift = snap.data()!;

  if (shift.clientId !== uid) {
    throw new functions.https.HttpsError("permission-denied", "Not your appointment");
  }

  if ((action === "approve" || action === "propose_correction") && shift.status !== "pending_client_review") {
    throw new functions.https.HttpsError("failed-precondition", "Already reviewed");
  }
  if ((action === "accept_counter" || action === "escalate") && shift.status !== "caregiver_counter_proposed") {
    throw new functions.https.HttpsError("failed-precondition", "No counter-proposal to respond to");
  }

  const now = new Date().toISOString();

  if (action === "approve") {
    const approved = resolveBillableOrHttpsError({
      startTime: shift.submittedStartTime,
      endTime: shift.submittedEndTime,
      bookedRateDollars: Number(shift.payRate),
      lineItems: shift.lineItems,
    });
    await ref.update({
      status: "approved",
      finalStartTime: shift.submittedStartTime,
      finalEndTime: shift.submittedEndTime,
      finalTotalHours: approved.totalHours,
      basePay: approved.basePay,
      lineItems: approved.lineItems,
      lineItemsTotal: approved.lineItemsTotal,
      grossPay: approved.grossPay,
      amountCents: approved.grossPayCents,
      serviceFeeCents: approved.serviceFeeCents,
      totalChargeCents: approved.totalChargeCents,
      requiresExplicitApproval: approved.requiresExplicitApproval,
      resolvedAt: now,
      resolvedBy: "client",
      updatedAt: now,
      correctionHistory: admin.firestore.FieldValue.arrayUnion({
        by: "client",
        action: "accepted",
        at: now,
        startTime: shift.submittedStartTime,
        endTime: shift.submittedEndTime,
        hours: approved.totalHours,
        lineItems: approved.lineItems,
        lineItemsTotal: approved.lineItemsTotal,
        basePay: approved.basePay,
        grossPay: approved.grossPay,
      }),
    });
    await pushNotification(
      shift.caregiverId,
      "shift_hours_approved",
      "Your hours were approved",
      `Client approved ${fmtHours(approved.totalHours)}.`,
      { appointmentId },
    );
    return { success: true };
  }

  if (action === "propose_correction") {
    if (!proposedStartTime || !proposedEndTime) {
      throw new functions.https.HttpsError("invalid-argument", "Proposed start/end required");
    }
    const correctionRespondByAt = new Date(Date.now() + ONE_DAY_MS).toISOString();

    const proposed = resolveBillableOrHttpsError({
      startTime: proposedStartTime,
      endTime: proposedEndTime,
      bookedRateDollars: Number(shift.payRate),
      lineItems: (rawLineItems !== undefined ? rawLineItems : shift.lineItems) as Parameters<typeof resolveShiftBillableAmount>[0]["lineItems"],
    });

    await ref.update({
      status: "correction_proposed",
      proposedStartTime,
      proposedEndTime,
      proposedTotalHours: proposed.totalHours,
      proposedLineItems: proposed.lineItems,
      proposedLineItemsTotal: proposed.lineItemsTotal,
      proposedGrossPay: proposed.grossPay,
      requiresExplicitApproval: proposed.requiresExplicitApproval,
      proposalReason: proposalReason || null,
      proposedAt: now,
      correctionRespondByAt,
      updatedAt: now,
      correctionHistory: admin.firestore.FieldValue.arrayUnion({
        by: "client",
        action: "proposed_correction",
        at: now,
        startTime: proposedStartTime,
        endTime: proposedEndTime,
        hours: proposed.totalHours,
        basePay: proposed.basePay,
        lineItems: proposed.lineItems,
        lineItemsTotal: proposed.lineItemsTotal,
        grossPay: proposed.grossPay,
        note: proposalReason || null,
      }),
    });

    await pushNotification(
      shift.caregiverId,
      "shift_hours_correction_proposed",
      "Client proposed a correction",
      `Client proposed ${fmtHours(proposed.totalHours)} (you submitted ${fmtHours(shift.submittedTotalHours)})${proposed.lineItemsTotal !== (Number(shift.lineItemsTotal) || 0) ? ` and changed the additional charges to $${proposed.lineItemsTotal.toFixed(2)} (from $${(Number(shift.lineItemsTotal) || 0).toFixed(2)})` : ""}. Respond within 24h or it auto-accepts.`,
      { appointmentId, proposedTotalHours: proposed.totalHours },
    );
    return { success: true };
  }

  if (action === "accept_counter") {
    if (!shift.counterStartTime || !shift.counterEndTime) {
      throw new functions.https.HttpsError("failed-precondition", "Counter-proposal data missing");
    }
    const accepted = resolveBillableOrHttpsError({
      startTime: shift.counterStartTime,
      endTime: shift.counterEndTime,
      bookedRateDollars: Number(shift.payRate),
      lineItems: shift.counterLineItems,
    });

    await ref.update({
      status: "approved",
      finalStartTime: shift.counterStartTime,
      finalEndTime: shift.counterEndTime,
      finalTotalHours: accepted.totalHours,
      lineItems: accepted.lineItems,
      lineItemsTotal: accepted.lineItemsTotal,
      basePay: accepted.basePay,
      grossPay: accepted.grossPay,
      amountCents: accepted.grossPayCents,
      serviceFeeCents: accepted.serviceFeeCents,
      totalChargeCents: accepted.totalChargeCents,
      requiresExplicitApproval: accepted.requiresExplicitApproval,
      resolvedAt: now,
      resolvedBy: "client",
      updatedAt: now,
      correctionHistory: admin.firestore.FieldValue.arrayUnion({
        by: "client",
        action: "accepted",
        at: now,
        startTime: shift.counterStartTime,
        endTime: shift.counterEndTime,
        hours: accepted.totalHours,
        lineItems: accepted.lineItems,
        lineItemsTotal: accepted.lineItemsTotal,
        basePay: accepted.basePay,
        grossPay: accepted.grossPay,
      }),
    });
    await pushNotification(
      shift.caregiverId,
      "shift_hours_approved",
      "Client accepted your counter-proposal",
      `Client accepted ${accepted.totalHours}h. Payment will be processed shortly.`,
      { appointmentId },
    );
    return { success: true };
  }

  // action === 'escalate'
  await ref.update({
    status: "disputed_admin_review",
    resolvedBy: null,
    updatedAt: now,
    correctionHistory: admin.firestore.FieldValue.arrayUnion({
      by: "client",
      action: "escalated",
      at: now,
    }),
  });

  await notifyAdmins(
    "shift_hours_admin_review",
    "Shift hours dispute needs mediation",
    `${shift.clientName} escalated a dispute with ${shift.caregiverName} for appointment ${appointmentId}.`,
    { appointmentId },
  );

  return { success: true };
}
