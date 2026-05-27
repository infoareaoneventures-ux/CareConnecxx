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
exports.handleCaregiverCancelShift = handleCaregiverCancelShift;
const admin = __importStar(require("firebase-admin"));
const client_1 = require("../linq/client");
const parseWithClaude_1 = require("../utils/parseWithClaude");
const openaiClient_1 = require("../utils/openaiClient");
const caraMessage_1 = require("../utils/caraMessage");
const caraAgent_1 = require("./caraAgent");
const db = admin.firestore();
async function isQuestionOrOther(text, currentQuestion) {
    const result = await (0, parseWithClaude_1.parseWithClaude)(`The caregiver is in a shift cancellation flow. Current step's question: "${currentQuestion}". ` +
        "Reply YES if their message is a general question or off-topic comment unrelated to that question. " +
        "Reply NO if it is a direct answer. Only reply YES or NO.", text, 5);
    return result.toUpperCase().startsWith("Y");
}
async function answerMidFlow(text, reAsk) {
    const answer = await (0, openaiClient_1.quickComplete)("You are Cara, an AI care assistant helping a caregiver cancel one of their upcoming shifts. " +
        "Answer their question briefly (1-2 sentences). Do NOT ask them to continue the cancellation — that prompt comes next.", text, { maxTokens: 150 }).catch(() => "Let me get back to you on that. In the meantime —");
    return `${answer}\n\n${reAsk}`;
}
async function handleCaregiverCancelShift(caregiverId, caregiverName, caregiverPhone, text, session, chatId) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const step = (_a = session.cancelStep) !== null && _a !== void 0 ? _a : "identify_shift";
    // ── identify_shift — list shifts, store candidates ─────────────────────────
    if (step === "identify_shift") {
        const today = new Date().toISOString().slice(0, 10);
        const snap = await db.collection("appointments")
            .where("caregiverId", "==", caregiverId)
            .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
            .where("date", ">=", today)
            .orderBy("date", "asc")
            .limit(5)
            .get();
        if (snap.empty) {
            await (0, client_1.sendMessage)(chatId, "You don't have any upcoming shifts to cancel.");
            await db.collection("agent_sessions").doc(caregiverPhone).update({
                cancelStep: admin.firestore.FieldValue.delete(),
            });
            return;
        }
        const shifts = snap.docs.map((d, i) => {
            var _a, _b, _c, _d, _e, _f, _g;
            return ({
                index: i + 1,
                id: d.id,
                date: d.data().date,
                time: (_b = (_a = d.data().time) !== null && _a !== void 0 ? _a : d.data().startTime) !== null && _b !== void 0 ? _b : "",
                clientName: (_c = d.data().clientName) !== null && _c !== void 0 ? _c : "client",
                clientId: d.data().clientId,
                seniorName: (_e = (_d = d.data().seniorName) !== null && _d !== void 0 ? _d : d.data().clientName) !== null && _e !== void 0 ? _e : "the client",
                startTime: (_g = (_f = d.data().startTime) !== null && _f !== void 0 ? _f : d.data().time) !== null && _g !== void 0 ? _g : "",
            });
        });
        await db.collection("agent_sessions").doc(caregiverPhone).update({
            cancelStep: "confirm_shift",
            cancelCandidates: JSON.stringify(shifts),
            stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        });
        const list = shifts.map(s => `${s.index}. ${s.date} at ${s.time} — ${s.clientName}`).join("\n");
        await (0, client_1.sendMessage)(chatId, `Which shift do you need to cancel?\n${list}\n\nReply with the number, or CANCEL to back out.`);
        return;
    }
    // ── confirm_shift — caregiver picks number; ask YES/NO ─────────────────────
    if (step === "confirm_shift") {
        const candidates = (() => {
            var _a;
            try {
                return JSON.parse((_a = session.cancelCandidates) !== null && _a !== void 0 ? _a : "[]");
            }
            catch (_b) {
                return [];
            }
        })();
        if (candidates.length === 0) {
            await (0, client_1.sendMessage)(chatId, "Something went wrong — let me start over. Which shift do you need to cancel?");
            await db.collection("agent_sessions").doc(caregiverPhone).update({
                cancelStep: "identify_shift",
                cancelCandidates: admin.firestore.FieldValue.delete(),
            });
            return;
        }
        // CANCEL bail-out (literal)
        if (text.trim().toUpperCase() === "CANCEL") {
            await db.collection("agent_sessions").doc(caregiverPhone).update({
                cancelStep: admin.firestore.FieldValue.delete(),
                cancelCandidates: admin.firestore.FieldValue.delete(),
                cancelShiftId: admin.firestore.FieldValue.delete(),
                cancelShiftDate: admin.firestore.FieldValue.delete(),
                cancelShiftClientId: admin.firestore.FieldValue.delete(),
                stateExpiresAt: admin.firestore.FieldValue.delete(),
            });
            await (0, client_1.sendMessage)(chatId, "No problem — your shifts are unchanged.");
            return;
        }
        // If we already have a chosen shift, this reply is the YES/NO confirmation
        const chosenId = session.cancelShiftId;
        if (chosenId) {
            const list = candidates.map(s => `${s.index}. ${s.date} at ${s.time} — ${s.clientName}`).join("\n");
            const reAsk = `Cancel this shift? Reply YES to cancel, or NO to keep it.`;
            if (await isQuestionOrOther(text, reAsk)) {
                await (0, client_1.sendMessage)(chatId, await answerMidFlow(text, reAsk));
                return;
            }
            const decision = await (0, parseWithClaude_1.parseWithClaude)('"yes", "yeah", "confirm", "do it", "cancel it" → YES. ' +
                '"no", "wait", "never mind", "keep it", "back" → NO. ' +
                'Reply with exactly YES or NO.', text, 5);
            if (decision === "YES") {
                await db.collection("agent_sessions").doc(caregiverPhone).update({
                    cancelStep: "ask_reason",
                    stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
                });
                await (0, client_1.sendMessage)(chatId, "Got it. What's the reason for cancelling? (Illness, schedule conflict, family emergency, etc.) " +
                    "This helps us let the family know.");
                return;
            }
            // NO — back out, keep candidates so they can pick a different one
            await db.collection("agent_sessions").doc(caregiverPhone).update({
                cancelShiftId: admin.firestore.FieldValue.delete(),
                cancelShiftDate: admin.firestore.FieldValue.delete(),
                cancelShiftClientId: admin.firestore.FieldValue.delete(),
            });
            await (0, client_1.sendMessage)(chatId, `Okay — keeping that one. ${list}\n\nReply with another number, or CANCEL to back out entirely.`);
            return;
        }
        // No chosen shift yet — this reply should be a number selection
        const reAskPick = `Reply with the number of the shift to cancel (1–${candidates.length}), or CANCEL to back out.`;
        if (await isQuestionOrOther(text, reAskPick)) {
            await (0, client_1.sendMessage)(chatId, await answerMidFlow(text, reAskPick));
            return;
        }
        const pick = parseInt(text.trim(), 10);
        const shift = candidates.find(s => s.index === pick);
        if (!shift) {
            await (0, client_1.sendMessage)(chatId, `Please reply with a number between 1 and ${candidates.length}, or CANCEL to back out.`);
            return;
        }
        await db.collection("agent_sessions").doc(caregiverPhone).update({
            cancelShiftId: shift.id,
            cancelShiftDate: shift.date,
            cancelShiftClientId: shift.clientId,
            stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        });
        await (0, client_1.sendMessage)(chatId, `You want to cancel: ${shift.date} at ${shift.time} with the ${shift.clientName} family.\n\n` +
            `Cancel this shift? Reply YES to cancel, or NO to keep it.`);
        return;
    }
    // ── ask_reason — capture reason, finalize cancellation ─────────────────────
    if (step === "ask_reason") {
        const reAsk = "What's the reason for cancelling? (illness, conflict, emergency, etc.)";
        if (await isQuestionOrOther(text, reAsk)) {
            await (0, client_1.sendMessage)(chatId, await answerMidFlow(text, reAsk));
            return;
        }
        const reasonRaw = await (0, parseWithClaude_1.parseWithClaude)('Summarize the caregiver\'s cancellation reason in a short phrase (e.g. "illness", "family emergency", "schedule conflict", "transportation issue"). ' +
            'If unclear or missing, reply: unspecified. Reply with only the short phrase.', text, 30);
        const reason = reasonRaw && reasonRaw !== "__parse_error__" ? reasonRaw : "unspecified";
        const shiftId = session.cancelShiftId;
        const shiftDate = session.cancelShiftDate;
        const clientId = session.cancelShiftClientId;
        if (!shiftId) {
            await (0, client_1.sendMessage)(chatId, "Something went wrong — your shifts are unchanged. Please try again.");
            await db.collection("agent_sessions").doc(caregiverPhone).update({
                cancelStep: admin.firestore.FieldValue.delete(),
                cancelCandidates: admin.firestore.FieldValue.delete(),
                cancelShiftId: admin.firestore.FieldValue.delete(),
                cancelShiftDate: admin.firestore.FieldValue.delete(),
                cancelShiftClientId: admin.firestore.FieldValue.delete(),
                cancelReason: admin.firestore.FieldValue.delete(),
                stateExpiresAt: admin.firestore.FieldValue.delete(),
            });
            return;
        }
        // Load the appointment for context
        const apptSnap = await db.collection("appointments").doc(shiftId).get();
        const apptData = (_b = apptSnap.data()) !== null && _b !== void 0 ? _b : {};
        const seniorName = ((_d = (_c = apptData.seniorName) !== null && _c !== void 0 ? _c : apptData.clientName) !== null && _d !== void 0 ? _d : "the client");
        const startTime = ((_f = (_e = apptData.startTime) !== null && _e !== void 0 ? _e : apptData.time) !== null && _f !== void 0 ? _f : "");
        // Mark appointment cancelled
        await db.collection("appointments").doc(shiftId).update({
            status: "cancelled",
            cancelledBy: "caregiver",
            cancelledAt: new Date().toISOString(),
            cancellationReason: reason,
            cancelledByCaregiverId: caregiverId,
            cancelledByCaregiverName: caregiverName,
        }).catch(err => console.error("[cancelShift] appointment update failed:", err));
        // Clear flow state
        await db.collection("agent_sessions").doc(caregiverPhone).update({
            cancelStep: admin.firestore.FieldValue.delete(),
            cancelCandidates: admin.firestore.FieldValue.delete(),
            cancelShiftId: admin.firestore.FieldValue.delete(),
            cancelShiftDate: admin.firestore.FieldValue.delete(),
            cancelShiftClientId: admin.firestore.FieldValue.delete(),
            cancelReason: admin.firestore.FieldValue.delete(),
            stateExpiresAt: admin.firestore.FieldValue.delete(),
        });
        // Acknowledge caregiver warmly
        const cgFirstName = caregiverName.split(" ")[0] || "you";
        const ackMsg = await (0, caraMessage_1.generateCaraMessage)({
            audience: "caregiver",
            context: `${cgFirstName} just cancelled their ${shiftDate} shift with ${seniorName} (reason: ${reason}). ` +
                `Write a brief, understanding acknowledgment — no judgment, let them know the family will be notified ` +
                `and you're already working on coverage. Be warm.`,
            fallback: `Got it, ${cgFirstName} — I'll let the ${seniorName} family know and start working on coverage for ${shiftDate}. ` +
                `Thanks for letting me know ahead of time.`,
            maxTokens: 100,
        });
        await (0, client_1.sendMessage)(chatId, ackMsg);
        // Alert family with urgency
        if (clientId) {
            const clientSessionSnap = await db.collection("agent_sessions")
                .where("userId", "==", clientId)
                .limit(1)
                .get();
            const clientPhone = clientSessionSnap.empty
                ? null
                : ((_g = clientSessionSnap.docs[0].data().phone) !== null && _g !== void 0 ? _g : clientSessionSnap.docs[0].id);
            if (clientPhone) {
                const alertMsg = await (0, caraMessage_1.generateCaraMessage)({
                    audience: "family",
                    context: `Unfortunately ${cgFirstName} just cancelled their visit with ${seniorName} on ${shiftDate}` +
                        `${startTime ? " at " + startTime : ""} (reason: ${reason}). ` +
                        `Write an urgent but calm alert to the family. Let them know you're already working on a replacement. ` +
                        `Tell them to reply HELP if they need immediate support. Be direct but not alarming.`,
                    fallback: `Heads up — ${cgFirstName} won't be able to make ${seniorName}'s visit on ${shiftDate}` +
                        `${startTime ? " at " + startTime : ""}. I'm already working on finding coverage. ` +
                        `Reply HELP if you need anything in the meantime.`,
                    maxTokens: 150,
                });
                await (0, caraAgent_1.sendViaInteractionAgent)(clientPhone, {
                    content: alertMsg,
                    urgency: "immediate",
                    sourceAgent: "caregiver_cancel_shift",
                    canDrop: false,
                }).catch(err => console.error("[cancelShift] family alert failed:", err));
            }
        }
        // Fire replacement agent (fire-and-forget). runEmergencyReplacement searches
        // for available caregivers and texts the family with numbered options.
        if (clientId) {
            const clientSessionSnap2 = await db.collection("agent_sessions")
                .where("userId", "==", clientId)
                .limit(1)
                .get();
            const clientPhone2 = clientSessionSnap2.empty
                ? ""
                : ((_h = clientSessionSnap2.docs[0].data().phone) !== null && _h !== void 0 ? _h : clientSessionSnap2.docs[0].id);
            Promise.resolve().then(() => __importStar(require("./replacementAgent"))).then(({ runEmergencyReplacement }) => {
                runEmergencyReplacement({
                    appointmentId: shiftId,
                    clientId,
                    clientPhone: clientPhone2,
                    appt: Object.assign(Object.assign({}, apptData), { caregiverName: caregiverName, caregiverId, date: shiftDate, time: startTime }),
                }).catch(err => console.error("[cancelShift] replacement agent failed:", err));
            }).catch(err => console.error("[cancelShift] replacementAgent import failed:", err));
            void seniorName;
        }
        return;
    }
}
//# sourceMappingURL=caregiverCancelShiftHandler.js.map