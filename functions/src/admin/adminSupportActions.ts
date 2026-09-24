import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { requireAdmin } from "./requireAdmin";
import { logAudit } from "../observability/auditLog";

const db = admin.firestore();

function nowIso() {
  return new Date().toISOString();
}

/**
 * admin_resolve_dispute — resolve a shift-hour / payment dispute.
 *
 * The dispute lifecycle rides on shiftHours (status `disputed_admin_review`).
 * Resolving moves the record to a terminal `approved` state with admin-set final
 * hours (or upholds the submitted hours when none are given), records the outcome
 * in correctionHistory, and writes an audit record (R6). Stripe charge/transfer
 * is left to the existing onShiftHoursApproved trigger — this callable does not
 * move money directly.
 */
export const admin_resolve_dispute = functions.https.onCall(
  async (data, context) => {
    const adminUid = await requireAdmin(context);

    const appointmentId: string = data?.appointmentId ?? data?.shiftHoursId;
    const outcome: string = data?.outcome; // "approve" | "reject"
    const note: string = typeof data?.note === "string" ? data.note.slice(0, 2000) : "";
    const finalTotalHours: number | undefined =
      typeof data?.finalTotalHours === "number" ? data.finalTotalHours : undefined;

    if (!appointmentId || !["approve", "reject"].includes(outcome)) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "appointmentId and a valid outcome (approve | reject) are required",
      );
    }

    const ref = db.collection("shiftHours").doc(appointmentId);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new functions.https.HttpsError("not-found", "Shift hours not found");
    }
    const shift = snap.data() ?? {};
    const now = nowIso();

    const resolvedHours =
      finalTotalHours ?? shift.finalTotalHours ?? shift.submittedTotalHours ?? 0;

    if (outcome === "reject") {
      // Reject the disputed hours: terminal `rejected` state, no payment.
      await ref.update({
        status: "rejected",
        resolvedAt: now,
        resolvedBy: "admin",
        adminAssignedTo: adminUid,
        adminResolutionNote: note || null,
        updatedAt: now,
        correctionHistory: admin.firestore.FieldValue.arrayUnion({
          by: "admin",
          action: "admin_rejected_dispute",
          at: now,
          note: note || null,
        }),
      });
    } else {
      const payRate = Number(shift.payRate ?? 0);
      const basePay = Math.round(resolvedHours * payRate * 100) / 100;
      const lineItems = Array.isArray(shift.lineItems) ? shift.lineItems : [];
      const lineItemsTotal =
        Math.round(lineItems.reduce((s: number, li: any) => s + (Number(li?.amount) || 0), 0) * 100) / 100;
      const grossPay = Math.round((basePay + lineItemsTotal) * 100) / 100;

      await ref.update({
        status: "approved",
        finalTotalHours: resolvedHours,
        basePay,
        lineItems,
        lineItemsTotal,
        grossPay,
        resolvedAt: now,
        resolvedBy: "admin",
        adminAssignedTo: adminUid,
        adminResolutionNote: note || null,
        updatedAt: now,
        correctionHistory: admin.firestore.FieldValue.arrayUnion({
          by: "admin",
          action: "admin_resolved_dispute",
          at: now,
          hours: resolvedHours,
          basePay,
          lineItems,
          lineItemsTotal,
          grossPay,
          note: note || null,
        }),
      });
    }

    await logAudit({
      eventType: "dispute_resolved",
      userId: shift.clientId ?? appointmentId,
      data: {
        source: "callable:admin_resolve_dispute",
        adminUid,
        appointmentId,
        outcome,
        finalTotalHours: resolvedHours,
        caregiverId: shift.caregiverId ?? null,
        note: note || null,
      },
    });

    return { success: true, appointmentId, outcome, finalTotalHours: resolvedHours };
  },
);

/**
 * admin_review_invoice_exception — review an invoice exception surfaced as an
 * admin alert (e.g. a payment_failed shift charge). Records the resolution onto
 * the alert and audit-logs the outcome (R6/R16). The alert is the contract
 * surface for invoice exceptions (no separate invoices contract collection).
 */
export const admin_review_invoice_exception = functions.https.onCall(
  async (data, context) => {
    const adminUid = await requireAdmin(context);

    const alertId: string = data?.alertId;
    const resolution: string = data?.resolution; // "resolved" | "writeoff" | "retry_scheduled"
    const note: string = typeof data?.note === "string" ? data.note.slice(0, 2000) : "";

    const VALID = ["resolved", "writeoff", "retry_scheduled"];
    if (!alertId || !VALID.includes(resolution)) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        `alertId and a valid resolution (${VALID.join(" | ")}) are required`,
      );
    }

    const ref = db.collection("admin_alerts").doc(alertId);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new functions.https.HttpsError("not-found", "Alert not found");
    }
    const alert = snap.data() ?? {};
    const now = nowIso();

    await ref.update({
      resolved: true,
      resolvedAt: now,
      resolvedBy: adminUid,
      invoiceResolution: resolution,
      resolvedNote: note || null,
    });

    await logAudit({
      eventType: "invoice_exception_reviewed",
      userId: (alert.userId as string) ?? alertId,
      data: {
        source: "callable:admin_review_invoice_exception",
        adminUid,
        alertId,
        resolution,
        alertType: alert.type ?? null,
        note: note || null,
      },
    });

    return { success: true, alertId, resolution };
  },
);
