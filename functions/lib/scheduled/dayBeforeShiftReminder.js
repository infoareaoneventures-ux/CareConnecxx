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
exports.sendDayBeforeShiftReminders = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const caraAgent_1 = require("../agents/caraAgent");
const caraMessage_1 = require("../utils/caraMessage");
const db = admin.firestore();
// Runs daily at 6 PM ET — sends a warm confirmation request to caregivers
// for all shifts scheduled tomorrow, then notifies families of confirmed shifts.
exports.sendDayBeforeShiftReminders = functions.pubsub
    .schedule("0 22 * * *")
    .timeZone("America/New_York")
    .onRun(async () => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);
    // Format as "Wednesday, May 21" for natural reading
    const tomorrowDisplay = tomorrow.toLocaleDateString("en-US", {
        weekday: "long", month: "long", day: "numeric",
    });
    const snap = await db.collection("appointments")
        .where("date", "==", tomorrowStr)
        .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
        .where("dayBeforeConfirmSent", "!=", true)
        .get();
    for (const doc of snap.docs) {
        const appt = doc.data();
        const apptId = doc.id;
        const caregiverId = ((_a = appt.caregiverId) !== null && _a !== void 0 ? _a : "");
        const clientId = ((_b = appt.clientId) !== null && _b !== void 0 ? _b : "");
        if (!caregiverId || !clientId)
            continue;
        try {
            const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
            const cgData = cgSnap.data();
            const cgPhone = cgData === null || cgData === void 0 ? void 0 : cgData.phone;
            if (!cgPhone)
                continue;
            const cgSessionSnap = await db.collection("agent_sessions").doc(cgPhone).get();
            if (!cgSessionSnap.exists || ((_c = cgSessionSnap.data()) === null || _c === void 0 ? void 0 : _c.optedOut))
                continue;
            const cgFirstName = ((_d = cgData === null || cgData === void 0 ? void 0 : cgData.name) !== null && _d !== void 0 ? _d : "there").split(" ")[0];
            const seniorName = ((_f = (_e = appt.clientName) !== null && _e !== void 0 ? _e : appt.seniorName) !== null && _f !== void 0 ? _f : "your client");
            const startTime = ((_h = (_g = appt.startTime) !== null && _g !== void 0 ? _g : appt.time) !== null && _h !== void 0 ? _h : "");
            const address = ((_k = (_j = appt.address) !== null && _j !== void 0 ? _j : appt.location) !== null && _k !== void 0 ? _k : "");
            const message = await (0, caraMessage_1.generateCaraMessage)({
                audience: "caregiver",
                context: `Write a casual, warm evening text to ${cgFirstName} reminding them about their shift tomorrow.\n` +
                    `Senior: ${seniorName}\n` +
                    `Date: ${tomorrowDisplay}\n` +
                    `Start time: ${startTime || "time TBD"}\n` +
                    `Location: ${address || "client's home"}\n` +
                    `Ask them to reply YES to confirm they'll be there or NO if something's come up. ` +
                    `Sound like you're genuinely checking in — not sending an automated alert.`,
                fallback: `Hey ${cgFirstName}! Hope your evening's going well. Just checking in — you've got ` +
                    `${seniorName}'s visit ${startTime ? "at " + startTime : "tomorrow"}${address ? " at " + address : ""}` +
                    `. Still all good on your end? Reply YES to confirm or NO if something's come up.`,
            });
            await (0, caraAgent_1.sendViaInteractionAgent)(cgPhone, {
                content: message,
                urgency: "standard",
                sourceAgent: "day_before_shift_reminder",
                canDrop: false,
            });
            await doc.ref.update({ dayBeforeConfirmSent: true });
            await cgSessionSnap.ref.update({
                pendingShiftConfirmation: {
                    appointmentId: apptId,
                    appointmentDate: tomorrowStr,
                    appointmentDisplay: tomorrowDisplay,
                    clientId,
                    seniorName,
                    startTime,
                    caregiverName: (_l = cgData === null || cgData === void 0 ? void 0 : cgData.name) !== null && _l !== void 0 ? _l : "",
                    sentAt: new Date().toISOString(),
                },
                stateExpiresAt: new Date(Date.now() + 16 * 60 * 60 * 1000).toISOString(),
            });
        }
        catch (err) {
            console.error(`[sendDayBeforeShiftReminders] Error for appointment ${apptId}:`, err);
        }
    }
});
//# sourceMappingURL=dayBeforeShiftReminder.js.map