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
exports.sendClientThirtyMinReminders = void 0;
const functions = __importStar(require("firebase-functions/v1"));
const admin = __importStar(require("firebase-admin"));
const caraAgent_1 = require("../agents/caraAgent");
const caraMessage_1 = require("../utils/caraMessage");
const db = admin.firestore();
// 30-min client notification — "Alice is on her way for Linda's 9am visit."
// Heads-up only; no response expected. Suppressed if the family already
// cancelled (status: client_cancel_requested) or if a heads-up has already
// gone out for this appointment.
exports.sendClientThirtyMinReminders = functions.pubsub
    .schedule("*/15 * * * *")
    .onRun(async () => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
    const now = new Date();
    const nowMs = now.getTime();
    const today = now.toISOString().slice(0, 10);
    const windowStartMs = nowMs + 25 * 60 * 1000;
    const windowEndMs = nowMs + 40 * 60 * 1000;
    const snap = await db.collection("appointments")
        .where("date", "==", today)
        .where("status", "==", "confirmed")
        .where("clientThirtyMinReminderSent", "!=", true)
        .get();
    for (const doc of snap.docs) {
        const appt = doc.data();
        const apptId = doc.id;
        const startTime = ((_b = (_a = appt.startTime) !== null && _a !== void 0 ? _a : appt.time) !== null && _b !== void 0 ? _b : "");
        if (!startTime)
            continue;
        const apptMs = parseAppointmentTimeMs(today, startTime);
        if (apptMs === null || apptMs < windowStartMs || apptMs > windowEndMs)
            continue;
        const clientId = ((_c = appt.clientId) !== null && _c !== void 0 ? _c : "");
        const caregiverId = ((_d = appt.caregiverId) !== null && _d !== void 0 ? _d : "");
        if (!clientId || !caregiverId)
            continue;
        try {
            const userSnap = await db.collection("users").doc(clientId).get();
            const clientPhone = (_e = userSnap.data()) === null || _e === void 0 ? void 0 : _e.phone;
            if (!clientPhone)
                continue;
            const sessionSnap = await db.collection("agent_sessions").doc(clientPhone).get();
            if (!sessionSnap.exists || ((_f = sessionSnap.data()) === null || _f === void 0 ? void 0 : _f.optedOut))
                continue;
            const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
            const cgName = ((_h = (_g = cgSnap.data()) === null || _g === void 0 ? void 0 : _g.name) !== null && _h !== void 0 ? _h : "your caregiver");
            const cgFirstName = cgName.split(" ")[0];
            const seniorName = ((_k = (_j = appt.seniorName) !== null && _j !== void 0 ? _j : appt.clientName) !== null && _k !== void 0 ? _k : "your loved one");
            const lang = ((_l = sessionSnap.data()) === null || _l === void 0 ? void 0 : _l.preferredLanguage) === "es" ? "es" : "en";
            const message = await (0, caraMessage_1.generateCaraMessage)({
                audience: "family",
                language: lang,
                context: `Write a brief, warm heads-up to a family member that their caregiver is on the way.\n` +
                    `Caregiver: ${cgFirstName}\n` +
                    `Senior: ${seniorName}\n` +
                    `Start time: ${startTime}\n` +
                    `Tone: light, no response needed. Mention they'll arrive around the start time. ` +
                    `Do NOT ask them to do anything.`,
                fallback: lang === "es"
                    ? `${cgFirstName} está en camino para la visita de ${seniorName} a las ${startTime}. 💙`
                    : `${cgFirstName} is on the way for ${seniorName}'s ${startTime} visit. 💙`,
            });
            await (0, caraAgent_1.sendViaInteractionAgent)(clientPhone, {
                content: message,
                urgency: "standard",
                sourceAgent: "client_thirty_min_reminder",
                canDrop: true, // family doesn't strictly need this; respect DND
            });
            await doc.ref.update({ clientThirtyMinReminderSent: true });
        }
        catch (err) {
            console.error(`[sendClientThirtyMinReminders] Error for appointment ${apptId}:`, err);
        }
    }
});
function parseAppointmentTimeMs(dateStr, timeStr) {
    const trimmed = timeStr.trim();
    let h = null;
    let m = null;
    const ampm = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (ampm) {
        h = parseInt(ampm[1], 10);
        m = parseInt(ampm[2], 10);
        if (ampm[3].toUpperCase() === "AM" && h === 12)
            h = 0;
        if (ampm[3].toUpperCase() === "PM" && h !== 12)
            h += 12;
    }
    else {
        const h24 = trimmed.match(/^(\d{1,2}):(\d{2})$/);
        if (h24) {
            h = parseInt(h24[1], 10);
            m = parseInt(h24[2], 10);
        }
    }
    if (h === null || m === null)
        return null;
    return new Date(`${dateStr}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`).getTime();
}
//# sourceMappingURL=clientThirtyMinReminder.js.map