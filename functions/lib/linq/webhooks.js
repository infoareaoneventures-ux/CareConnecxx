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
exports.linqWebhook = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const crypto = __importStar(require("crypto"));
const client_1 = require("./client");
const intentClassifier_1 = require("../agents/intentClassifier");
const qaAgent_1 = require("../agents/qaAgent");
const taskApprovalHandler_1 = require("../agents/taskApprovalHandler");
const sms_1 = require("../sms");
const onboardingConversation_1 = require("../agents/onboardingConversation");
const permissionsConversation_1 = require("../agents/permissionsConversation");
const interviewAgent_1 = require("../agents/interviewAgent");
const bookingExecutor_1 = require("../agents/bookingExecutor");
const crisisDetector_1 = require("../safety/crisisDetector");
const triggerEngine_1 = require("../triggers/triggerEngine");
const auditLog_1 = require("../observability/auditLog");
const bereavement_1 = require("../agents/bereavement");
const db = admin.firestore();
// ── Signature verification ────────────────────────────────────────────────────
function verifySignature(rawBody, timestamp, signature, secret) {
    const secretKey = Buffer.from(secret, "base64");
    const payload = Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]);
    const hmac = crypto.createHmac("sha256", secretKey).update(payload);
    const expectedB64 = hmac.digest("base64");
    const expectedHex = crypto.createHmac("sha256", secretKey).update(payload).digest("hex");
    try {
        if (signature.length === expectedB64.length)
            return crypto.timingSafeEqual(Buffer.from(expectedB64), Buffer.from(signature));
        if (signature.length === expectedHex.length)
            return crypto.timingSafeEqual(Buffer.from(expectedHex), Buffer.from(signature));
        return false;
    }
    catch (_a) {
        return false;
    }
}
// ── Rate limiting ─────────────────────────────────────────────────────────────
async function isRateLimited(phone) {
    var _a, _b;
    const rateRef = db.collection("agent_rate").doc(phone);
    const snap = await rateRef.get();
    const now = Date.now();
    const hourAgo = now - 60 * 60 * 1000;
    const calls = ((_b = (_a = snap.data()) === null || _a === void 0 ? void 0 : _a.calls) !== null && _b !== void 0 ? _b : []).filter((t) => t > hourAgo);
    if (calls.length >= 10)
        return true;
    await rateRef.set({ calls: [...calls, now] });
    return false;
}
// ── Opt-in for existing (non-onboarding) users ────────────────────────────────
// ── Typing indicator — pre-fetch context so Claude responds faster ─────────────
async function handleTypingStarted(event) {
    var _a, _b, _c, _d, _e, _f, _g;
    const ev = event;
    const phone = (_b = (_a = ev.data) === null || _a === void 0 ? void 0 : _a.sender_handle) === null || _b === void 0 ? void 0 : _b.value;
    const chatId = (_d = (_c = ev.data) === null || _c === void 0 ? void 0 : _c.chat) === null || _d === void 0 ? void 0 : _d.id;
    if (!phone || !chatId)
        return;
    const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
    if (!sessionSnap.exists)
        return;
    const session = sessionSnap.data();
    if (session.optedOut || session.optedIn === false)
        return;
    const seniorId = (_f = (_e = session.seniorId) !== null && _e !== void 0 ? _e : session.userId) !== null && _f !== void 0 ? _f : "";
    const userId = (_g = session.userId) !== null && _g !== void 0 ? _g : "";
    const now = new Date().toISOString();
    const [seniorSnap, journalSnap, apptSnap, historySnap] = await Promise.all([
        db.collection("senior_profiles").doc(seniorId).get(),
        db.collection("care_journal")
            .where("seniorId", "==", seniorId)
            .orderBy("timestamp", "desc").limit(3).get(),
        db.collection("appointments")
            .where("clientId", "==", userId)
            .where("isoDate", ">=", now.slice(0, 10))
            .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
            .orderBy("isoDate", "asc").limit(1).get(),
        db.collection("agent_conversations").doc(phone)
            .collection("messages").orderBy("timestamp", "desc").limit(10).get(),
    ]).catch(() => [null, null, null, null]);
    if (!seniorSnap)
        return;
    await db.collection("agent_prefetch").doc(phone).set({
        seniorProfile: seniorSnap.exists ? seniorSnap.data() : null,
        recentJournal: journalSnap ? journalSnap.docs.map((d) => d.data()) : [],
        nextAppointment: apptSnap && !apptSnap.empty ? apptSnap.docs[0].data() : null,
        conversationHistory: historySnap
            ? historySnap.docs.map((d) => d.data()).reverse()
            : [],
        cachedAt: now,
        expiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
    });
}
// ── Caregiver keyword handlers ────────────────────────────────────────────────
async function handleArrived(phone, chatId, session) {
    var _a, _b, _c;
    // Find today's appointment for this caregiver
    const today = new Date().toISOString().slice(0, 10);
    const caregiverId = session.caregiverId;
    if (!caregiverId)
        return;
    const snap = await db.collection("appointments")
        .where("caregiverId", "==", caregiverId)
        .where("date", "==", today)
        .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
        .limit(1).get();
    if (snap.empty) {
        await (0, client_1.sendMessage)(chatId, "I don't see a scheduled visit for you today. Let me know if something looks wrong! 🤔");
        return;
    }
    const appt = snap.docs[0];
    await appt.ref.update({ arrivedAt: new Date().toISOString(), status: "in-progress" });
    // Notify family
    const clientPhone = await getClientPhoneForAppt(appt.data());
    if (clientPhone) {
        const clientSession = await db.collection("agent_sessions").doc(clientPhone).get();
        if (clientSession.exists) {
            await (0, client_1.sendMessage)(clientSession.data().chatId, `${session.caregiverId ? (_b = (_a = (await db.collection("caregivers").doc(session.caregiverId).get()).data()) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : "Your caregiver" : "Your caregiver"} just arrived for ${(_c = appt.data().clientName) !== null && _c !== void 0 ? _c : "the visit"} ✅`);
        }
    }
    await (0, client_1.sendMessage)(chatId, "Great — I've notified the family you've arrived! Have a wonderful visit. 💙");
}
async function handleDone(phone, chatId, session) {
    const caregiverId = session.caregiverId;
    if (!caregiverId)
        return;
    const today = new Date().toISOString().slice(0, 10);
    const snap = await db.collection("appointments")
        .where("caregiverId", "==", caregiverId)
        .where("date", "==", today)
        .where("status", "==", "in-progress")
        .limit(1).get();
    if (!snap.empty) {
        await snap.docs[0].ref.update({ completedAt: new Date().toISOString() });
    }
    // Store that we're awaiting care notes
    await db.collection("agent_sessions").doc(phone).update({
        awaitingCareNotes: true,
        careNotesApptId: snap.empty ? "" : snap.docs[0].id,
    });
    await (0, client_1.sendMessage)(chatId, "Great job today! 🌟\n\n" +
        "How did the visit go? Tell me in your own words — I'll handle the notes.");
}
async function handleRunningLate(phone, chatId) {
    await db.collection("agent_sessions").doc(phone).update({ awaitingLateMinutes: true });
    await (0, client_1.sendMessage)(chatId, "How late do you think you'll be?");
}
async function handleIssue(phone, chatId) {
    await db.collection("agent_sessions").doc(phone).update({ awaitingIssueDescription: true });
    await (0, client_1.sendMessage)(chatId, "I'm sorry to hear that. Can you describe what's happening?");
}
async function getClientPhoneForAppt(appt) {
    var _a;
    const clientId = appt.clientId;
    if (!clientId)
        return null;
    const snap = await db.collection("agent_sessions")
        .where("userId", "==", clientId).limit(1).get();
    if (snap.empty)
        return null;
    return (_a = snap.docs[0].data().phone) !== null && _a !== void 0 ? _a : snap.docs[0].id;
}
// ── Caregiver voice/text → structured journal ─────────────────────────────────
async function handleCareNotes(phone, chatId, text, session) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r;
    const Anthropic = (await Promise.resolve().then(() => __importStar(require("@anthropic-ai/sdk")))).default;
    const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const structured = await claude.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system: "Convert this caregiver note into a structured care journal entry. " +
            'Reply in JSON: {"overallWellness":1,"mood":"happy|neutral|agitated|confused|tired",' +
            '"appetite":"good|fair|poor|refused","activities":[],"medications":[],' +
            '"observations":"","notes":""}',
        messages: [{ role: "user", content: text }],
    });
    let entry = {};
    try {
        entry = JSON.parse((_a = structured.content[0].text) !== null && _a !== void 0 ? _a : "{}");
    }
    catch (_s) {
        entry = { notes: text };
    }
    const apptId = (_b = session.careNotesApptId) !== null && _b !== void 0 ? _b : "";
    const caregiverId = (_c = session.caregiverId) !== null && _c !== void 0 ? _c : "";
    // Get clientId from appointment
    let clientId = "";
    let seniorId = "";
    if (apptId) {
        const apptSnap = await db.collection("appointments").doc(apptId).get();
        clientId = (_e = (_d = apptSnap.data()) === null || _d === void 0 ? void 0 : _d.clientId) !== null && _e !== void 0 ? _e : "";
        seniorId = (_g = (_f = apptSnap.data()) === null || _f === void 0 ? void 0 : _f.seniorId) !== null && _g !== void 0 ? _g : clientId;
    }
    await db.collection("care_journal").add({
        caregiverId,
        seniorId,
        appointmentId: apptId,
        timestamp: new Date().toISOString(),
        notes: (_h = entry.notes) !== null && _h !== void 0 ? _h : text,
        wellness: {
            ateWell: entry.appetite === "good",
            tookMeds: Array.isArray(entry.medications) && entry.medications.length > 0,
            wasActive: Array.isArray(entry.activities) && entry.activities.length > 0,
            mood: (_j = entry.mood) !== null && _j !== void 0 ? _j : "neutral",
        },
        activities: (_k = entry.activities) !== null && _k !== void 0 ? _k : [],
        observations: (_l = entry.observations) !== null && _l !== void 0 ? _l : "",
    });
    // Clear awaiting flag
    await db.collection("agent_sessions").doc(phone).update({
        awaitingCareNotes: false,
        careNotesApptId: "",
    });
    const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
    const hourlyRate = (_o = (_m = cgSnap.data()) === null || _m === void 0 ? void 0 : _m.hourlyRate) !== null && _o !== void 0 ? _o : 20;
    const apptSnap = apptId
        ? await db.collection("appointments").doc(apptId).get()
        : null;
    const durationHours = (_q = (_p = apptSnap === null || apptSnap === void 0 ? void 0 : apptSnap.data()) === null || _p === void 0 ? void 0 : _p.durationHours) !== null && _q !== void 0 ? _q : 4;
    const pay = (hourlyRate * durationHours).toFixed(2);
    // Find next appointment for this caregiver
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const nextSnap = await db.collection("appointments")
        .where("caregiverId", "==", caregiverId)
        .where("date", ">=", tomorrow.toISOString().slice(0, 10))
        .where("status", "in", ["confirmed"])
        .orderBy("date", "asc").limit(1).get();
    const nextLine = nextSnap.empty
        ? "No upcoming visits scheduled yet."
        : `Next visit: ${nextSnap.docs[0].data().date} at ${(_r = nextSnap.docs[0].data().startTime) !== null && _r !== void 0 ? _r : ""}`;
    await (0, client_1.sendMessage)(chatId, `Got it — notes saved ✅\n\n` +
        `Your payment of $${pay} will be processed tonight.\n` +
        `${nextLine}\n\n` +
        `Have a great rest of your day! 😊`);
}
// ── Main inbound handler ──────────────────────────────────────────────────────
async function handleInbound(event) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1, _2, _3, _4, _5, _6, _7, _8, _9, _10, _11, _12, _13, _14, _15, _16, _17, _18, _19, _20, _21, _22, _23, _24, _25, _26, _27, _28, _29;
    const ev = event;
    const phone = (_b = (_a = ev.data) === null || _a === void 0 ? void 0 : _a.sender_handle) === null || _b === void 0 ? void 0 : _b.value;
    const text = ((_f = (_e = (_d = (_c = ev.data) === null || _c === void 0 ? void 0 : _c.parts) === null || _d === void 0 ? void 0 : _d[0]) === null || _e === void 0 ? void 0 : _e.value) !== null && _f !== void 0 ? _f : "");
    const chatId = (_h = (_g = ev.data) === null || _g === void 0 ? void 0 : _g.chat) === null || _h === void 0 ? void 0 : _h.id;
    if (!phone || !chatId)
        return;
    const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
    // ── New user — texted first (MO consent) ────────────────────────────────────
    if (!sessionSnap.exists) {
        const capability = await (0, client_1.checkCapability)(phone);
        const service = capability.iMessage ? "iMessage" : capability.RCS ? "RCS" : "SMS";
        const linqPhone = (_j = process.env.LINQ_PHONE_NUMBER) !== null && _j !== void 0 ? _j : "";
        await (0, client_1.setContactCard)({ phone_number: linqPhone, display_name: "Cara" }).catch(() => { });
        await (0, client_1.shareContactCard)(chatId).catch(() => { });
        await db.collection("agent_sessions").doc(phone).set({
            chatId,
            phone,
            service,
            userType: null,
            onboardingStep: "ask_role",
            optedIn: true,
            optedOut: false,
            createdAt: new Date().toISOString(),
        });
        await (0, client_1.startTyping)(chatId).catch(() => { });
        await (0, client_1.sendMessage)(chatId, `Hi! 💙 I'm Cara, your care assistant.\n\n` +
            `Are you looking for care for a loved one, or are you a caregiver looking for work?\n\n` +
            `1️⃣ I need care for someone\n` +
            `2️⃣ I'm a caregiver`);
        return;
    }
    const session = sessionSnap.data();
    const norm = text.trim().toUpperCase();
    const stopWords = new Set(["STOP", "UNSUBSCRIBE", "QUIT", "END"]);
    if (session.optedOut)
        return;
    // STOP — works at any stage (CANCEL is NOT here — it cancels a visit, not the account)
    if (stopWords.has(norm)) {
        await (0, sms_1.optOutPhoneNumber)(phone);
        await (0, client_1.sendMessage)(chatId, "You've been unsubscribed from Cara messages. Reply START anytime to reactivate.");
        return;
    }
    // ── Twin-trigger cancel — user replied, cancel any pending proactive nudges ─
    (0, triggerEngine_1.cancelTriggerIfUserReplied)((_k = session.userId) !== null && _k !== void 0 ? _k : phone, phone).catch(() => { });
    // ── Crisis detection — checked before everything else ──────────────────────
    const crisis = (0, crisisDetector_1.detectCrisis)(text);
    if (crisis === "medical") {
        await (0, client_1.sendMessage)(chatId, crisisDetector_1.MEDICAL_RESPONSE);
        (0, auditLog_1.logCrisisDetected)(phone, "medical", text).catch(() => { });
        return;
    }
    if (crisis === "emotional") {
        await (0, client_1.sendMessage)(chatId, crisisDetector_1.EMOTIONAL_RESPONSE);
        (0, auditLog_1.logCrisisDetected)(phone, "emotional", text).catch(() => { });
        return;
    }
    // ── Bereavement detection — before intent classification ───────────────────
    if ((0, bereavement_1.isBereavementTrigger)(text) && !session.bereavementMode) {
        const seniorName = (_l = session.seniorName) !== null && _l !== void 0 ? _l : "your loved one";
        await (0, bereavement_1.activateBereavementMode)((_m = session.userId) !== null && _m !== void 0 ? _m : phone, chatId, phone, seniorName);
        return;
    }
    // If already in bereavement mode, send gentle acknowledgment only
    if (session.bereavementMode) {
        await (0, client_1.sendMessage)(chatId, "I'm here with you. 💙 Take all the time you need. I'm ready when you are.");
        return;
    }
    // ── ONBOARDING gate — route to state machine if not complete ─────────────
    const step = (_o = session.onboardingStep) !== null && _o !== void 0 ? _o : "";
    if (step && step !== "complete") {
        // Permissions steps
        if (step === "client_permissions_contact" || step === "client_permissions_booking" || step === "client_permissions_autobook") {
            const userId = (_p = session.userId) !== null && _p !== void 0 ? _p : phone;
            await (0, permissionsConversation_1.handleClientPermissionsReply)(phone, chatId, text, session, userId);
            return;
        }
        if (step === "caregiver_permissions_decline" || step === "caregiver_permissions_arrival") {
            const caregiverId = (_q = session.caregiverId) !== null && _q !== void 0 ? _q : phone;
            await (0, permissionsConversation_1.handleCaregiverPermissionsReply)(phone, chatId, text, session, caregiverId);
            return;
        }
        await (0, onboardingConversation_1.handleOnboardingStep)(phone, chatId, text, session);
        return;
    }
    // Rate limit
    if (await isRateLimited(phone)) {
        await (0, client_1.sendMessage)(chatId, "I'm getting a lot of messages right now — try again in a bit! 😊");
        return;
    }
    // ── Caregiver keyword handling ──────────────────────────────────────────────
    if (session.userType === "caregiver") {
        const KEYWORDS = {
            ARRIVED: () => handleArrived(phone, chatId, session),
            DONE: () => handleDone(phone, chatId, session),
            LATE: () => handleRunningLate(phone, chatId),
            ISSUE: () => handleIssue(phone, chatId),
            CONFIRM: async () => {
                var _a, _b, _c;
                // Find most recent appointment for this caregiver not yet confirmed
                const now = new Date().toISOString();
                const apptSnap = await db.collection("appointments")
                    .where("caregiverId", "==", (_a = session.caregiverId) !== null && _a !== void 0 ? _a : "")
                    .where("status", "==", "confirmed")
                    .where("caregiverConfirmed", "!=", true)
                    .orderBy("caregiverConfirmed")
                    .orderBy("date", "asc")
                    .limit(1).get();
                if (!apptSnap.empty) {
                    const appt = apptSnap.docs[0].data();
                    await apptSnap.docs[0].ref.update({ caregiverConfirmed: true, caregiverConfirmedAt: now });
                    // Notify family
                    const familySnap = await db.collection("agent_sessions").doc((_b = appt.clientId) !== null && _b !== void 0 ? _b : appt.clientPhone).get();
                    if (familySnap.exists) {
                        await (0, client_1.sendMessage)(familySnap.data().chatId, `${(_c = appt.caregiverName) !== null && _c !== void 0 ? _c : "Your caregiver"} confirmed the visit on ${appt.date}! You're all set. 💙`);
                    }
                    await (0, client_1.sendMessage)(chatId, "Confirmed! See you then. 👍");
                }
                else {
                    await (0, client_1.sendMessage)(chatId, "Got it — confirmed! 👍");
                }
            },
            RESCHEDULE: async () => {
                await db.collection("agent_sessions").doc(phone).update({ caregiverRescheduling: true });
                await (0, client_1.sendMessage)(chatId, "No problem — text me 2–3 times that work for you and I'll let the family know right away.");
            },
            PASS: async () => {
                var _a;
                await (0, interviewAgent_1.handleCaregiverAvailabilityReply)(phone, (_a = session.caregiverId) !== null && _a !== void 0 ? _a : "", "", chatId, "PASS");
            },
        };
        if (norm in KEYWORDS) {
            await (0, client_1.startTyping)(chatId).catch(() => { });
            try {
                await KEYWORDS[norm]();
            }
            finally {
                await (0, client_1.stopTyping)(chatId).catch(() => { });
            }
            return;
        }
        // Awaiting care notes after DONE
        if (session.awaitingCareNotes) {
            await handleCareNotes(phone, chatId, text, session);
            return;
        }
        // Awaiting late minutes
        if (session.awaitingLateMinutes) {
            await db.collection("agent_sessions").doc(phone).update({ awaitingLateMinutes: false });
            const clientPhone = await (async () => {
                var _a;
                const today = new Date().toISOString().slice(0, 10);
                const snap = await db.collection("appointments")
                    .where("caregiverId", "==", (_a = session.caregiverId) !== null && _a !== void 0 ? _a : "")
                    .where("date", "==", today).limit(1).get();
                return snap.empty ? null : await getClientPhoneForAppt(snap.docs[0].data());
            })();
            if (clientPhone) {
                const clientSession = await db.collection("agent_sessions").doc(clientPhone).get();
                if (clientSession.exists) {
                    const cgSnap = session.caregiverId
                        ? await db.collection("caregivers").doc(session.caregiverId).get()
                        : null;
                    const cgName = (_s = (_r = cgSnap === null || cgSnap === void 0 ? void 0 : cgSnap.data()) === null || _r === void 0 ? void 0 : _r.name) !== null && _s !== void 0 ? _s : "Your caregiver";
                    const today = new Date().toISOString().slice(0, 10);
                    const appt = await db.collection("appointments")
                        .where("caregiverId", "==", (_t = session.caregiverId) !== null && _t !== void 0 ? _t : "")
                        .where("date", "==", today).limit(1).get();
                    const origTime = appt.empty ? "" : ` (originally ${appt.docs[0].data().startTime})`;
                    await (0, client_1.sendMessage)(clientSession.data().chatId, `${cgName} is running about ${text} late. They're on their way${origTime}. 🚗`);
                }
            }
            await (0, client_1.sendMessage)(chatId, "I've notified the family. Drive safe! 🚗");
            return;
        }
        // Awaiting issue description
        if (session.awaitingIssueDescription) {
            await db.collection("agent_sessions").doc(phone).update({ awaitingIssueDescription: false });
            await db.collection("admin_alerts").add({
                type: "caregiver_issue",
                caregiverId: (_u = session.caregiverId) !== null && _u !== void 0 ? _u : phone,
                phone,
                description: text,
                severity: "medium",
                createdAt: new Date().toISOString(),
                resolved: false,
            });
            const clientPhone = await (async () => {
                var _a;
                const today = new Date().toISOString().slice(0, 10);
                const snap = await db.collection("appointments")
                    .where("caregiverId", "==", (_a = session.caregiverId) !== null && _a !== void 0 ? _a : "")
                    .where("date", "==", today).limit(1).get();
                return snap.empty ? null : await getClientPhoneForAppt(snap.docs[0].data());
            })();
            if (clientPhone) {
                const clientSession = await db.collection("agent_sessions").doc(clientPhone).get();
                if (clientSession.exists) {
                    await (0, client_1.sendMessage)(clientSession.data().chatId, `Your caregiver flagged a concern during today's visit. Our team is looking into it and will follow up shortly.`);
                }
            }
            await (0, client_1.sendMessage)(chatId, "I've flagged this for our team and notified the family. Thank you for letting me know. 🙏");
            return;
        }
        // Caregiver rescheduling — parse new times and notify family
        if (session.caregiverRescheduling) {
            await db.collection("agent_sessions").doc(phone).update({ caregiverRescheduling: admin.firestore.FieldValue.delete() });
            const Anthropic = (await Promise.resolve().then(() => __importStar(require("@anthropic-ai/sdk")))).default;
            const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
            const parsed = await claude.messages.create({
                model: "claude-haiku-4-5-20251001",
                max_tokens: 100,
                system: "Extract interview time proposals from this message as a JSON array of human-readable strings. " +
                    "Reply with only a JSON array, e.g. [\"Tuesday 2pm\",\"Wednesday 10am\"]. Keep them short.",
                messages: [{ role: "user", content: text }],
            });
            let timeList = [];
            try {
                timeList = JSON.parse((_v = parsed.content[0].text) !== null && _v !== void 0 ? _v : "[]");
            }
            catch ( /* */_30) { /* */ }
            const timesText = timeList.length > 0 ? timeList.join(", ") : text;
            // Find the relevant interview request
            const caregiverId = (_w = session.caregiverId) !== null && _w !== void 0 ? _w : "";
            const cgSnap = caregiverId ? await db.collection("caregivers").doc(caregiverId).get() : null;
            const cgName = (_y = (_x = cgSnap === null || cgSnap === void 0 ? void 0 : cgSnap.data()) === null || _x === void 0 ? void 0 : _x.name) !== null && _y !== void 0 ? _y : "Your caregiver";
            const reqSnap = await db.collection("interview_requests")
                .where("caregiverId", "==", caregiverId)
                .where("status", "in", ["scheduled", "awaiting_client_confirmation"])
                .orderBy("createdAt", "desc").limit(1).get();
            if (!reqSnap.empty) {
                const reqData = reqSnap.docs[0].data();
                const familyPhone = reqData.clientPhone;
                const familySession = await db.collection("agent_sessions").doc(familyPhone).get();
                if (familySession.exists) {
                    await (0, client_1.sendMessage)(familySession.data().chatId, `${cgName} needs to reschedule the interview.\n\n` +
                        `They're available: ${timesText}\n\n` +
                        `Reply with which time works, or PASS to find someone new.`);
                    // Let family's next reply be handled as a time selection
                    await db.collection("agent_sessions").doc(familyPhone).update({
                        pendingTimeSelection: { interviewRequestId: reqSnap.docs[0].id, caregiverName: cgName },
                    });
                }
                await reqSnap.docs[0].ref.update({ status: "awaiting_client_confirmation", caregiverAvailability: timeList });
            }
            await (0, client_1.sendMessage)(chatId, "Got it — I've sent those times to the family! I'll let you know once they confirm. 📅");
            return;
        }
        // Caregiver availability reply (for interview scheduling)
        if (session.pendingInterviewAvailabilityRequest) {
            await (0, interviewAgent_1.handleCaregiverAvailabilityReply)(phone, (_z = session.caregiverId) !== null && _z !== void 0 ? _z : "", "", chatId, text);
            return;
        }
    }
    // ── Check for pending task (booking / emergency replacement) ───────────────
    const taskSnap = await db
        .collection("agent_tasks")
        .where("clientPhone", "==", phone)
        .where("status", "==", "awaiting_approval")
        .orderBy("createdAt", "desc").limit(1).get();
    const pendingTask = taskSnap.empty ? null : taskSnap.docs[0];
    await (0, client_1.startTyping)(chatId).catch(() => { });
    try {
        const intent = await (0, intentClassifier_1.classifyIntent)(text, !!pendingTask);
        // ── Emergency replacement: 1/2/3 ─────────────────────────────────────────
        if (intent === "TASK_REPLY" && pendingTask && ["1", "2", "3"].includes(text.trim())) {
            await (0, taskApprovalHandler_1.handleTaskApproval)(pendingTask, text.trim(), session, chatId);
            return;
        }
        // ── YES — booking or interview confirmation ───────────────────────────────
        if (norm === "YES" || norm === "Y") {
            if (pendingTask && pendingTask.data().type === "booking_confirmation") {
                await (0, bookingExecutor_1.executeBookings)(pendingTask.id, phone);
                return;
            }
            if (session.pendingInterviewConfirm) {
                await (0, interviewAgent_1.handleInterviewConfirm)(phone, chatId, session);
                return;
            }
            // YES to cancel confirmation
            if (session.pendingCancelConfirm) {
                const { appointmentId } = session.pendingCancelConfirm;
                const apptRef = db.collection("appointments").doc(appointmentId);
                const apptSnap = await apptRef.get();
                if (apptSnap.exists) {
                    const appt = apptSnap.data();
                    await apptRef.update({ status: "cancelled_by_client", cancelledAt: new Date().toISOString() });
                    // Notify caregiver
                    const cgSnap = await db.collection("caregivers").doc(appt.caregiverId).get();
                    const cgPhone = (_0 = cgSnap.data()) === null || _0 === void 0 ? void 0 : _0.phone;
                    if (cgPhone) {
                        const cgSess = await (await Promise.resolve().then(() => __importStar(require("./client")))).getOrCreateSession(cgPhone);
                        await (0, client_1.sendMessage)(cgSess.chatId, `The family has cancelled the visit on ${appt.date}. Sorry for the inconvenience.`);
                    }
                }
                await db.collection("agent_sessions").doc(phone).update({
                    pendingCancelConfirm: admin.firestore.FieldValue.delete(),
                });
                await (0, client_1.sendMessage)(chatId, "Cancelled. Want me to find a replacement for that day?");
                return;
            }
        }
        // ── NO — booking declined or interview time rejected ──────────────────────
        if (norm === "NO" || norm === "N") {
            // NO to booking summary
            if (pendingTask && pendingTask.data().type === "booking_confirmation") {
                await pendingTask.ref.update({ status: "declined" });
                await db.collection("agent_sessions").doc(phone).update({
                    pendingCancelConfirm: admin.firestore.FieldValue.delete(),
                });
                await (0, client_1.sendMessage)(chatId, "No problem — booking cancelled. Want me to look at different dates or a different caregiver?");
                return;
            }
            // NO to interview time — show other available times or offer alternatives
            if (session.pendingInterviewConfirm) {
                const pending = session.pendingInterviewConfirm;
                await db.collection("agent_sessions").doc(phone).update({
                    pendingInterviewConfirm: admin.firestore.FieldValue.delete(),
                });
                // Check if caregiver offered more times
                const reqSnap = await db.collection("interview_requests").doc(pending.docId).get();
                const availability = ((_2 = (_1 = reqSnap.data()) === null || _1 === void 0 ? void 0 : _1.caregiverAvailability) !== null && _2 !== void 0 ? _2 : []);
                // Remove the time we just rejected
                const remaining = availability.filter(t => t !== pending.mutualTime);
                if (remaining.length > 0) {
                    const timesList = remaining.map((t, i) => `${i + 1}. ${t}`).join("\n");
                    await db.collection("agent_sessions").doc(phone).update({
                        pendingTimeSelection: { interviewRequestId: pending.docId, caregiverName: pending.caregiverName },
                    });
                    await (0, client_1.sendMessage)(chatId, `No problem! ${pending.caregiverName} also offered:\n\n${timesList}\n\nReply with which time works, or PASS to find someone else.`);
                }
                else {
                    await (0, client_1.sendMessage)(chatId, `Understood. Want me to ask ${pending.caregiverName} for different times, or reach out to the next best caregiver?`);
                }
                return;
            }
            // NO to cancel confirmation — abort the cancellation
            if (session.pendingCancelConfirm) {
                await db.collection("agent_sessions").doc(phone).update({
                    pendingCancelConfirm: admin.firestore.FieldValue.delete(),
                });
                await (0, client_1.sendMessage)(chatId, "Got it — visit is still on! Let me know if you need anything.");
                return;
            }
        }
        // ── HIRE — post-interview decision ────────────────────────────────────────
        if (norm === "HIRE") {
            const pending = session.pendingInterviewOutcome;
            if (pending) {
                // Resolve caregiverId from interview_requests if not already on pending
                let caregiverId = (_3 = pending.caregiverId) !== null && _3 !== void 0 ? _3 : "";
                if (!caregiverId && pending.interviewId) {
                    const reqSnap = await db.collection("interview_requests")
                        .where("interviewId", "==", pending.interviewId)
                        .limit(1).get();
                    if (!reqSnap.empty)
                        caregiverId = (_4 = reqSnap.docs[0].data().caregiverId) !== null && _4 !== void 0 ? _4 : "";
                }
                await db.collection("agent_sessions").doc(phone).update({
                    hireMode: { caregiverName: pending.caregiverName, caregiverId },
                    pendingInterviewOutcome: admin.firestore.FieldValue.delete(),
                });
                await (0, client_1.sendMessage)(chatId, `Great choice — ${pending.caregiverName} is a fantastic caregiver! 🌟\n\n` +
                    `When would you like care to start? (e.g. "next Monday" or "May 19")`);
                return;
            }
            // No pending outcome — ask who
            await (0, client_1.sendMessage)(chatId, "Who would you like to hire? Reply with their name and I'll set it up.");
            return;
        }
        // ── MAYBE / PASS — post-interview ─────────────────────────────────────────
        if (norm === "MAYBE" || norm === "PASS") {
            const pending = session.pendingInterviewOutcome;
            if (pending) {
                const updates = {
                    pendingInterviewOutcome: admin.firestore.FieldValue.delete(),
                };
                if (pending.caregiverId) {
                    updates.rejectedCaregiverIds = admin.firestore.FieldValue.arrayUnion(pending.caregiverId);
                }
                await db.collection("agent_sessions").doc(phone).update(updates);
                if (norm === "MAYBE") {
                    await (0, client_1.sendMessage)(chatId, `Got it — I'll keep ${pending.caregiverName} in mind. Want me to reach out to anyone else?`);
                }
                else {
                    await (0, client_1.sendMessage)(chatId, `Understood. Want me to search for more caregivers? Reply YES and I'll get started.`);
                }
                return;
            }
        }
        // ── Caregiver selection (numbers after match presentation) ────────────────
        if (((_5 = session.pendingMatches) === null || _5 === void 0 ? void 0 : _5.length) > 0 && /[123]|all/i.test(text)) {
            await (0, interviewAgent_1.handleInterviewSelection)(phone, chatId, text, session);
            return;
        }
        // ── Permission update ─────────────────────────────────────────────────────
        if (intent === "PERMISSION_UPDATE") {
            const userId = (_7 = (_6 = session.userId) !== null && _6 !== void 0 ? _6 : session.caregiverId) !== null && _7 !== void 0 ? _7 : phone;
            const userType = (_8 = session.userType) !== null && _8 !== void 0 ? _8 : "client";
            await (0, permissionsConversation_1.updatePermissionFromText)(userId, userType, phone, chatId, text);
            return;
        }
        // ── hireMode step B — schedule reply ─────────────────────────────────────
        if (session.hireMode && session.hireModeDate) {
            const hire = session.hireMode;
            const dateStr = session.hireModeDate;
            const Anthropic = (await Promise.resolve().then(() => __importStar(require("@anthropic-ai/sdk")))).default;
            const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
            const parsedSchedule = await claude.messages.create({
                model: "claude-haiku-4-5-20251001",
                max_tokens: 120,
                system: "Extract a weekly care schedule from this message. " +
                    "Reply with only a JSON object: { \"days\": [\"Monday\",\"Wednesday\",\"Friday\"], " +
                    "\"startTime\": \"9:00 AM\", \"endTime\": \"1:00 PM\", \"durationHours\": 4 }. " +
                    "days must be full day names. durationHours is a number.",
                messages: [{ role: "user", content: text }],
            });
            let schedule = null;
            try {
                schedule = JSON.parse((_9 = parsedSchedule.content[0].text) !== null && _9 !== void 0 ? _9 : "null");
            }
            catch ( /* */_31) { /* */ }
            if (!schedule || !((_10 = schedule.days) === null || _10 === void 0 ? void 0 : _10.length)) {
                await (0, client_1.sendMessage)(chatId, "I didn't catch that — could you try again? (e.g. '3 days, Mon/Wed/Fri, 9am–1pm')");
                return;
            }
            // Fetch actual hourly rate from caregiver doc
            const cgDoc = await db.collection("caregivers").doc(hire.caregiverId).get();
            const hourlyRate = ((_12 = (_11 = cgDoc.data()) === null || _11 === void 0 ? void 0 : _11.hourlyRate) !== null && _12 !== void 0 ? _12 : 20);
            // Build one appointment per day starting from the hire date's week
            const startDate = new Date(dateStr + "T12:00:00Z");
            const dayIndexMap = {
                Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6,
            };
            const appointments = [];
            for (const day of schedule.days) {
                const target = (_13 = dayIndexMap[day]) !== null && _13 !== void 0 ? _13 : -1;
                if (target < 0)
                    continue;
                const d = new Date(startDate);
                const diff = (target - d.getUTCDay() + 7) % 7;
                d.setUTCDate(d.getUTCDate() + diff);
                appointments.push({
                    date: d.toISOString().slice(0, 10),
                    startTime: schedule.startTime,
                    endTime: schedule.endTime,
                    durationHours: schedule.durationHours,
                });
            }
            const clientId = (_14 = session.userId) !== null && _14 !== void 0 ? _14 : phone;
            const taskId = await (0, bookingExecutor_1.createBookingTask)({
                clientPhone: phone,
                clientId,
                caregiverId: hire.caregiverId,
                caregiverName: hire.caregiverName,
                appointments,
                hourlyRate,
            });
            await db.collection("agent_sessions").doc(phone).update({
                hireMode: admin.firestore.FieldValue.delete(),
                hireModeDate: admin.firestore.FieldValue.delete(),
            });
            const perms = await (0, permissionsConversation_1.getPermissions)((_15 = session.userId) !== null && _15 !== void 0 ? _15 : phone).catch(() => null);
            if (perms === null || perms === void 0 ? void 0 : perms.canBookAutomatically) {
                await (0, bookingExecutor_1.executeBookings)(taskId, phone);
            }
            else {
                const totalCost = (appointments.length * schedule.durationHours * hourlyRate).toFixed(2);
                const lines = appointments.map(a => `📅 ${a.date} · ${a.startTime}–${a.endTime}`).join("\n");
                await (0, client_1.sendMessage)(chatId, `Here's your booking summary:\n\n${lines}\n🤝 ${hire.caregiverName}\n💰 $${totalCost} total\n\nReply YES to confirm or NO to cancel.`);
            }
            return;
        }
        // ── hireMode step A — date reply ──────────────────────────────────────────
        if (session.hireMode && !session.hireModeDate) {
            const Anthropic = (await Promise.resolve().then(() => __importStar(require("@anthropic-ai/sdk")))).default;
            const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
            const parsedDate = await claude.messages.create({
                model: "claude-haiku-4-5-20251001",
                max_tokens: 20,
                system: `Today is ${new Date().toISOString().slice(0, 10)}. ` +
                    "The user is choosing a start date for care. Reply with only a YYYY-MM-DD date string, nothing else.",
                messages: [{ role: "user", content: text }],
            });
            const dateStr = ((_16 = parsedDate.content[0].text) !== null && _16 !== void 0 ? _16 : "").trim();
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
                await (0, client_1.sendMessage)(chatId, "I didn't catch that date — could you try again? (e.g. \"next Monday\" or \"May 19\")");
                return;
            }
            await db.collection("agent_sessions").doc(phone).update({ hireModeDate: dateStr });
            await (0, client_1.sendMessage)(chatId, `Got it — starting ${dateStr}.\n\nHow many days a week and what hours? (e.g. "3 days, Mon/Wed/Fri, 9am–1pm")`);
            return;
        }
        // ── pendingTimeSelection — family picking from caregiver's offered times ──
        if (session.pendingTimeSelection) {
            const sel = session.pendingTimeSelection;
            if (norm === "PASS") {
                await db.collection("agent_sessions").doc(phone).update({
                    pendingTimeSelection: admin.firestore.FieldValue.delete(),
                });
                await db.collection("interview_requests").doc(sel.interviewRequestId).update({ status: "client_declined" });
                await (0, client_1.sendMessage)(chatId, `No problem — want me to reach out to the next best caregiver? Reply YES and I'll get on it.`);
                return;
            }
            // Parse which time the family chose
            const reqSnap = await db.collection("interview_requests").doc(sel.interviewRequestId).get();
            const availability = ((_18 = (_17 = reqSnap.data()) === null || _17 === void 0 ? void 0 : _17.caregiverAvailability) !== null && _18 !== void 0 ? _18 : []);
            const Anthropic = (await Promise.resolve().then(() => __importStar(require("@anthropic-ai/sdk")))).default;
            const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
            const parsed = await claude.messages.create({
                model: "claude-haiku-4-5-20251001",
                max_tokens: 60,
                system: `Available times: ${availability.join(", ")}. ` +
                    "The user picked one of these times. Reply with only the exact string from the list that best matches their reply, or 'NONE' if no match.",
                messages: [{ role: "user", content: text }],
            });
            const chosen = ((_19 = parsed.content[0].text) !== null && _19 !== void 0 ? _19 : "").trim();
            if (chosen === "NONE" || !availability.includes(chosen)) {
                await (0, client_1.sendMessage)(chatId, `I didn't catch that — which of these works for you?\n\n${availability.join("\n")}\n\nOr reply PASS to find someone else.`);
                return;
            }
            // Book the chosen time
            await db.collection("agent_sessions").doc(phone).update({
                pendingTimeSelection: admin.firestore.FieldValue.delete(),
                pendingInterviewConfirm: { docId: sel.interviewRequestId, caregiverName: sel.caregiverName, mutualTime: chosen, formatted: chosen },
            });
            await (0, interviewAgent_1.handleInterviewConfirm)(phone, chatId, Object.assign(Object.assign({}, session), { pendingInterviewConfirm: { docId: sel.interviewRequestId, caregiverName: sel.caregiverName, mutualTime: chosen, formatted: chosen } }));
            return;
        }
        // ── CANCEL intent — cancel a visit, NOT an opt-out ────────────────────────
        if (intent === "CANCEL_REQUEST" || norm === "CANCEL") {
            const clientId = (_20 = session.userId) !== null && _20 !== void 0 ? _20 : phone;
            const upcoming = await db.collection("appointments")
                .where("clientId", "==", clientId)
                .where("status", "==", "confirmed")
                .orderBy("date", "asc").limit(1).get();
            if (upcoming.empty) {
                await (0, client_1.sendMessage)(chatId, "I don't see any upcoming visits to cancel. What were you looking to change?");
                return;
            }
            const appt = upcoming.docs[0].data();
            await db.collection("agent_sessions").doc(phone).update({
                pendingCancelConfirm: { appointmentId: upcoming.docs[0].id },
            });
            await (0, client_1.sendMessage)(chatId, `Cancel ${appt.caregiverName}'s visit on ${appt.date} (${appt.startTime}–${appt.endTime})?\n\nReply YES to confirm or NO to keep it.`);
            return;
        }
        // ── Pending rebook — waiting for client to supply a date ─────────────────
        if (session.pendingRebook) {
            const rebook = session.pendingRebook;
            const Anthropic = (await Promise.resolve().then(() => __importStar(require("@anthropic-ai/sdk")))).default;
            const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
            const parsedDate = await claude.messages.create({
                model: "claude-haiku-4-5-20251001",
                max_tokens: 20,
                system: `Today is ${new Date().toISOString().slice(0, 10)}. ` +
                    "The user is choosing a date for a care visit. Reply with only a YYYY-MM-DD date string, nothing else.",
                messages: [{ role: "user", content: text }],
            });
            const dateStr = ((_21 = parsedDate.content[0].text) !== null && _21 !== void 0 ? _21 : "").trim();
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
                await (0, client_1.sendMessage)(chatId, "I didn't catch that date — could you try again? (e.g. \"May 19\" or \"next Monday\")");
                return;
            }
            const clientId = (_22 = session.userId) !== null && _22 !== void 0 ? _22 : phone;
            const taskId = await (0, bookingExecutor_1.createBookingTask)({
                clientPhone: phone,
                clientId,
                caregiverId: rebook.caregiverId,
                caregiverName: rebook.caregiverName,
                appointments: [{ date: dateStr, startTime: rebook.startTime, endTime: rebook.endTime, durationHours: rebook.durationHours }],
                hourlyRate: 20,
            });
            await db.collection("agent_sessions").doc(phone).update({ pendingRebook: admin.firestore.FieldValue.delete() });
            const perms = await (0, permissionsConversation_1.getPermissions)((_23 = session.userId) !== null && _23 !== void 0 ? _23 : phone).catch(() => null);
            if (perms === null || perms === void 0 ? void 0 : perms.canBookAutomatically) {
                await (0, bookingExecutor_1.executeBookings)(taskId, phone);
            }
            else {
                const cost = (rebook.durationHours * 20).toFixed(2);
                await (0, client_1.sendMessage)(chatId, `Here's your booking summary:\n\n` +
                    `📅 ${dateStr} · ${rebook.startTime}–${rebook.endTime}\n` +
                    `🤝 ${rebook.caregiverName}\n` +
                    `💰 $${cost}\n\n` +
                    `Reply YES to confirm or NO to cancel.`);
            }
            return;
        }
        // ── Rebook request ────────────────────────────────────────────────────────
        if (intent === "REBOOK_REQUEST") {
            const clientId = (_24 = session.userId) !== null && _24 !== void 0 ? _24 : phone;
            const lastApptSnap = await db.collection("appointments")
                .where("clientId", "==", clientId)
                .where("status", "==", "confirmed")
                .orderBy("date", "desc").limit(1).get();
            if (lastApptSnap.empty) {
                await (0, client_1.sendMessage)(chatId, "I don't have any past bookings to rebook from. Want me to search for a caregiver? Just let me know!");
                return;
            }
            const last = lastApptSnap.docs[0].data();
            const caregiverId = last.caregiverId;
            const caregiverName = last.caregiverName;
            const startTime = last.startTime;
            const endTime = last.endTime;
            const durationHours = ((_25 = last.durationHours) !== null && _25 !== void 0 ? _25 : 4);
            await db.collection("agent_sessions").doc(phone).update({
                pendingRebook: { caregiverId, caregiverName, startTime, endTime, durationHours },
            });
            await (0, client_1.sendMessage)(chatId, `Got it — same schedule with ${caregiverName} (${startTime}–${endTime})?\n\n` +
                `What date should the visit be?`);
            return;
        }
        // ── Default: QA agent ─────────────────────────────────────────────────────
        await (0, qaAgent_1.runQaAgent)({
            text,
            phone,
            chatId,
            userId: (_26 = session.userId) !== null && _26 !== void 0 ? _26 : "",
            seniorId: (_28 = (_27 = session.seniorId) !== null && _27 !== void 0 ? _27 : session.userId) !== null && _28 !== void 0 ? _28 : "",
            userType: (_29 = session.userType) !== null && _29 !== void 0 ? _29 : "client",
            caregiverId: session.caregiverId,
        });
    }
    catch (err) {
        console.error("handleInbound error:", err);
        await (0, client_1.stopTyping)(chatId).catch(() => { });
        await (0, client_1.sendMessage)(chatId, "I'm having trouble right now. For urgent concerns, please call 911.");
        await db.collection("agent_error_log").add({
            phone, error: String(err), text, createdAt: new Date().toISOString(),
        }).catch(() => { });
    }
    finally {
        await (0, client_1.stopTyping)(chatId).catch(() => { });
    }
}
// ── Webhook HTTPS function ────────────────────────────────────────────────────
exports.linqWebhook = functions.https.onRequest(async (req, res) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q;
    res.status(200).send("ok");
    if (req.method !== "POST")
        return;
    const webhookSecret = process.env.LINQ_WEBHOOK_SECRET;
    if (webhookSecret) {
        const timestamp = (_a = req.headers["x-webhook-timestamp"]) !== null && _a !== void 0 ? _a : "";
        const signature = (_b = req.headers["x-webhook-signature"]) !== null && _b !== void 0 ? _b : "";
        const rawBody = (_c = req.rawBody) !== null && _c !== void 0 ? _c : Buffer.from(JSON.stringify(req.body));
        if (!verifySignature(rawBody, timestamp, signature, webhookSecret)) {
            console.warn("linqWebhook: invalid signature — ignoring");
            return;
        }
        // FIX 9 — reject stale events (replay attack protection)
        const tsNum = parseInt(timestamp, 10);
        if (!isNaN(tsNum) && Math.abs(Date.now() / 1000 - tsNum) > 300) {
            console.warn("linqWebhook: stale timestamp — ignoring");
            return;
        }
    }
    const event = req.body;
    // FIX 10 — deduplicate by event_id to prevent double-processing on retry
    const eventId = (_d = event.event_id) !== null && _d !== void 0 ? _d : event.id;
    if (eventId && event.type === "message.received") {
        const logRef = db.collection("agent_event_log").doc(eventId);
        const existing = await logRef.get();
        if (existing.exists)
            return; // already processed
        await logRef.set({ processedAt: new Date().toISOString() });
    }
    switch (event.type) {
        case "message.received":
            await handleInbound(event).catch((err) => console.error("linqWebhook handleInbound:", err));
            break;
        case "message.read":
            await db.collection("agent_read_receipts").add({
                chatId: (_f = (_e = event.data) === null || _e === void 0 ? void 0 : _e.chat) === null || _f === void 0 ? void 0 : _f.id,
                messageId: (_g = event.data) === null || _g === void 0 ? void 0 : _g.message_id,
                phone: (_j = (_h = event.data) === null || _h === void 0 ? void 0 : _h.sender_handle) === null || _j === void 0 ? void 0 : _j.value,
                readAt: new Date().toISOString(),
            }).catch(() => { });
            break;
        case "reaction.added":
            await db.collection("agent_reactions").add({
                chatId: (_l = (_k = event.data) === null || _k === void 0 ? void 0 : _k.chat) === null || _l === void 0 ? void 0 : _l.id,
                messageId: (_m = event.data) === null || _m === void 0 ? void 0 : _m.message_id,
                reaction: (_o = event.data) === null || _o === void 0 ? void 0 : _o.reaction,
                phone: (_q = (_p = event.data) === null || _p === void 0 ? void 0 : _p.sender_handle) === null || _q === void 0 ? void 0 : _q.value,
                reactedAt: new Date().toISOString(),
            }).catch(() => { });
            break;
        case "chat.typing_indicator.started":
            await handleTypingStarted(event).catch((err) => console.error("linqWebhook handleTypingStarted:", err));
            break;
        default:
            break;
    }
});
//# sourceMappingURL=webhooks.js.map