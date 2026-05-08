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
exports.onAppointmentUpdated = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const client_1 = require("../linq/client");
const replacementScorer_1 = require("../agents/replacementScorer");
const db = admin.firestore();
// ── Helpers ───────────────────────────────────────────────────────────────────
async function getClientPhone(clientId) {
    var _a, _b;
    const snap = await db.collection("users").doc(clientId).get();
    return (_b = (_a = snap.data()) === null || _a === void 0 ? void 0 : _a.phone) !== null && _b !== void 0 ? _b : null;
}
async function getSession(phone) {
    const snap = await db.collection("agent_sessions").doc(phone).get();
    if (!snap.exists)
        return null;
    const s = snap.data();
    return (s.optedOut || s.optedIn === false) ? null : s;
}
async function getCaregiverPhone(caregiverId) {
    var _a, _b;
    const snap = await db.collection("caregivers").doc(caregiverId).get();
    return (_b = (_a = snap.data()) === null || _a === void 0 ? void 0 : _a.phone) !== null && _b !== void 0 ? _b : null;
}
// ── Main trigger ──────────────────────────────────────────────────────────────
exports.onAppointmentUpdated = functions.firestore
    .document("appointments/{appointmentId}")
    .onUpdate(async (change) => {
    var _a, _b;
    try {
        const before = change.before.data();
        const after = change.after.data();
        if (!after.clientId)
            return;
        const statusChanged = before.status !== after.status;
        if (!statusChanged)
            return;
        const phone = await getClientPhone(after.clientId);
        if (!phone)
            return;
        // ── Caregiver cancellation → emergency replacement flow ───────────────
        if (after.status === "cancelled" &&
            after.cancelledBy === "caregiver") {
            await handleCaregiverCancellation(change.after.id, after, phone);
            return;
        }
        // ── Arrival / in-progress ────────────────────────────────────────────
        if (after.status === "in-progress" && before.status !== "in-progress") {
            const session = await getSession(phone);
            const msg = `${(_a = after.caregiverName) !== null && _a !== void 0 ? _a : "Your caregiver"} has arrived for your ${after.time} visit. ✅`;
            if (session) {
                await (0, client_1.sendMessage)(session.chatId, msg);
            }
            else {
                await (0, client_1.sendToPhone)(phone, msg);
            }
            await db.collection("agent_alerts_log").add({
                type: "caregiver_arrived", clientId: after.clientId, phone,
                appointmentId: change.after.id, sentAt: new Date().toISOString(),
            });
            return;
        }
        // ── Booking confirmed → notify caregiver ────────────────────────────
        if (after.status === "confirmed" && before.status !== "confirmed" && after.caregiverId) {
            const caregiverPhone = await getCaregiverPhone(after.caregiverId);
            if (caregiverPhone) {
                const msg = `✅ Booking confirmed!\n` +
                    `📅 ${after.date} at ${after.time}\n` +
                    (after.clientName ? `👤 ${after.clientName}\n` : "") +
                    (after.address ? `📍 ${after.address}` : "");
                await (0, client_1.sendToPhone)(caregiverPhone, msg);
            }
            return;
        }
        // ── Visit completed ──────────────────────────────────────────────────
        if (after.status === "completed" && before.status !== "completed") {
            const session = await getSession(phone);
            const msg = `${(_b = after.caregiverName) !== null && _b !== void 0 ? _b : "Your caregiver"}'s visit is complete. ` +
                `A care journal entry will be posted shortly.`;
            if (session) {
                await (0, client_1.sendMessage)(session.chatId, msg);
            }
            else {
                await (0, client_1.sendToPhone)(phone, msg);
            }
            await db.collection("agent_alerts_log").add({
                type: "visit_completed", clientId: after.clientId, phone,
                appointmentId: change.after.id, sentAt: new Date().toISOString(),
            });
            return;
        }
    }
    catch (err) {
        console.error("onAppointmentUpdated error:", err);
    }
});
// ── Emergency replacement flow ────────────────────────────────────────────────
async function handleCaregiverCancellation(appointmentId, appt, phone) {
    var _a, _b;
    const session = await getSession(phone);
    // Get top 3 replacement caregivers
    const options = await (0, replacementScorer_1.scoreReplacements)({
        clientId: appt.clientId,
        appointmentId,
        date: appt.date,
        time: appt.time,
        excludeId: appt.caregiverId,
    });
    if (options.length === 0) {
        const noMatchMsg = `${(_a = appt.caregiverName) !== null && _a !== void 0 ? _a : "Your caregiver"} had to cancel today's ${appt.time} visit. ` +
            `I wasn't able to find available replacements right now. ` +
            `Please open the app or contact support to reschedule.`;
        if (session)
            await (0, client_1.sendMessage)(session.chatId, noMatchMsg);
        else
            await (0, client_1.sendToPhone)(phone, noMatchMsg);
        return;
    }
    // Generate a confirmation token for the QuickConfirm page
    const confirmToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const taskRef = await db.collection("agent_tasks").add({
        type: "replacement",
        appointmentId,
        clientId: appt.clientId,
        clientPhone: phone,
        options,
        confirmToken,
        status: "awaiting_approval",
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 min
        createdAt: new Date().toISOString(),
    });
    const numberEmojis = ["1️⃣", "2️⃣", "3️⃣"];
    const optionLines = options
        .slice(0, 3)
        .map((o, i) => {
        const rebookedNote = o.previouslyBooked ? " · booked before" : "";
        return `${numberEmojis[i]} ${o.name} · ${o.rating}⭐ · $${o.hourlyRate}/hr${rebookedNote}`;
    })
        .join("\n");
    const cancelMsg = `${(_b = appt.caregiverName) !== null && _b !== void 0 ? _b : "Your caregiver"} had to cancel today's ${appt.time} visit.\n\n` +
        `I found ${options.length} available caregiver${options.length > 1 ? "s" : ""}:\n\n` +
        `${optionLines}\n\n` +
        `Reply 1, 2, or 3. Nothing is booked until you confirm.`;
    if (session) {
        await (0, client_1.sendMessage)(session.chatId, cancelMsg);
    }
    else {
        await (0, client_1.sendToPhone)(phone, cancelMsg);
    }
    await db.collection("agent_alerts_log").add({
        type: "caregiver_cancelled", clientId: appt.clientId, phone,
        appointmentId, taskId: taskRef.id, sentAt: new Date().toISOString(),
    });
}
//# sourceMappingURL=appointmentUpdated.js.map