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
exports.triggerWeeklyDigestNow = exports.sendWeeklyDigests = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const client_1 = require("../linq/client");
const permissionsConversation_1 = require("../agents/permissionsConversation");
const db = admin.firestore();
let _client = null;
function getClient() {
    if (!_client)
        _client = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    return _client;
}
// ── Data loaders ──────────────────────────────────────────────────────────────
async function getWeekData(seniorId, userId) {
    var _a, _b, _c, _d, _e, _f, _g;
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const weekAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const [journalSnap, pastApptSnap, upcomingSnap, seniorSnap, userSnap] = await Promise.all([
        db.collection("care_journal")
            .where("seniorId", "==", seniorId)
            .where("timestamp", ">=", weekAgo)
            .orderBy("timestamp", "desc")
            .limit(10)
            .get(),
        db.collection("appointments")
            .where("clientId", "==", userId)
            .where("isoDate", ">=", weekAgo)
            .where("isoDate", "<=", now.toISOString())
            .where("status", "==", "completed")
            .limit(10)
            .get(),
        db.collection("appointments")
            .where("clientId", "==", userId)
            .where("isoDate", ">", now.toISOString())
            .where("isoDate", "<=", weekAhead)
            .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
            .orderBy("isoDate", "asc")
            .limit(5)
            .get(),
        db.collection("senior_profiles").doc(seniorId).get(),
        db.collection("users").doc(userId).get(),
    ]);
    return {
        journal: journalSnap.docs.map(d => d.data()),
        pastAppts: pastApptSnap.docs.map(d => d.data()),
        upcoming: upcomingSnap.docs.map(d => d.data()),
        seniorName: (_b = (_a = seniorSnap.data()) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : "your loved one",
        clientName: (_g = (_d = (_c = userSnap.data()) === null || _c === void 0 ? void 0 : _c.firstName) !== null && _d !== void 0 ? _d : (_f = (_e = userSnap.data()) === null || _e === void 0 ? void 0 : _e.name) === null || _f === void 0 ? void 0 : _f.split(" ")[0]) !== null && _g !== void 0 ? _g : "there",
    };
}
// ── Claude digest generation ──────────────────────────────────────────────────
async function generateDigest(data) {
    var _a;
    const { journal, pastAppts, upcoming, seniorName, clientName } = data;
    if (journal.length === 0 && pastAppts.length === 0) {
        return `Good morning ${clientName} ☀️ No visits were logged this week for ${seniorName}. If this seems wrong, please check the app or contact support.`;
    }
    const journalContext = journal.map(e => {
        var _a, _b, _c, _d, _e, _f, _g;
        const mood = (_b = (_a = e.wellness) === null || _a === void 0 ? void 0 : _a.mood) !== null && _b !== void 0 ? _b : "unknown";
        const ateWell = ((_c = e.wellness) === null || _c === void 0 ? void 0 : _c.ateWell) ? "ate well" : "appetite concerns";
        const meds = ((_d = e.wellness) === null || _d === void 0 ? void 0 : _d.tookMeds) ? "meds taken" : "meds missed";
        return `- ${(_e = e.timestamp) === null || _e === void 0 ? void 0 : _e.slice(0, 10)}: mood ${mood}, ${ateWell}, ${meds}. Notes: ${(_g = (_f = e.notes) === null || _f === void 0 ? void 0 : _f.slice(0, 150)) !== null && _g !== void 0 ? _g : "none"}`;
    }).join("\n");
    const apptContext = upcoming.map(a => `- ${a.date} at ${a.time} with ${a.caregiverName}`).join("\n");
    const completedCount = pastAppts.length;
    const now = new Date();
    const dayName = now.toLocaleDateString("en-US", { weekday: "long" });
    const prompt = [
        `You're writing a warm Sunday morning care update text for ${clientName} about ${seniorName}.`,
        ``,
        `This week's data:`,
        `- ${completedCount} visit(s) completed`,
        `Journal entries:\n${journalContext || "None"}`,
        `Upcoming visits:\n${apptContext || "None scheduled"}`,
        ``,
        `Write a warm, personal weekly summary as a text message. Use simple emoji. Include:`,
        `1. A "Good morning" greeting with the day`,
        `2. Quick stats on visits completed`,
        `3. 2-3 notable observations from the journal (mood, appetite, activity)`,
        `4. Upcoming visits this week (date, time, caregiver)`,
        `5. One warm closing line`,
        ``,
        `Keep it under 300 words. Conversational, not clinical. No markdown, just plain text with line breaks.`,
    ].join("\n");
    try {
        const response = await getClient().messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 400,
            messages: [{ role: "user", content: prompt }],
        });
        return ((_a = response.content[0].text) !== null && _a !== void 0 ? _a : "").trim();
    }
    catch (err) {
        console.error("weeklyDigest Claude error:", err);
        return (`Good morning ${clientName} ☀️ Here's ${seniorName}'s week:\n\n` +
            `✅ ${completedCount} visit(s) completed\n\n` +
            (apptContext ? `Coming up:\n${apptContext}\n\n` : "") +
            `Have a wonderful ${dayName}.`);
    }
}
// ── Core logic (shared by scheduled + manual trigger) ────────────────────────
async function runWeeklyDigests() {
    var _a;
    const sessionsSnap = await db
        .collection("agent_sessions")
        .where("optedOut", "==", false)
        .get();
    let sent = 0;
    for (const sessionDoc of sessionsSnap.docs) {
        const session = sessionDoc.data();
        if (!session.userId || session.optedIn === false)
            continue;
        try {
            const phone = sessionDoc.id;
            // Check permission before sending
            const perms = await (0, permissionsConversation_1.getPermissions)(session.userId).catch(() => null);
            if (perms !== null && perms.canSendWeeklyDigest === false)
                continue;
            const seniorId = (_a = session.seniorId) !== null && _a !== void 0 ? _a : session.userId;
            const data = await getWeekData(seniorId, session.userId);
            const digest = await generateDigest(data);
            if (session.chatId) {
                await (0, client_1.sendMessage)(session.chatId, digest);
            }
            else {
                await (0, client_1.sendToPhone)(phone, digest);
            }
            const today = new Date().toISOString().slice(0, 10);
            await db.collection("weekly_digests").doc(`${session.userId}_${today}`).set({
                clientId: session.userId,
                seniorId,
                phone,
                sentAt: new Date().toISOString(),
                digestLen: digest.length,
            });
            sent++;
            await new Promise(r => setTimeout(r, 200));
        }
        catch (err) {
            console.error(`weeklyDigest error for session ${sessionDoc.id}:`, err);
        }
    }
    console.log(`weeklyDigest: sent ${sent} digests`);
    return sent;
}
// ── Scheduled function — every Sunday at 8am ET ───────────────────────────────
exports.sendWeeklyDigests = functions.pubsub
    .schedule("0 13 * * 0") // 8am ET = 13:00 UTC
    .timeZone("UTC")
    .onRun(() => runWeeklyDigests());
// ── Manual trigger for testing (admin only) ───────────────────────────────────
exports.triggerWeeklyDigestNow = functions.https.onCall(async (_, context) => {
    var _a;
    if (!((_a = context.auth) === null || _a === void 0 ? void 0 : _a.token.admin)) {
        throw new functions.https.HttpsError("permission-denied", "Admin only");
    }
    const sent = await runWeeklyDigests();
    return { sent };
});
//# sourceMappingURL=weeklyDigest.js.map