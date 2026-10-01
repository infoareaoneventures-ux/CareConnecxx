import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { sendTransactionalEmail } from "../email";
import { sendToPhone } from "../linq/client";

const db = admin.firestore();

// Alert types that always warrant an email regardless of priority field.
const HIGH_IMPORTANCE_TYPES = new Set([
  "missing_emergency_contact",
  "caregiver_inactive_30d",
  "background_check_expired",
  "caregiver_unresponsive_checkin",
  "qa_loop_exhausted",
  "no_replacement_found",
  "double_booking_conflict",
  "low_caregiver_rating",
  "health_alert_unacknowledged",
]);

// Alert types that also trigger an admin SMS.
const SMS_NOTIFY_TYPES = new Set([
  "missing_emergency_contact",
  "background_check_expired",
  // A family or caregiver wrote to the team (website "Message our team" button,
  // a text to Evia asking for a person, or Evia's own low-confidence handoff).
  "support_message",
  // Life-safety (2026-09-23): the crisis detector's medical-emergency hit and a
  // family's NOTIFY reply. Email alone is not a page — support@ is suppressed by
  // Resend. (The family-emergency button/tool was removed 2026-09-27.)
  "cara_medical_emergency",
  "crisis_notify_requested",
  // Timesheets reaching the team (2026-10-01): a family escalated a counter, a
  // correction was blocked from auto-accept, a visit payment failed 5 times.
  "shift_hours_admin_review",
  "shift_hours_billing_review",
  "shift_hours_payment_failed_escalated",
]);

