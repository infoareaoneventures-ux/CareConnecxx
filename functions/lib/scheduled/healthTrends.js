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
exports.triggerHealthTrendsNow = exports.sendMonthlyHealthTrends = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const client_1 = require("../linq/client");
const db = admin.firestore();
let _client = null;
function getClient() {
    if (!_client)
        _client = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    return _client;
}
// ── Data loader — 90 days of journal entries ──────────────────────────────────
async function load90Days(seniorId, userId) {
    var _a, _b, _c, _d;
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const [journalSnap, apptSnap, seniorSnap] = await Promise.all([
        db.collection("care_journal")
            .where("seniorId", "==", seniorId)
            .where("timestamp", ">=", ninetyDaysAgo)
            .orderBy("timestamp", "asc")
            .limit(100)
            .get(),
        db.collection("appointments")
            .where("clientId", "==", userId)
            .where("isoDate", ">=", ninetyDaysAgo.slice(0, 10))
            .limit(100)
            .get(),
        db.collection("senior_profiles").doc(seniorId).get(),
    ]);
    return {
        journal: journalSnap.docs.map(d => d.data()),
        appts: apptSnap.docs.map(d => d.data()),
        seniorName: (_b = (_a = seniorSnap.data()) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : "Senior",
        seniorNeeds: (_d = (_c = seniorSnap.data()) === null || _c === void 0 ? void 0 : _c.needs) !== null && _d !== void 0 ? _d : [],
    };
}
// ── Claude trend analysis ─────────────────────────────────────────────────────
async function analyzeTrends(data) {
    var _a, _b, _c, _d, _e, _f;
    const { journal, appts, seniorName } = data;
    const completedAppts = appts.filter(a => a.status === "completed").length;
    const cancelledAppts = appts.filter(a => a.status === "cancelled").length;
    // Aggregate wellness data
    const moodCounts = {};
    let ateWellCount = 0, tookMedsCount = 0, wasActiveCount = 0;
    for (const e of journal) {
        const mood = (_a = e.wellness) === null || _a === void 0 ? void 0 : _a.mood;
        if (mood)
            moodCounts[mood] = ((_b = moodCounts[mood]) !== null && _b !== void 0 ? _b : 0) + 1;
        if ((_c = e.wellness) === null || _c === void 0 ? void 0 : _c.ateWell)
            ateWellCount++;
        if ((_d = e.wellness) === null || _d === void 0 ? void 0 : _d.tookMeds)
            tookMedsCount++;
        if ((_e = e.wellness) === null || _e === void 0 ? void 0 : _e.wasActive)
            wasActiveCount++;
    }
    const total = journal.length || 1;
    const allNotes = journal
        .map(e => e.notes)
        .filter(Boolean)
        .join(" | ")
        .slice(0, 3000);
    const prompt = [
        `You are analyzing 90 days of care data for ${seniorName}.`,
        ``,
        `Stats:`,
        `- ${journal.length} journal entries recorded`,
        `- ${completedAppts} of ${completedAppts + cancelledAppts} appointments completed`,
        `- Ate well: ${Math.round(ateWellCount / total * 100)}% of visits`,
        `- Medications taken: ${Math.round(tookMedsCount / total * 100)}% of visits`,
        `- Physically active: ${Math.round(wasActiveCount / total * 100)}% of visits`,
        `- Mood distribution: ${JSON.stringify(moodCounts)}`,
        ``,
        `Caregiver notes (last 90 days):`,
        allNotes || "No notes recorded",
        ``,
        `Respond with valid JSON only, no markdown:`,
        `{`,
        `  "trends": ["3-5 observed trends over the 90 days"],`,
        `  "flags": ["0-3 concerns worth discussing with a doctor, empty if none"],`,
        `  "highlights": "2-3 sentence warm summary a family could share with a physician"`,
        `}`,
    ].join("\n");
    try {
        const response = await getClient().messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 500,
            messages: [{ role: "user", content: prompt }],
        });
        const raw = ((_f = response.content[0].text) !== null && _f !== void 0 ? _f : "").trim();
        return JSON.parse(raw);
    }
    catch (err) {
        console.error("healthTrends Claude error:", err);
        return {
            trends: [`${completedAppts} appointments completed over 90 days`],
            flags: [],
            highlights: `${seniorName} received consistent care over the past 90 days.`,
        };
    }
}
// ── Scheduled function — 1st of each month at 9am ET ────────────────────────
// ── Core logic (shared by scheduled + manual trigger) ────────────────────────
async function runMonthlyHealthTrends() {
    var _a, _b;
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
            const seniorId = (_a = session.seniorId) !== null && _a !== void 0 ? _a : session.userId;
            const data = await load90Days(seniorId, session.userId);
            if (data.journal.length < 3)
                continue;
            const analysis = await analyzeTrends(data);
            const shareToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
            const period = new Date().toISOString().slice(0, 7);
            const trend = {
                seniorId,
                clientId: session.userId,
                period,
                trends: analysis.trends,
                flags: analysis.flags,
                highlights: analysis.highlights,
                generatedAt: new Date().toISOString(),
                shareToken,
            };
            await db.collection("health_trends").doc(`${seniorId}_${period}`).set(trend);
            const appUrl = (_b = process.env.APP_URL) !== null && _b !== void 0 ? _b : "https://cara.app";
            const summaryUrl = `${appUrl}/health-summary/${shareToken}`;
            const monthName = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });
            const linkMessage = { parts: [{ type: "link", value: summaryUrl }] };
            if (session.chatId) {
                await (0, client_1.sendMessage)(session.chatId, linkMessage);
                await (0, client_1.sendMessage)(session.chatId, `Here's ${data.seniorName}'s ${monthName} health summary — 90 days of care data.\n` +
                    `You can share this directly with their doctor or print it from that page.\n\n` +
                    (analysis.highlights ? `This month: ${analysis.highlights}` : ""));
            }
            else {
                await (0, client_1.sendToPhone)(phone, `${data.seniorName}'s ${monthName} health summary is ready: ${summaryUrl}`);
            }
            sent++;
            await new Promise(r => setTimeout(r, 300));
        }
        catch (err) {
            console.error(`healthTrends error for session ${sessionDoc.id}:`, err);
        }
    }
    console.log(`healthTrends: sent ${sent} reports`);
    return sent;
}
// ── Scheduled function — 1st of each month at 9am ET ────────────────────────
exports.sendMonthlyHealthTrends = functions.pubsub
    .schedule("0 14 1 * *") // 9am ET = 14:00 UTC
    .timeZone("UTC")
    .onRun(() => runMonthlyHealthTrends());
// ── Manual trigger for testing (admin only) ───────────────────────────────────
exports.triggerHealthTrendsNow = functions.https.onCall(async (_, context) => {
    var _a;
    if (!((_a = context.auth) === null || _a === void 0 ? void 0 : _a.token.admin)) {
        throw new functions.https.HttpsError("permission-denied", "Admin only");
    }
    const sent = await runMonthlyHealthTrends();
    return { sent };
});
//# sourceMappingURL=healthTrends.js.map