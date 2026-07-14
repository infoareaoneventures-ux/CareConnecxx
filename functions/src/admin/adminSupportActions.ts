import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { requireAdmin } from "./requireAdmin";
import { logAudit } from "../observability/auditLog";

const db = admin.firestore();

function nowIso() {
  return new Date().toISOString();
}

/**
 * admin_respond_support_ticket — write an admin reply onto a support ticket so
 * the USER sees it.
 *
 * The user-visible response is appended to the ticket's `responses` subcollection
 * (`isAdmin: true`) — the exact shape the web ticket views read (services/api.ts
 * addTicketResponse + the user's ticket thread). The ticket is moved to
 * in-progress (or resolved when requested). We additionally notify the user over
 * Linq where an SMS session exists, and write a notifications doc, so Evia is the
 * delivery surface. Audit-logged.
 */
export const admin_respond_support_ticket = functions.https.onCall(
  async (data, context) => {
    const adminUid = await requireAdmin(context);

    const ticketId: string = data?.ticketId;
    const message: string = typeof data?.message === "string" ? data.message.trim() : "";
    const resolve: boolean = data?.resolve === true;

    if (!ticketId || !message) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "ticketId and a non-empty message are required",
      );
    }

    const ref = db.collection("support_tickets").doc(ticketId);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new functions.https.HttpsError("not-found", "Support ticket not found");
    }
    const ticket = snap.data() ?? {};
    const now = nowIso();
    const trimmed = message.slice(0, 5000);

    // User-visible response — same `responses` subcollection the web thread reads.
    await ref.collection("responses").add({
      message: trimmed,
      isAdmin: true,
      adminId: adminUid,
      createdAt: now,
    });

    await ref.update({
      status: resolve ? "resolved" : "in-progress",
      lastAdminResponseAt: now,
      ...(resolve ? { resolvedAt: now, resolvedBy: adminUid } : {}),
      updatedAt: now,
    });

    // Notify the user. notifications is web-read by the target user; Linq is the
    // conversational surface (best-effort — a delivery failure must not fail the
    // response write the user can already see on the ticket).
    const userId: string | undefined = ticket.userId;
    if (userId) {
      await db.collection("notifications").add({
        userId,
        type: "support_ticket_response",
        title: "Support replied to your ticket",
        message: trimmed.slice(0, 280),
        data: { ticketId },
        read: false,
        createdAt: now,
      }).catch((e) => console.warn("admin_respond_support_ticket notification write failed", e));

      try {
        const userSnap = await db.collection("users").doc(userId).get();
        const phone = userSnap.data()?.phone as string | undefined;
        if (phone) {
          const { sendToPhone } = await import("../linq/client");
          await sendToPhone(
            phone,
            `Support update on your ticket: ${trimmed.slice(0, 600)}`,
          );
        }
      } catch (e) {
        console.warn("admin_respond_support_ticket Linq notify failed", e);
      }
    }

    await logAudit({
      eventType: "support_ticket_responded",
      userId: userId ?? ticketId,
      data: {
        source: "callable:admin_respond_support_ticket",
        adminUid,
        ticketId,
        resolved: resolve,
        preview: trimmed.slice(0, 200),
      },
    });

    return { success: true, ticketId, status: resolve ? "resolved" : "in-progress" };
  },
);

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
