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
exports.sendPreShiftFamilyCheckin = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const caraAgent_1 = require("../agents/caraAgent");
const caraMessage_1 = require("../utils/caraMessage");
const db = admin.firestore();
function parseStartTimeToMinutes(timeStr) {
    const trimmed = (timeStr !== null && timeStr !== void 0 ? timeStr : "").trim();
    const ampm = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (ampm) {
        let h = parseInt(ampm[1], 10);
        const m = parseInt(ampm[2], 10);
        if (ampm[3].toUpperCase() === "AM" && h === 12)
            h = 0;
        if (ampm[3].toUpperCase() === "PM" && h !== 12)
            h += 12;
        return h * 60 + m;
    }
    const h24 = trimmed.match(/^(\d{1,2}):(\d{2})$/);
    if (h24) {
        const h = parseInt(h24[1], 10);
        const m = parseInt(h24[2], 10);
        if (h >= 0 && h <= 23 && m >= 0 && m <= 59)
            return h * 60 + m;
    }
    return null;
}
// Runs every 15 minutes — 15 minutes before a shift, asks the family if they
// want to add any tasks or special instructions for that day.
exports.sendPreShiftFamilyCheckin = functions.pubsub
    .schedule("*/15 * * * *")
    .onRun(async () => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const windowStart = nowMinutes + 15;
    const windowEnd = nowMinutes + 30;
    const today = now.toISOString().slice(0, 10);
    const snap = await db.collection("appointments")
        .where("date", "==", today)
        .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
        .where("preShiftCheckinSent", "!=", true)
        .get();
    for (const doc of snap.docs) {
        const appt = doc.data();
        const apptId = doc.id;
        const clientId = ((_a = appt.clientId) !== null && _a !== void 0 ? _a : "");
        const startTime = ((_b = appt.startTime) !== null && _b !== void 0 ? _b : "");
        if (!clientId || !startTime)
            continue;
        const startMinutes = parseStartTimeToMinutes(startTime);
        if (startMinutes === null)
            continue;
        if (startMinutes < windowStart || startMinutes > windowEnd)
            continue;
        try {
            const sessionSnap = await db.collection("agent_sessions")
                .where("userId", "==", clientId)
                .limit(1)
                .get();
            if (sessionSnap.empty)
                continue;
            const sessionDoc = sessionSnap.docs[0];
            const sessionData = sessionDoc.data();
            if (sessionData.optedOut)
                continue;
            const clientPhone = ((_c = sessionData.phone) !== null && _c !== void 0 ? _c : sessionDoc.id);
            const caregiverName = ((_d = appt.caregiverName) !== null && _d !== void 0 ? _d : "Your caregiver");
            const cgFirstName = caregiverName.split(" ")[0] || caregiverName;
            const seniorName = ((_f = (_e = appt.clientName) !== null && _e !== void 0 ? _e : appt.seniorName) !== null && _f !== void 0 ? _f : "your loved one");
            const clientSnap = await db.collection("users").doc(clientId).get().catch(() => null);
            const familyFirst = ((_k = (_h = (_g = clientSnap === null || clientSnap === void 0 ? void 0 : clientSnap.data()) === null || _g === void 0 ? void 0 : _g.displayName) !== null && _h !== void 0 ? _h : (_j = clientSnap === null || clientSnap === void 0 ? void 0 : clientSnap.data()) === null || _j === void 0 ? void 0 : _j.name) !== null && _k !== void 0 ? _k : "")
                .split(" ")[0] || "";
            const message = await (0, caraMessage_1.generateCaraMessage)({
                audience: "family",
                context: `Write a friendly, brief text to ${familyFirst || "the family"} — ` +
                    `${cgFirstName} is about 15 minutes away from starting ${seniorName}'s care visit.\n` +
                    `Ask if there's anything they'd like added to today's plan — any tasks or special instructions ` +
                    `that aren't already in the regular care routine. ` +
                    `Keep it casual and easy to respond to. They can reply with tasks or just say NO if the regular plan is fine.`,
                fallback: `${familyFirst ? "Hey " + familyFirst + "! " : ""}${cgFirstName} is heading over to see ${seniorName} — ` +
                    `about 15 minutes out. Anything you'd like added to today's plan, or are we good with the regular routine? ` +
                    `Just reply with any tasks, or NO if everything's set!`,
            });
            await (0, caraAgent_1.sendViaInteractionAgent)(clientPhone, {
                content: message,
                urgency: "standard",
                sourceAgent: "pre_shift_checkin",
                canDrop: true,
            });
            await doc.ref.update({ preShiftCheckinSent: true });
            await sessionDoc.ref.update({
                awaitingPreShiftUpdate: {
                    appointmentId: apptId,
                    caregiverName,
                    seniorName,
                    sentAt: new Date().toISOString(),
                },
                stateExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            });
        }
        catch (err) {
            console.error(`[sendPreShiftFamilyCheckin] Error for appointment ${apptId}:`, err);
        }
    }
});
//# sourceMappingURL=preShiftFamilyCheckin.js.map