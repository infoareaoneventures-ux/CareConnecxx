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
exports.sendThirtyMinShiftReminders = void 0;
const functions = __importStar(require("firebase-functions/v1"));
const admin = __importStar(require("firebase-admin"));
const caraAgent_1 = require("../agents/caraAgent");
const caraMessage_1 = require("../utils/caraMessage");
const db = admin.firestore();
// Runs every 15 minutes — sends a warm Cara reminder to caregivers
// whose shift is starting in 25–40 minutes.
exports.sendThirtyMinShiftReminders = functions.pubsub
    .schedule("*/15 * * * *")
    .onRun(async () => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    const now = new Date();
    const nowMs = now.getTime();
    const today = now.toISOString().slice(0, 10);
    const windowStartMs = nowMs + 25 * 60 * 1000;
    const windowEndMs = nowMs + 40 * 60 * 1000;
    const snap = await db.collection("appointments")
        .where("date", "==", today)
        .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
        .where("caraThirtyMinReminderSent", "!=", true)
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
        const caregiverId = ((_c = appt.caregiverId) !== null && _c !== void 0 ? _c : "");
        if (!caregiverId)
            continue;
        try {
            const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
            const cgData = cgSnap.data();
            const cgPhone = cgData === null || cgData === void 0 ? void 0 : cgData.phone;
            if (!cgPhone)
                continue;
            const cgSessionSnap = await db.collection("agent_sessions").doc(cgPhone).get();
            if (!cgSessionSnap.exists || ((_d = cgSessionSnap.data()) === null || _d === void 0 ? void 0 : _d.optedOut))
                continue;
            const cgFirstName = ((_e = cgData === null || cgData === void 0 ? void 0 : cgData.name) !== null && _e !== void 0 ? _e : "there").split(" ")[0];
            const seniorName = ((_g = (_f = appt.clientName) !== null && _f !== void 0 ? _f : appt.seniorName) !== null && _g !== void 0 ? _g : "your client");
            const address = ((_j = (_h = appt.address) !== null && _h !== void 0 ? _h : appt.location) !== null && _j !== void 0 ? _j : "");
            const message = await (0, caraMessage_1.generateCaraMessage)({
                audience: "caregiver",
                context: `Write a short, upbeat heads-up text to ${cgFirstName} — their shift starts in 30 minutes.\n` +
                    `Senior: ${seniorName}\n` +
                    `Start time: ${startTime}\n` +
                    `Address: ${address || "client's home"}\n` +
                    `Remind them to text ARRIVED when they get there and LATE if they're running behind. ` +
                    `Keep it light and encouraging — like a quick text from a friend.`,
                fallback: `Hey ${cgFirstName}, just a heads-up — ${seniorName}'s visit starts in about 30 minutes` +
                    `${address ? " at " + address : ""}. ` +
                    `Safe travels! Text ARRIVED when you're there or LATE if you hit any traffic. 🚗`,
            });
            await (0, caraAgent_1.sendViaInteractionAgent)(cgPhone, {
                content: message,
                urgency: "standard",
                sourceAgent: "thirty_min_shift_reminder",
                canDrop: false,
            });
            await doc.ref.update({ caraThirtyMinReminderSent: true });
        }
        catch (err) {
            console.error(`[sendThirtyMinShiftReminders] Error for appointment ${apptId}:`, err);
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
//# sourceMappingURL=thirtyMinShiftReminder.js.map