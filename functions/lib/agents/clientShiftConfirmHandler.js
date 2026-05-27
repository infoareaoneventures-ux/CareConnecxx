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
exports.handleClientShiftConfirm = handleClientShiftConfirm;
const admin = __importStar(require("firebase-admin"));
const client_1 = require("../linq/client");
const openaiClient_1 = require("../utils/openaiClient");
const caraAgent_1 = require("./caraAgent");
const db = admin.firestore();
// Classify the family's reply to the day-before reminder. Returns CONFIRM, CANCEL,
// or QUESTION. Conservative defaults: anything ambiguous falls to QUESTION (we
// answer + re-prompt) rather than acting destructively.
async function classifyReply(text) {
    try {
        const raw = await (0, openaiClient_1.quickComplete)("Cara just sent a family member a day-before reminder for a care visit. The user just replied. " +
            "Classify their intent:\n" +
            "- CONFIRM if they're acknowledging the visit is still on (\"yes\", \"sounds good\", \"we'll be here\", \"confirmed\", thumbs-up)\n" +
            "- CANCEL if they want to cancel the visit (\"cancel\", \"can't make it\", \"need to reschedule\", \"something came up\")\n" +
            "- QUESTION if they're asking something or unclear\n" +
            "Reply with only CONFIRM, CANCEL, or QUESTION.", text, { maxTokens: 5 });
        const v = raw.trim().toUpperCase();
        if (v.startsWith("CONFIRM") || v === "C")
            return "CONFIRM";
        if (v.startsWith("CANCEL"))
            return "CANCEL";
        return "QUESTION";
    }
    catch (_a) {
        return "QUESTION";
    }
}
async function handleClientShiftConfirm(phone, chatId, text, session) {
    var _a, _b, _c, _d;
    const info = session.pendingClientShiftConfirm;
    if (!info)
        return;
    const verdict = await classifyReply(text);
    if (verdict === "CONFIRM") {
        await db.collection("agent_sessions").doc(phone).update({
            pendingClientShiftConfirm: admin.firestore.FieldValue.delete(),
            stateExpiresAt: admin.firestore.FieldValue.delete(),
        });
        await db.collection("appointments").doc(info.appointmentId).update({
            clientConfirmedAt: new Date().toISOString(),
        }).catch(() => { });
        await (0, client_1.sendMessage)(chatId, `Got it — ${info.caregiverName.split(" ")[0]} will see you ${(_a = info.appointmentDisplay) !== null && _a !== void 0 ? _a : "tomorrow"}` +
            `${info.startTime ? " at " + info.startTime : ""}. 💙`);
        return;
    }
    if (verdict === "CANCEL") {
        // Mark the request and clear state. We don't auto-refund here — finance ops
        // handles that downstream from the client_cancel_requests collection.
        const requestRef = await db.collection("client_cancel_requests").add({
            clientPhone: phone,
            appointmentId: info.appointmentId,
            caregiverId: info.caregiverId,
            caregiverName: info.caregiverName,
            seniorName: info.seniorName,
            appointmentDate: info.appointmentDate,
            startTime: info.startTime,
            requestedAt: new Date().toISOString(),
            status: "pending_review",
            source: "day_before_reminder",
        });
        await db.collection("appointments").doc(info.appointmentId).update({
            status: "client_cancel_requested",
            clientCancelRequestedAt: new Date().toISOString(),
            clientCancelRequestId: requestRef.id,
        }).catch(() => { });
        // Notify the caregiver via Cara so they know not to show up
        const cgSnap = await db.collection("caregivers").doc(info.caregiverId).get();
        const cgPhone = (_b = cgSnap.data()) === null || _b === void 0 ? void 0 : _b.phone;
        if (cgPhone) {
            await (0, caraAgent_1.sendViaInteractionAgent)(cgPhone, {
                content: `Heads up — ${info.seniorName}'s family just cancelled tomorrow's visit ` +
                    `${info.startTime ? "at " + info.startTime : ""}. You don't need to head over. ` +
                    `I'll follow up if there's a reschedule.`,
                urgency: "immediate",
                sourceAgent: "client_cancel_notify",
                canDrop: false,
            }).catch(() => { });
        }
        // Alert ops so a human can handle refund + replacement
        await db.collection("admin_alerts").add({
            type: "client_cancel_request",
            phone,
            appointmentId: info.appointmentId,
            caregiverName: info.caregiverName,
            seniorName: info.seniorName,
            appointmentDate: info.appointmentDate,
            severity: "medium",
            resolved: false,
            createdAt: new Date().toISOString(),
        }).catch(() => { });
        await db.collection("agent_sessions").doc(phone).update({
            pendingClientShiftConfirm: admin.firestore.FieldValue.delete(),
            stateExpiresAt: admin.firestore.FieldValue.delete(),
        });
        await (0, client_1.sendMessage)(chatId, `Okay — I've cancelled ${(_c = info.appointmentDisplay) !== null && _c !== void 0 ? _c : "tomorrow"}'s visit and let ${info.caregiverName.split(" ")[0]} know. ` +
            `Want me to find a replacement caregiver for another day, or are you all set?`);
        return;
    }
    // QUESTION — answer it, then re-prompt
    let answer = "";
    try {
        answer = await (0, openaiClient_1.quickComplete)("You are Cara, an AI care assistant. A family member was just sent a day-before reminder for " +
            `${info.seniorName}'s visit tomorrow${info.startTime ? " at " + info.startTime : ""} with ` +
            `${info.caregiverName}. Instead of CONFIRM or CANCEL, they asked a question. Answer briefly ` +
            "(1–2 sentences). Do NOT ask them to confirm or cancel — that prompt comes next.", text, { maxTokens: 180 });
    }
    catch (_e) {
        answer = "Let me check on that. In the meantime —";
    }
    await (0, client_1.sendMessage)(chatId, answer);
    await (0, client_1.sendMessage)(chatId, `So — ${info.caregiverName.split(" ")[0]} is still set for ${(_d = info.appointmentDisplay) !== null && _d !== void 0 ? _d : "tomorrow"}` +
        `${info.startTime ? " at " + info.startTime : ""}. ` +
        `You don't need to do anything; reply CANCEL only if something's changed.`);
}
//# sourceMappingURL=clientShiftConfirmHandler.js.map