function adminSmsText(type: string, alert: Record<string, any>): string {
  switch (type) {
    case "support_message":
      return `Evia: someone messaged the team — "${String(alert.message ?? "").slice(0, 160)}" Reply in Admin › Messages; your reply is texted to them.`;
    case "cara_medical_emergency":
      return `🚨 Evia: a family texted what sounds like a medical emergency${alert.phone ? ` (${alert.phone})` : ""}. They were told to call 911. Open Admin › Alerts now.`;
    case "crisis_notify_requested":
      return `🚨 Evia: a family replied NOTIFY on a ${alert.crisisKind ?? "medical"} crisis and wants the team${alert.phone ? ` — call ${alert.phone}` : ""}. Open Admin › Alerts now.`;
    case "shift_hours_admin_review":
    case "shift_hours_billing_review":
    case "shift_hours_payment_failed_escalated":
      return `Evia: a timesheet needs the team — ${String(alert.message ?? alert.title ?? type).slice(0, 200)} Open Admin › Finance.`;
    default:
      return `Evia Alert: ${type} - check admin dashboard.`;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

interface AdminAlertSnapshot {
  data(): Record<string, any> | undefined;
  ref: {
    update(data: Record<string, unknown>): Promise<unknown>;
  };
}

interface AdminAlertContext {
  params: { alertId: string };
}

// Deliver admin notifications directly and retain the queue document as an
// operations audit record. There is no worker for admin_email_queue.
export async function handleAdminAlertCreated(
  snap: AdminAlertSnapshot,
  context: AdminAlertContext
): Promise<void> {
    const alertId = context.params.alertId;
    const alert = snap.data();
    if (!alert) return;

    const priority: string | undefined = alert.priority ?? alert.severity;
    const type: string | undefined = alert.type;
    const isHighPriority = priority === "high" || priority === "critical";
    const isHighImportanceType =
      typeof type === "string" && HIGH_IMPORTANCE_TYPES.has(type);

    if (!isHighPriority && !isHighImportanceType) {
      console.log(
        `[onAdminAlertCreated] ${alertId} skipped: priority/severity="${priority}" type="${type}" below threshold`
      );
      return;
    }

    const adminEmail = process.env.ADMIN_EMAIL ?? "support@eviacares.com";
    const now = new Date().toISOString();
    const subject = `[Evia Alert] ${type ?? "unknown"} - ${priority ?? "medium"} priority`;
    const body =
      `Alert type: ${type ?? "unknown"}\n` +
      `Priority: ${priority ?? "medium"}\n` +
      `Details: ${JSON.stringify(alert, null, 2)}\n` +
      `Created: ${alert.createdAt ?? now}\n` +
      `Alert ID: ${alertId}`;
    const queueRef = db.collection("admin_email_queue").doc(alertId);

    let emailAlreadySent = alert.emailSent === true;
    if (!emailAlreadySent) {
      try {
        const queued = await queueRef.get();
        emailAlreadySent = queued.exists && queued.data()?.sent === true;
      } catch (error) {
        console.error(
          `[onAdminAlertCreated] Failed to read email audit for alert ${alertId}:`,
          error
        );
      }
    }

    if (!emailAlreadySent) {
      try {
        await queueRef.set(
          {
            alertId,
            to: adminEmail,
            subject,
            body,
            createdAt: now,
            lastAttemptAt: now,
            sent: false,
            deliveryState: "pending",
          },
          { merge: true }
        );
        await snap.ref.update({
          emailQueued: true,
          emailDeliveryState: "pending",
          emailLastAttemptAt: now,
        });
      } catch (error) {
        console.error(
          `[onAdminAlertCreated] Failed to write email audit for alert ${alertId}:`,
          error
        );
      }

      try {
        const result = await sendTransactionalEmail({
          to: adminEmail,
          subject,
          text: body,
          html: `<pre style="white-space:pre-wrap;font-family:system-ui,sans-serif">${escapeHtml(body)}</pre>`,
          fromName: "Evia Alerts",
        });
        const sentAt = new Date().toISOString();
        await Promise.allSettled([
          queueRef.set(
            {
              sent: true,
              deliveryState: "sent",
              sentAt,
              providerMessageId: result.id ?? null,
            },
            { merge: true }
          ),
          snap.ref.update({
            emailQueued: true,
            emailSent: true,
            emailDeliveryState: "sent",
            emailSentAt: sentAt,
          }),
        ]);
        console.log(`[onAdminAlertCreated] Email sent for alert ${alertId}`);
      } catch (error) {
        const failedAt = new Date().toISOString();
        const lastError = errorMessage(error);
        await Promise.allSettled([
          queueRef.set(
            {
              sent: false,
              deliveryState: "failed",
              failedAt,
              lastError,
            },
            { merge: true }
          ),
          snap.ref.update({
            emailQueued: true,
            emailSent: false,
            emailDeliveryState: "failed",
            emailFailedAt: failedAt,
            emailLastError: lastError,
          }),
        ]);
        console.error(
          `[onAdminAlertCreated] Email delivery failed for alert ${alertId}:`,
          error
        );
      }
    }

    const adminPhone = process.env.ADMIN_PHONE;
    if (adminPhone && typeof type === "string" && SMS_NOTIFY_TYPES.has(type)) {
      try {
        const outcome = await sendToPhone(adminPhone, adminSmsText(type, alert), { source: "admin_alert_notifier" });
        const attemptedAt = new Date().toISOString();
        await snap.ref.update({
          smsDeliveryState: outcome,
          smsAttemptedAt: attemptedAt,
          smsSent: outcome === "sent",
          smsQueued: outcome === "queued",
        });
        if (outcome === "dropped" || outcome === "skipped_opt_out") {
          console.error(
            `[onAdminAlertCreated] SMS delivery returned ${outcome} for alert ${alertId}`
          );
        } else {
          console.log(
            `[onAdminAlertCreated] SMS ${outcome} for alert ${alertId}`
          );
        }
      } catch (error) {
        const failedAt = new Date().toISOString();
        const lastError = errorMessage(error);
        await snap.ref.update({
          smsDeliveryState: "failed",
          smsAttemptedAt: failedAt,
          smsSent: false,
          smsLastError: lastError,
        }).catch(() => {});
        console.error(
          `[onAdminAlertCreated] SMS delivery failed for alert ${alertId}:`,
          error
        );
      }
    }
}

export const onAdminAlertCreated = functions.firestore
  .document("admin_alerts/{alertId}")
  .onCreate(handleAdminAlertCreated);
