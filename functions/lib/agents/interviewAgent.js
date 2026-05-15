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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleInterviewSelection = handleInterviewSelection;
exports.handleCaregiverAvailabilityReply = handleCaregiverAvailabilityReply;
exports.handleInterviewConfirm = handleInterviewConfirm;
exports.sendPostInterviewFollowUp = sendPostInterviewFollowUp;
const admin = __importStar(require("firebase-admin"));
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const client_1 = require("../linq/client");
let _claude = null;
function getClaude() {
    if (!_claude)
        _claude = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    return _claude;
}
const permissionsConversation_1 = require("./permissionsConversation");
const notifications_1 = require("../notifications");
const interviewLinks_1 = require("./interviewLinks");
const db = admin.firestore();
// ── Parse caregiver selection from family text ────────────────────────────────
async function parseSelection(text, matchCount) {
    var _a;
    const norm = text.trim().toLowerCase();
    if (norm === "all")
        return Array.from({ length: matchCount }, (_, i) => i + 1);
    const result = await getClaude().messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 30,
        system: `The user is selecting from a numbered list of ${matchCount} caregivers. ` +
            "Reply with only a JSON array of the numbers they selected, e.g. [1] or [1,3]. Nothing else.",
        messages: [{ role: "user", content: text }],
    });
    try {
        const arr = JSON.parse((_a = result.content[0].text) !== null && _a !== void 0 ? _a : "[]");
        return arr.filter((n) => n >= 1 && n <= matchCount);
    }
    catch (_b) {
        return [];
    }
}
// ── Parse caregiver availability from text ────────────────────────────────────
async function parseAvailability(text) {
    var _a;
    const result = await getClaude().messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 100,
        system: "Extract interview time proposals from this message as an array of ISO datetime strings. " +
            "Assume the current year. Reply with only a JSON array, e.g. [\"2026-05-15T14:00:00\"].",
        messages: [{ role: "user", content: text }],
    });
    try {
        return JSON.parse((_a = result.content[0].text) !== null && _a !== void 0 ? _a : "[]");
    }
    catch (_b) {
        return [];
    }
}
// ── Handle family selecting caregivers for interview ─────────────────────────
async function handleInterviewSelection(phone, chatId, text, session) {
    var _a, _b, _c, _d, _e, _f;
    const matches = (_a = session.pendingMatches) !== null && _a !== void 0 ? _a : [];
    if (matches.length === 0) {
        await (0, client_1.sendMessage)(chatId, "I don't have any pending matches right now. Let me search again — I'll text you shortly! 🔍");
        return;
    }
    const selected = await parseSelection(text, matches.length);
    if (selected.length === 0) {
        await (0, client_1.sendMessage)(chatId, "I didn't catch which caregivers you'd like to interview. Reply with the number(s) — e.g. \"1\" or \"1 and 2\".");
        return;
    }
    // Check permission to contact caregivers on family's behalf
    const perms = await (0, permissionsConversation_1.getPermissions)((_b = session.userId) !== null && _b !== void 0 ? _b : phone).catch(() => null);
    if (perms && !perms.canContactCaregivers) {
        await (0, client_1.sendMessage)(chatId, "I need your permission to reach out to caregivers on your behalf.\n\n" +
            "Reply ALLOW to give me permission, or visit the app to update your settings.");
        return;
    }
    // Get senior name for context
    const intakeSnap = await db.collection("clientIntakes")
        .where("phone", "==", phone).orderBy("createdAt", "desc").limit(1).get();
    const intake = intakeSnap.empty ? {} : intakeSnap.docs[0].data();
    const seniorName = ((_c = intake.seniorName) !== null && _c !== void 0 ? _c : "your loved one");
    const relationship = ((_d = intake.relationship) !== null && _d !== void 0 ? _d : "family");
    const age = (_e = intake.age) !== null && _e !== void 0 ? _e : "";
    for (const idx of selected) {
        const match = matches[idx - 1];
        if (!match)
            continue;
        // Create interview request doc
        await db.collection("interview_requests").add({
            clientPhone: phone,
            caregiverId: match.id,
            caregiverName: match.name,
            status: "awaiting_caregiver_availability",
            seniorName,
            relationship,
            age,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        });
        // Text the caregiver
        const caregiverSnap = await db.collection("caregivers").doc(match.id).get();
        const caregiverPhone = (_f = caregiverSnap.data()) === null || _f === void 0 ? void 0 : _f.phone;
        if (!caregiverPhone)
            continue;
        const caregiverSession = await (0, client_1.getOrCreateSession)(caregiverPhone, { caregiverId: match.id });
        await (0, client_1.sendMessage)(caregiverSession.chatId, `Hi ${match.name}! 👋 I'm Cara, your care assistant.\n\n` +
            `A family is interested in meeting you for a care position for their ${relationship}, ` +
            `${age ? `${age}-year-old ` : ""}${seniorName}.\n\n` +
            `Are you available for a 20-minute video call this week?\n\n` +
            `Reply with 2–3 times that work for you, or PASS to decline.`);
    }
    await (0, client_1.sendMessage)(chatId, `I've reached out to ${selected.length === 1 ? "that caregiver" : "those caregivers"} on your behalf.\n\n` +
        `I'll text you as soon as I hear back with their availability.`);
}
// ── Handle caregiver replying with availability ───────────────────────────────
async function handleCaregiverAvailabilityReply(caregiverPhone, caregiverId, caregiverName, chatId, text) {
    if (text.trim().toUpperCase() === "PASS") {
        // Find the pending interview request and mark declined
        const snap = await db.collection("interview_requests")
            .where("caregiverId", "==", caregiverId)
            .where("status", "==", "awaiting_caregiver_availability")
            .orderBy("createdAt", "desc").limit(1).get();
        if (!snap.empty) {
            const doc = snap.docs[0];
            const reqData = doc.data();
            await doc.ref.update({ status: "caregiver_declined" });
            // Notify the family + add caregiver to rejection list
            const familySnap = await db.collection("agent_sessions")
                .where("phone", "==", reqData.clientPhone).limit(1).get();
            if (!familySnap.empty) {
                const familySession = familySnap.docs[0].data();
                await (0, client_1.sendMessage)(familySession.chatId, `${caregiverName} isn't available right now.\n\n` +
                    `Want me to reach out to the next best match? Reply YES and I'll get on it. 🔍`);
                // Remember this caregiver was declined so matching won't re-present them
                await db.collection("agent_sessions").doc(reqData.clientPhone).update({
                    rejectedCaregiverIds: admin.firestore.FieldValue.arrayUnion(caregiverId),
                });
            }
        }
        await (0, client_1.sendMessage)(chatId, "No problem! I'll let the family know. Good luck with your other bookings! 😊");
        return;
    }
    const proposedTimes = await parseAvailability(text);
    if (proposedTimes.length === 0) {
        await (0, client_1.sendMessage)(chatId, "I didn't quite catch those times. Could you share 2–3 times that work for you this week? " +
            "(e.g. \"Tuesday 2pm, Wednesday 10am, Thursday 3pm\")");
        return;
    }
    // Update interview request with caregiver availability
    const snap = await db.collection("interview_requests")
        .where("caregiverId", "==", caregiverId)
        .where("status", "==", "awaiting_caregiver_availability")
        .orderBy("createdAt", "desc").limit(1).get();
    if (snap.empty) {
        await (0, client_1.sendMessage)(chatId, "I couldn't find an active interview request. Please try again or contact support.");
        return;
    }
    const doc = snap.docs[0];
    const reqData = doc.data();
    // Pick first proposed time that works
    const mutualTime = proposedTimes[0]; // TODO: cross-check with client's calendar
    await doc.ref.update({
        status: "awaiting_client_confirmation",
        caregiverAvailability: proposedTimes,
        proposedTime: mutualTime,
    });
    // Format the time nicely
    const dt = new Date(mutualTime);
    const formatted = dt.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) +
        " at " + dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    // Text the family to confirm
    const familySnap = await db.collection("agent_sessions")
        .doc(reqData.clientPhone).get();
    if (familySnap.exists) {
        const familySession = familySnap.data();
        await (0, client_1.sendMessage)(familySession.chatId, `${caregiverName} is available for an interview!\n\n` +
            `📅 ${formatted}\n\n` +
            `Confirm this time? Reply YES to schedule.`);
        // Store pending confirmation
        await db.collection("agent_sessions").doc(reqData.clientPhone).update({
            pendingInterviewConfirm: { docId: doc.id, caregiverName, mutualTime, formatted },
        });
    }
    await (0, client_1.sendMessage)(chatId, `I've sent those times to the family! I'll let you know once they confirm. 📅`);
}
// ── Handle family confirming interview ────────────────────────────────────────
async function handleInterviewConfirm(phone, chatId, session) {
    var _a, _b, _c, _d;
    const pending = session.pendingInterviewConfirm;
    if (!pending) {
        await (0, client_1.sendMessage)(chatId, "I don't have a pending interview to confirm. Let me know if you'd like to schedule one! 📅");
        return;
    }
    // Create confirmed interview in Firestore
    const interviewRef = await db.collection("interviews").add({
        clientPhone: phone,
        caregiverName: pending.caregiverName,
        scheduledTime: pending.mutualTime,
        status: "scheduled",
        followUpSent: false,
        createdAt: new Date().toISOString(),
    });
    // Get family session to determine iMessage vs other
    const familySession = await db.collection("agent_sessions").doc(phone).get();
    const isIMessage = ((_b = (_a = familySession.data()) === null || _a === void 0 ? void 0 : _a.service) !== null && _b !== void 0 ? _b : "") === "iMessage";
    // Generate call link (FaceTime for iMessage, Google Meet otherwise)
    let callUrl = "";
    try {
        callUrl = await (0, interviewLinks_1.generateCallLink)({
            isIMessage,
            startTime: pending.mutualTime,
            durationMinutes: 30,
            title: `Care Interview — ${pending.caregiverName}`,
        });
        await interviewRef.update({ callUrl });
    }
    catch (err) {
        console.error("Call link generation error:", err);
    }
    // Generate and upload .ics calendar invite
    let icsUrl = "";
    if (callUrl) {
        try {
            const icsContent = (0, interviewLinks_1.generateICSFile)({
                title: `Care Interview — ${pending.caregiverName}`,
                startTime: pending.mutualTime,
                durationMinutes: 30,
                description: `${isIMessage ? "FaceTime" : "Google Meet"} interview with ${pending.caregiverName}`,
                callUrl,
                uid: `cara-${interviewRef.id}@cara.com`,
            });
            icsUrl = await (0, interviewLinks_1.uploadICSToStorage)(icsContent, `interviews/${interviewRef.id}.ics`);
        }
        catch (err) {
            console.error("ICS upload error:", err);
        }
    }
    // Update request doc
    await db.collection("interview_requests").doc(pending.docId).update({
        status: "scheduled",
        interviewId: interviewRef.id,
    });
    // Notify admin
    (0, notifications_1.notifyAdminInterviewScheduled)({
        interviewId: interviewRef.id,
        caregiverName: pending.caregiverName,
        clientPhone: phone,
        scheduledTime: pending.mutualTime,
    }).catch((err) => console.error("notifyAdminInterviewScheduled error:", err));
    // Clear pending from session
    await db.collection("agent_sessions").doc(phone).update({
        pendingInterviewConfirm: admin.firestore.FieldValue.delete(),
    });
    // Send to family — call link + .ics + text
    if (callUrl) {
        await (0, client_1.sendMessage)(chatId, { parts: [{ type: "link", value: callUrl }] });
    }
    if (icsUrl) {
        await (0, client_1.sendMessage)(chatId, { parts: [{ type: "media", url: icsUrl }] });
    }
    await (0, client_1.sendMessage)(chatId, `Interview set for ${pending.formatted}.\n\n` +
        `Tap the ${isIMessage ? "FaceTime" : "Meet"} link above to join. Calendar invite included, with a 30-minute reminder.`);
    // Text the caregiver
    const reqSnap = await db.collection("interview_requests").doc(pending.docId).get();
    const caregiverId = (_c = reqSnap.data()) === null || _c === void 0 ? void 0 : _c.caregiverId;
    if (caregiverId) {
        const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
        const cgPhone = (_d = cgSnap.data()) === null || _d === void 0 ? void 0 : _d.phone;
        if (cgPhone) {
            const cgSession = await (0, client_1.getOrCreateSession)(cgPhone);
            const cgIsIMessa = cgSession.service === "iMessage";
            if (callUrl) {
                await (0, client_1.sendMessage)(cgSession.chatId, { parts: [{ type: "link", value: callUrl }] });
            }
            if (icsUrl) {
                await (0, client_1.sendMessage)(cgSession.chatId, { parts: [{ type: "media", url: icsUrl }] });
            }
            await (0, client_1.sendMessage)(cgSession.chatId, `Interview confirmed. ${pending.formatted}.\n\n` +
                `${cgIsIMessa ? "FaceTime" : "Meet"} link above. Calendar invite included, with a 30-minute reminder.\n\n` +
                `Reply RESCHEDULE if you need to change the time.`);
        }
    }
}
// ── Post-interview follow-up ──────────────────────────────────────────────────
async function sendPostInterviewFollowUp(interviewId) {
    var _a;
    const snap = await db.collection("interviews").doc(interviewId).get();
    if (!snap.exists)
        return;
    const data = snap.data();
    const clientSnap = await db.collection("agent_sessions").doc(data.clientPhone).get();
    if (clientSnap.exists) {
        await (0, client_1.sendMessage)(clientSnap.data().chatId, `How did it go with ${data.caregiverName}?\n\nJust tell me what you thought.`);
        // Look up caregiverId so HIRE flow can fetch hourly rate + rejection memory
        const reqSnap = await db.collection("interview_requests")
            .where("interviewId", "==", interviewId).limit(1).get();
        const caregiverId = reqSnap.empty ? "" : ((_a = reqSnap.docs[0].data().caregiverId) !== null && _a !== void 0 ? _a : "");
        await db.collection("agent_sessions").doc(data.clientPhone).update({
            pendingInterviewOutcome: { interviewId, caregiverName: data.caregiverName, caregiverId },
        });
    }
}
//# sourceMappingURL=interviewAgent.js.map