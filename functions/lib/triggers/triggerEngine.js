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
exports.triggerEngineScheduled = exports.runTriggerEngine = void 0;
exports.scheduleTrigger = scheduleTrigger;
exports.cancelTriggerIfUserReplied = cancelTriggerIfUserReplied;
exports.markTriggerEngaged = markTriggerEngaged;
exports.checkIgnoredTriggers = checkIgnoredTriggers;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const caraAgent_1 = require("../agents/caraAgent");
const db = admin.firestore();
// 30-day calibration period — no proactive triggers during this window
function isInCalibrationPeriod(sessionCreatedAt) {
    const createdMs = new Date(sessionCreatedAt).getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    return Date.now() - createdMs < thirtyDaysMs;
}
// Schedule a proactive trigger — no-op during calibration period
async function scheduleTrigger(trigger) {
    // Check calibration
    const sessionSnap = await db.collection("agent_sessions").doc(trigger.phone).get();
    if (sessionSnap.exists) {
        const session = sessionSnap.data();
        if (session.createdAt && isInCalibrationPeriod(session.createdAt)) {
            return ""; // Silently skip during calibration
        }
    }
    const ref = await db.collection("proactive_triggers").add(Object.assign(Object.assign({}, trigger), { createdAt: new Date().toISOString() }));
    return ref.id;
}
// Called at the top of the main webhook handler (after crisis check) to cancel pending triggers
// Twin-trigger pattern: if user replied, cancel their scheduled nudge
async function cancelTriggerIfUserReplied(userId, phone) {
    const now = new Date().toISOString();
    const snap = await db
        .collection("proactive_triggers")
        .where("userId", "==", userId)
        .where("cancelledAt", "==", null)
        .where("firedAt", "==", null)
        .get();
    if (!snap.empty) {
        const batch = db.batch();
        for (const doc of snap.docs) {
            batch.update(doc.ref, { cancelledAt: now });
        }
        await batch.commit().catch(() => { });
    }
    // Mark any recently-fired triggers as engaged — user replied
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const firedSnap = await db
        .collection("proactive_triggers")
        .where("userId", "==", userId)
        .where("firedAt", ">=", oneDayAgo)
        .get();
    for (const doc of firedSnap.docs) {
        const data = doc.data();
        if (!data.firedAt || data.engagedAt)
            continue;
        await doc.ref.update({ engagedAt: now });
        await markTriggerEngaged(phone, data.type);
    }
}
// Reset consecutive-ignore count when user engages with a trigger
async function markTriggerEngaged(phone, triggerType) {
    await db.collection("trigger_engagement")
        .doc(`${phone}_${triggerType}`)
        .set({ consecutiveIgnores: 0, lastEngagedAt: new Date().toISOString() }, { merge: true });
}
async function pauseTriggerType(phone, triggerType) {
    await db.collection("trigger_engagement")
        .doc(`${phone}_${triggerType}`)
        .set({ paused: true, pausedAt: new Date().toISOString() }, { merge: true });
    // Cancel any pending triggers of this type for this user
    const snap = await db.collection("proactive_triggers")
        .where("phone", "==", phone)
        .where("type", "==", triggerType)
        .get();
    const now = new Date().toISOString();
    const batch = db.batch();
    for (const doc of snap.docs) {
        const d = doc.data();
        if (!d.firedAt && !d.cancelledAt)
            batch.update(doc.ref, { cancelledAt: now });
    }
    await batch.commit().catch(() => { });
}
// Detect triggers fired 24h+ ago with no user response; pause after 3 consecutive ignores
async function checkIgnoredTriggers() {
    var _a, _b, _c;
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const snap = await db.collection("proactive_triggers")
        .where("firedAt", "<=", oneDayAgo)
        .get();
    for (const doc of snap.docs) {
        const trigger = doc.data();
        if (!trigger.firedAt)
            continue;
        if (trigger.engagedAt)
            continue; // user did engage
        if (trigger.ignoreCounted)
            continue; // already counted
        const engRef = db.collection("trigger_engagement").doc(`${trigger.phone}_${trigger.type}`);
        const engSnap = await engRef.get();
        const prev = (_b = (_a = engSnap.data()) === null || _a === void 0 ? void 0 : _a.consecutiveIgnores) !== null && _b !== void 0 ? _b : 0;
        const consecutiveIgnores = prev + 1;
        await engRef.set({
            phone: trigger.phone,
            triggerType: trigger.type,
            consecutiveIgnores,
            lastIgnoredAt: new Date().toISOString(),
        }, { merge: true });
        await doc.ref.update({ ignoreCounted: true });
        if (consecutiveIgnores >= 3) {
            await pauseTriggerType(trigger.phone, trigger.type);
            const triggerFriendlyNames = {
                appointment_reminder: "appointment reminders",
                weekly_checkin: "weekly check-ins",
                medication_reminder: "medication reminders",
                custom: "these messages",
            };
            const friendlyName = (_c = triggerFriendlyNames[trigger.type]) !== null && _c !== void 0 ? _c : "these messages";
            await (0, caraAgent_1.sendViaInteractionAgent)(trigger.phone, {
                content: `I've paused the ${friendlyName} since you haven't been using them lately.\n\n` +
                    `Want me to turn them back on, try a different time, or skip them for now?`,
                urgency: "standard",
                sourceAgent: "trigger_engine",
                canDrop: false,
            });
        }
    }
}
// Every-5-minute executor — fires due triggers, skips cancelled/fired ones
exports.runTriggerEngine = functions.pubsub
    .schedule("*/5 * * * *")
    .onRun(async () => {
    var _a;
    const now = new Date().toISOString();
    const snap = await db
        .collection("proactive_triggers")
        .where("scheduledAt", "<=", now)
        .get();
    for (const doc of snap.docs) {
        const trigger = doc.data();
        // Skip already fired or cancelled
        if (trigger.firedAt || trigger.cancelledAt)
            continue;
        // Twin-trigger: check if user sent a message since trigger was created
        const lastReply = await db
            .collection("agent_conversations")
            .doc(trigger.phone)
            .collection("messages")
            .where("role", "==", "user")
            .where("timestamp", ">=", new Date(trigger.createdAt).getTime())
            .limit(1)
            .get();
        if (!lastReply.empty) {
            // User already replied — cancel the trigger
            await doc.ref.update({ cancelledAt: now });
            continue;
        }
        // Get user's session to find chatId
        const sessionSnap = await db.collection("agent_sessions").doc(trigger.phone).get();
        if (!sessionSnap.exists) {
            await doc.ref.update({ cancelledAt: now });
            continue;
        }
        const session = sessionSnap.data();
        if (session.optedOut) {
            await doc.ref.update({ cancelledAt: now });
            continue;
        }
        try {
            // Replacement escalation — check if task still awaiting, escalate if so
            if (trigger.message.startsWith("replacement_task:")) {
                const taskId = trigger.message.slice("replacement_task:".length);
                const taskSnap = await db.collection("agent_tasks").doc(taskId).get();
                const task = taskSnap.data();
                if (task && task.status === "awaiting_approval") {
                    const { handleNoReplacementsFound } = await Promise.resolve().then(() => __importStar(require("../agents/replacementAgent")));
                    await handleNoReplacementsFound(task.appointmentId, task.clientId, task.clientPhone, { caregiverName: task.caregiverName, date: task.date, time: task.time });
                }
            }
            else {
                await (0, caraAgent_1.sendViaInteractionAgent)(trigger.phone, {
                    content: trigger.message,
                    urgency: "standard",
                    sourceAgent: "trigger_engine",
                    canDrop: true,
                });
            }
            await doc.ref.update({ firedAt: now });
        }
        catch (err) {
            console.error("triggerEngine: failed to send for", doc.id, err);
        }
    }
    // ── No-show detection — check for unacknowledged confirmed visits ─────────
    const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const noShowSnap = await db
        .collection("appointments")
        .where("status", "==", "confirmed")
        .where("startDateTime", "<=", twentyMinAgo)
        .where("noShowChecked", "==", null)
        .limit(10)
        .get();
    for (const apptDoc of noShowSnap.docs) {
        const appt = apptDoc.data();
        if (appt.arrivedAt)
            continue; // caregiver arrived, not a no-show
        await apptDoc.ref.update({ noShowChecked: now });
        try {
            const clientSnap = await db.collection("users").doc(appt.clientId).get();
            const phone = (_a = clientSnap.data()) === null || _a === void 0 ? void 0 : _a.phone;
            if (!phone)
                continue;
            const { runEmergencyReplacement } = await Promise.resolve().then(() => __importStar(require("../agents/replacementAgent")));
            await runEmergencyReplacement({
                appointmentId: apptDoc.id,
                clientId: appt.clientId,
                clientPhone: phone,
                appt,
            });
        }
        catch (err) {
            console.error("triggerEngine no-show handling error for", apptDoc.id, err);
        }
    }
    // Check for ignored triggers and pause after 3 consecutive ignores
    await checkIgnoredTriggers().catch((err) => console.error("checkIgnoredTriggers error:", err));
});
exports.triggerEngineScheduled = exports.runTriggerEngine;
//# sourceMappingURL=triggerEngine.js.map