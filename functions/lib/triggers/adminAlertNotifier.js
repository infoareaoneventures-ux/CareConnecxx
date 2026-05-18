"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.onAdminAlertCreated = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const caraAgent_1 = require("../agents/caraAgent");
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
exports.onAdminAlertCreated = functions.firestore
    .document("admin_alerts/{alertId}")
    .onCreate(async (snap, context) => {
    var _a, _b;
    const alertId = context.params.alertId;
    const alert = snap.data();
    if (!alert)
        return;
    const priority = alert.priority;
    const type = alert.type;
    // ── Skip if email already queued (idempotency guard) ──────────────────────
    if (alert.emailSent === true || alert.emailQueued === true) {
        console.log(`[onAdminAlertCreated] ${alertId} already queued — skipping`);
        return;
    }
    // ── Determine whether this alert meets the notification threshold ──────────
    const isHighPriority = priority === "high" || priority === "critical";
    const isHighImportanceType = typeof type === "string" && HIGH_IMPORTANCE_TYPES.has(type);
    if (!isHighPriority && !isHighImportanceType) {
        console.log(`[onAdminAlertCreated] ${alertId} skipped — priority="${priority}" type="${type}" below threshold`);
        return;
    }
    const adminEmail = (_a = process.env.ADMIN_EMAIL) !== null && _a !== void 0 ? _a : "admin@careconnex.com";
    const now = new Date().toISOString();
    // ── Write to admin_email_queue ─────────────────────────────────────────────
    try {
        await db.collection("admin_email_queue").add({
            to: adminEmail,
            subject: `[Cara Alert] ${type !== null && type !== void 0 ? type : "unknown"} — ${priority !== null && priority !== void 0 ? priority : "medium"} priority`,
            body: `Alert type: ${type !== null && type !== void 0 ? type : "unknown"}\n` +
                `Priority: ${priority !== null && priority !== void 0 ? priority : "medium"}\n` +
                `Details: ${JSON.stringify(alert, null, 2)}\n` +
                `Created: ${(_b = alert.createdAt) !== null && _b !== void 0 ? _b : now}\n` +
                `Alert ID: ${alertId}`,
            createdAt: now,
            sent: false,
        });
        // Mark the alert so it isn't re-queued on a re-trigger
        await snap.ref.update({ emailQueued: true });
        console.log(`[onAdminAlertCreated] Email queued for alert ${alertId} (type="${type}" priority="${priority}")`);
    }
    catch (err) {
        console.error(`[onAdminAlertCreated] Failed to queue email for alert ${alertId}:`, err);
        // Do not rethrow — a failed queue write should not block push notification attempts
    }
    // ── Push notification for specific high-urgency types ─────────────────────
    const adminPhone = process.env.ADMIN_PHONE;
    if (adminPhone && typeof type === "string" && PUSH_NOTIFY_TYPES.has(type)) {
        await (0, caraAgent_1.sendViaInteractionAgent)(adminPhone, {
            content: `Cara Alert: ${type} — check admin dashboard.`,
            urgency: "urgent",
            sourceAgent: "admin_alert_notifier",
            canDrop: false,
        }).catch(err => console.error(`[onAdminAlertCreated] Push notification failed for alert ${alertId}:`, err));
    }
});
//# sourceMappingURL=adminAlertNotifier.js.map