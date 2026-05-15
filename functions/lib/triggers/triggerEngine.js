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
    if (snap.empty)
        return;
    const batch = db.batch();
    for (const doc of snap.docs) {
        batch.update(doc.ref, { cancelledAt: now });
    }
    await batch.commit().catch(() => { });
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
});
exports.triggerEngineScheduled = exports.runTriggerEngine;
//# sourceMappingURL=triggerEngine.js.map