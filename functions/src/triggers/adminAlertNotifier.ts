import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { sendViaInteractionAgent } from "../agents/caraAgent";

const db = admin.firestore();

// Alert types that always warrant an email regardless of priority field
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

// Alert types that also trigger an admin push notification
const PUSH_NOTIFY_TYPES = new Set([
  "missing_emergency_contact",
  "background_check_expired",
]);

// ── onAdminAlertCreated — queue email whenever a critical alert is created ─────

export const onAdminAlertCreated = functions.firestore
  .document("admin_alerts/{alertId}")
  .onCreate(async (snap, context) => {
    const alertId = context.params.alertId;
    const alert   = snap.data();
    if (!alert) return;

    const priority: string | undefined = alert.priority;
    const type: string | undefined     = alert.type;

    // ── Skip if email already queued (idempotency guard) ──────────────────────
    if (alert.emailSent === true || alert.emailQueued === true) {
      console.log(`[onAdminAlertCreated] ${alertId} already queued — skipping`);
      return;
    }

    // ── Determine whether this alert meets the notification threshold ──────────
    const isHighPriority =
      priority === "high" || priority === "critical";
    const isHighImportanceType =
      typeof type === "string" && HIGH_IMPORTANCE_TYPES.has(type);

    if (!isHighPriority && !isHighImportanceType) {
      console.log(
        `[onAdminAlertCreated] ${alertId} skipped — priority="${priority}" type="${type}" below threshold`
      );
      return;
    }

    const adminEmail = process.env.ADMIN_EMAIL ?? "admin@careconnex.com";
    const now        = new Date().toISOString();

    // ── Write to admin_email_queue ─────────────────────────────────────────────
    try {
      await db.collection("admin_email_queue").add({
        to:        adminEmail,
        subject:   `[Cara Alert] ${type ?? "unknown"} — ${priority ?? "medium"} priority`,
        body:
          `Alert type: ${type ?? "unknown"}\n` +
          `Priority: ${priority ?? "medium"}\n` +
          `Details: ${JSON.stringify(alert, null, 2)}\n` +
          `Created: ${alert.createdAt ?? now}\n` +
          `Alert ID: ${alertId}`,
        createdAt: now,
        sent:      false,
      });

      // Mark the alert so it isn't re-queued on a re-trigger
      await snap.ref.update({ emailQueued: true });

      console.log(`[onAdminAlertCreated] Email queued for alert ${alertId} (type="${type}" priority="${priority}")`);
    } catch (err) {
      console.error(`[onAdminAlertCreated] Failed to queue email for alert ${alertId}:`, err);
      // Do not rethrow — a failed queue write should not block push notification attempts
    }

    // ── Push notification for specific high-urgency types ─────────────────────
    const adminPhone = process.env.ADMIN_PHONE;
    if (adminPhone && typeof type === "string" && PUSH_NOTIFY_TYPES.has(type)) {
      await sendViaInteractionAgent(adminPhone, {
        content:     `Cara Alert: ${type} — check admin dashboard.`,
        urgency:     "urgent",
        sourceAgent: "admin_alert_notifier",
        canDrop:     false,
      }).catch(err =>
        console.error(`[onAdminAlertCreated] Push notification failed for alert ${alertId}:`, err)
      );
    }
  });
