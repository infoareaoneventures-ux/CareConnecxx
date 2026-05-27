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
exports.sendClientDayBeforeReminders = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const caraAgent_1 = require("../agents/caraAgent");
const caraMessage_1 = require("../utils/caraMessage");
const db = admin.firestore();
// Day-before client reminder. Mirror of sendDayBeforeShiftReminders but sends
// the heads-up to the FAMILY for confirmed shifts. Runs at 8 PM ET — late
// enough that the caregiver's confirmation has had time to come in (caregiver
// reminder fires at 6 PM ET), early enough not to interrupt evening routines.
//
// CONFIRM is optional — silence is treated as "yes I expect them." CANCEL
// initiates a client cancellation flow handled inbound. Question replies are
// routed through the standard QA path via the dispatcher.
exports.sendClientDayBeforeReminders = functions.pubsub
    .schedule("0 0 * * *") // 0:00 UTC = 8 PM ET (DST handled by timeZone)
    .timeZone("America/New_York")
    .onRun(async () => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);
    const tomorrowDisplay = tomorrow.toLocaleDateString("en-US", {
        weekday: "long", month: "long", day: "numeric",
    });
    // Only send for confirmed appointments — skip pending_caregiver_confirmation
    // (we don't want to tell the family it's locked in if the caregiver hasn't
    // confirmed yet) and skip ones we've already reminded.
    const snap = await db.collection("appointments")
        .where("date", "==", tomorrowStr)
        .where("status", "==", "confirmed")
        .where("clientDayBeforeReminderSent", "!=", true)
        .get();
    for (const doc of snap.docs) {
        const appt = doc.data();
        const apptId = doc.id;
        const clientId = ((_a = appt.clientId) !== null && _a !== void 0 ? _a : "");
        const caregiverId = ((_b = appt.caregiverId) !== null && _b !== void 0 ? _b : "");
        if (!clientId || !caregiverId)
            continue;
        try {
            const userSnap = await db.collection("users").doc(clientId).get();
            const userData = userSnap.data();
            const clientPhone = userData === null || userData === void 0 ? void 0 : userData.phone;
            if (!clientPhone)
                continue;
            const sessionSnap = await db.collection("agent_sessions").doc(clientPhone).get();
            if (!sessionSnap.exists || ((_c = sessionSnap.data()) === null || _c === void 0 ? void 0 : _c.optedOut))
                continue;
            const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
            const cgName = ((_e = (_d = cgSnap.data()) === null || _d === void 0 ? void 0 : _d.name) !== null && _e !== void 0 ? _e : "your caregiver");
            const cgFirstName = cgName.split(" ")[0];
            const seniorName = ((_g = (_f = appt.seniorName) !== null && _f !== void 0 ? _f : appt.clientName) !== null && _g !== void 0 ? _g : "your loved one");
            const startTime = ((_j = (_h = appt.startTime) !== null && _h !== void 0 ? _h : appt.time) !== null && _j !== void 0 ? _j : "");
            const lang = ((_k = sessionSnap.data()) === null || _k === void 0 ? void 0 : _k.preferredLanguage) === "es" ? "es" : "en";
            const message = await (0, caraMessage_1.generateCaraMessage)({
                audience: "family",
                language: lang,
                context: `Write a short, warm evening heads-up to a family member that their care visit is tomorrow.\n` +
                    `Caregiver: ${cgFirstName}\n` +
                    `Senior: ${seniorName}\n` +
                    `Date: ${tomorrowDisplay}\n` +
                    `Start time: ${startTime || "time TBD"}\n` +
                    `Tone: reassuring, not pushy. Mention they don't need to do anything — but they can reply ` +
                    `CANCEL if something's come up, or just ask any question they have. Don't sound like an ` +
                    `automated reminder.`,
                fallback: lang === "es"
                    ? `Solo un aviso — ${cgFirstName} pasará mañana${startTime ? " a las " + startTime : ""}` +
                        ` para ${seniorName}. No necesitas hacer nada; responde CANCEL si algo cambió, ` +
                        `o escríbeme si tienes preguntas.`
                    : `Just a heads up — ${cgFirstName} will be by tomorrow${startTime ? " at " + startTime : ""}` +
                        ` for ${seniorName}. You don't need to do anything; reply CANCEL if something's changed, ` +
                        `or text me any questions.`,
            });
            await (0, caraAgent_1.sendViaInteractionAgent)(clientPhone, {
                content: message,
                urgency: "standard",
                sourceAgent: "client_day_before_reminder",
                canDrop: false,
            });
            await doc.ref.update({ clientDayBeforeReminderSent: true });
            await sessionSnap.ref.update({
                pendingClientShiftConfirm: {
                    appointmentId: apptId,
                    appointmentDate: tomorrowStr,
                    appointmentDisplay: tomorrowDisplay,
                    caregiverId,
                    caregiverName: cgName,
                    seniorName,
                    startTime,
                    sentAt: new Date().toISOString(),
                },
                // 16h window — caregiver-side reminder uses the same window. Family
                // has until ~noon next day to cancel before the shift starts (most
                // shifts are morning).
                stateExpiresAt: new Date(Date.now() + 16 * 60 * 60 * 1000).toISOString(),
            });
        }
        catch (err) {
            console.error(`[sendClientDayBeforeReminders] Error for appointment ${apptId}:`, err);
        }
    }
});
//# sourceMappingURL=clientDayBeforeReminder.js.map