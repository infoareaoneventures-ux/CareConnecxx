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
exports.sendMorningBriefings = void 0;
exports.checkCaregiverWorkloads = checkCaregiverWorkloads;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const caraAgent_1 = require("../agents/caraAgent");
const server_1 = require("../mcp/server");
const learnedFacts_1 = require("../memory/learnedFacts");
const memoryFiles_1 = require("../memory/memoryFiles");
const preferences_1 = require("../memory/preferences");
let _client = null;
function getClient() {
    if (!_client)
        _client = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    return _client;
}
const db = admin.firestore();
// Runs every day at 7am local (12:00 UTC covers most US time zones at 7am)
exports.sendMorningBriefings = functions.pubsub
    .schedule("0 12 * * *")
    .timeZone("America/Los_Angeles")
    .onRun(async () => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
    const today = new Date().toISOString().slice(0, 10);
    // Find all confirmed appointments for today
    const snap = await db.collection("appointments")
        .where("date", "==", today)
        .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
        .get();
    for (const doc of snap.docs) {
        const appt = doc.data();
        const caregiverId = appt.caregiverId;
        if (!caregiverId)
            continue;
        try {
            const [cgSnap, clientSnap, carePlanSnap] = await Promise.all([
                db.collection("caregivers").doc(caregiverId).get(),
                db.collection("users").doc(appt.clientId).get(),
                db.collection("care_plans").doc(appt.clientId).get(),
            ]);
            const caregiver = cgSnap.data();
            if (!(caregiver === null || caregiver === void 0 ? void 0 : caregiver.phone))
                continue;
            const cgSession = await db.collection("agent_sessions").doc(caregiver.phone).get();
            if (!cgSession.exists)
                continue;
            const senior = clientSnap.data();
            const carePlan = carePlanSnap.data();
            const cgFirstName = ((_a = caregiver.name) !== null && _a !== void 0 ? _a : "there").split(" ")[0];
            const seniorName = ((_c = (_b = senior === null || senior === void 0 ? void 0 : senior.seniorName) !== null && _b !== void 0 ? _b : appt.clientName) !== null && _c !== void 0 ? _c : "your client");
            const address = ((_e = (_d = appt.address) !== null && _d !== void 0 ? _d : appt.location) !== null && _e !== void 0 ? _e : "the client's home");
            const schedule = `${(_f = appt.startTime) !== null && _f !== void 0 ? _f : ""}${appt.endTime ? `–${appt.endTime}` : ""}`;
            const mapsUrl = `https://maps.google.com/?q=${encodeURIComponent(address)}`;
            // Fetch last journal entry for context
            const lastJournal = await db.collection("care_journal")
                .where("seniorId", "==", appt.clientId)
                .orderBy("timestamp", "desc")
                .limit(1)
                .get()
                .catch(() => null);
            const lastNotes = (lastJournal === null || lastJournal === void 0 ? void 0 : lastJournal.empty) ? null :
                (_g = lastJournal === null || lastJournal === void 0 ? void 0 : lastJournal.docs[0].data().notes) !== null && _g !== void 0 ? _g : null;
            // Build context note from last visit or care plan note
            const contextNote = lastNotes
                ? lastNotes.slice(0, 120)
                : ((carePlan === null || carePlan === void 0 ? void 0 : carePlan.notes) ? carePlan.notes.slice(0, 120) : null);
            // Medication line — only if there are meds
            const meds = (_h = carePlan === null || carePlan === void 0 ? void 0 : carePlan.medications) !== null && _h !== void 0 ? _h : [];
            const medLine = meds.length > 0
                ? `Medications: ${meds.slice(0, 2).join(", ")}.`
                : null;
            // Verified badge — show for first 30 days after background check clears
            const clearedAt = (_j = caregiver === null || caregiver === void 0 ? void 0 : caregiver.backgroundCheckData) === null || _j === void 0 ? void 0 : _j.clearedAt;
            const verifiedNote = (((_k = caregiver === null || caregiver === void 0 ? void 0 : caregiver.backgroundCheckData) === null || _k === void 0 ? void 0 : _k.status) === "clear" &&
                clearedAt &&
                Date.now() - new Date(clearedAt).getTime() < 30 * 24 * 60 * 60 * 1000)
                ? `Your background check is active and current. ✓`
                : null;
            const fallbackLines = [
                `Morning ${cgFirstName}! ${seniorName} today${schedule ? ` — ${schedule}` : ""} at ${address}.`,
                mapsUrl,
                contextNote,
                medLine,
                verifiedNote,
                `Reply ARRIVED when you get there.`,
            ].filter(Boolean);
            let content;
            try {
                const briefingPrompt = (0, server_1.handlePromptGet)("morning-caregiver-briefing", {
                    caregiverName: cgFirstName,
                    seniorName,
                    schedule: schedule !== null && schedule !== void 0 ? schedule : "",
                    address,
                    mapsUrl: mapsUrl !== null && mapsUrl !== void 0 ? mapsUrl : "",
                    medLine: medLine !== null && medLine !== void 0 ? medLine : "",
                    verifiedNote: verifiedNote !== null && verifiedNote !== void 0 ? verifiedNote : "",
                });
                const aiResponse = await getClient().messages.create({
                    model: "claude-haiku-4-5-20251001",
                    max_tokens: 200,
                    messages: [{ role: "user", content: briefingPrompt }],
                });
                content = ((_l = aiResponse.content[0].text) !== null && _l !== void 0 ? _l : "").trim()
                    || fallbackLines.join("\n\n");
            }
            catch (_m) {
                content = fallbackLines.join("\n\n");
            }
            await (0, caraAgent_1.sendViaInteractionAgent)(caregiver.phone, {
                content,
                urgency: "standard",
                sourceAgent: "morning_briefing",
                canDrop: true,
            });
        }
        catch (err) {
            console.error("morningBriefing error for appt", doc.id, err);
        }
    }
    // ── Family morning briefings — send to clients with visits today ──────────
    await sendFamilyMorningBriefings(today, snap.docs).catch(err => console.error("[morningBriefing] sendFamilyMorningBriefings error:", err));
    // Check caregiver workloads (run Monday mornings to catch the week ahead)
    const dayOfWeek = new Date().getDay();
    if (dayOfWeek === 1) { // Monday
        await checkCaregiverWorkloads().catch(err => console.error("[morningBriefing] checkCaregiverWorkloads error:", err));
    }
});
// ── Caregiver workload awareness ──────────────────────────────────────────────
async function checkCaregiverWorkloads() {
    var _a, _b, _c, _d;
    const today = new Date().toISOString().slice(0, 10);
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Sunday
    const weekStartStr = weekStart.toISOString().slice(0, 10);
    // Get all caregivers with confirmed/completed appointments this week
    const apptSnap = await db.collection("appointments")
        .where("status", "in", ["confirmed", "completed", "in-progress"])
        .where("date", ">=", weekStartStr)
        .where("date", "<=", today)
        .get();
    if (apptSnap.empty)
        return;
    // Sum hours by caregiver
    const hoursById = {};
    for (const doc of apptSnap.docs) {
        const d = doc.data();
        const cgId = d.caregiverId;
        const cgName = d.caregiverName;
        if (!cgId)
            continue;
        const startTime = (_a = d.startTime) !== null && _a !== void 0 ? _a : "09:00";
        const endTime = (_d = (_b = d.endTime) !== null && _b !== void 0 ? _b : (_c = d.completedAt) === null || _c === void 0 ? void 0 : _c.slice(11, 16)) !== null && _d !== void 0 ? _d : "17:00";
        const [sh, sm] = startTime.split(":").map(Number);
        const [eh, em] = endTime.split(":").map(Number);
        const durationH = Math.max(0, (eh * 60 + em - sh * 60 - sm) / 60);
        if (!hoursById[cgId])
            hoursById[cgId] = { hours: 0, name: cgName, phone: undefined };
        hoursById[cgId].hours += durationH;
        if (!hoursById[cgId].name)
            hoursById[cgId].name = cgName;
    }
    // For caregivers at 45h+, send a wellness message (once per week)
    for (const [cgId, data] of Object.entries(hoursById)) {
        if (data.hours < 45)
            continue;
        try {
            const cgSnap = await db.collection("caregivers").doc(cgId).get();
            const cgData = cgSnap.data();
            if (!cgData)
                continue;
            // Check if we sent this week already
            const lastWorkloadAlert = cgData.lastWorkloadAlertWeek;
            if (lastWorkloadAlert === weekStartStr)
                continue;
            const cgPhone = cgData.phone;
            if (!cgPhone)
                continue;
            await (0, caraAgent_1.sendViaInteractionAgent)(cgPhone, {
                content: `You're scheduled for ${Math.round(data.hours)} hours this week — that's a full load. ` +
                    `Make sure you're taking care of yourself too. Reply SCHEDULE to see your week.`,
                urgency: "standard",
                sourceAgent: "workload_check",
                canDrop: true,
            });
            await db.collection("caregivers").doc(cgId).update({
                lastWorkloadAlertWeek: weekStartStr,
            });
        }
        catch (err) {
            console.error(`[checkCaregiverWorkloads] Error for caregiver ${cgId}:`, err);
        }
    }
}
// ── Family morning briefings ─────────────────────────────────────────────────
async function sendFamilyMorningBriefings(today, apptDocs) {
    var _a, _b, _c, _d, _e, _f;
    // Deduplicate by clientId — one briefing per family even with multiple visits
    const seenClients = new Set();
    for (const doc of apptDocs) {
        const appt = doc.data();
        const clientId = appt.clientId;
        if (!clientId || seenClients.has(clientId))
            continue;
        seenClients.add(clientId);
        try {
            const [clientSnap, cgSnap] = await Promise.all([
                db.collection("users").doc(clientId).get(),
                appt.caregiverId ? db.collection("caregivers").doc(appt.caregiverId).get() : Promise.resolve(null),
            ]);
            const clientData = clientSnap.data();
            if (!clientData)
                continue;
            const phone = clientData.phone;
            if (!phone)
                continue;
            const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
            if (!sessionSnap.exists)
                continue;
            const session = sessionSnap.data();
            if (session.optedOut)
                continue;
            // Respect DND and preferred summary time from preferences
            const prefs = await (0, preferences_1.getPreferences)(phone).catch(() => null);
            if (prefs && (0, preferences_1.isInDND)(prefs))
                continue;
            if (prefs === null || prefs === void 0 ? void 0 : prefs.preferredSummaryTime) {
                const [prefH] = prefs.preferredSummaryTime.split(":").map(Number);
                const nowHour = new Date().getHours();
                if (Math.abs(nowHour - prefH) > 1)
                    continue;
            }
            // Avoid duplicate sends — check if we sent a family briefing today already
            const lastBriefingSnap = await db.collection("agent_alerts_log")
                .where("type", "==", "family_morning_briefing")
                .where("clientId", "==", clientId)
                .where("sentAt", ">=", today)
                .limit(1)
                .get();
            if (!lastBriefingSnap.empty)
                continue;
            const caregiverName = ((_c = (_b = (_a = cgSnap === null || cgSnap === void 0 ? void 0 : cgSnap.data()) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : appt.caregiverName) !== null && _c !== void 0 ? _c : "Your caregiver");
            const seniorName = ((_d = clientData.seniorName) !== null && _d !== void 0 ? _d : "your loved one");
            const startTime = ((_e = appt.startTime) !== null && _e !== void 0 ? _e : "");
            const schedule = startTime ? `at ${startTime}` : "today";
            // Load memory context for care priorities
            const [facts, memCtx] = await Promise.all([
                (0, learnedFacts_1.getRelevantFacts)(clientId).catch(() => []),
                (0, memoryFiles_1.getMemoryContext)(clientId).catch(() => ""),
            ]);
            const topFacts = facts
                .filter(f => f.category === "medical" || f.category === "routine")
                .slice(0, 3)
                .map(f => f.fact);
            // Generate briefing via Claude Haiku
            let content;
            try {
                const factsLine = topFacts.length > 0
                    ? `Care priorities on file: ${topFacts.join("; ")}.`
                    : "";
                const memLine = memCtx ? memCtx.slice(0, 300) : "";
                const resp = await getClient().messages.create({
                    model: "claude-haiku-4-5-20251001",
                    max_tokens: 180,
                    system: "You write a brief morning text for a family member whose loved one has a caregiver visit today.\n" +
                        "Tone: warm, direct, practical — like a trusted care coordinator texting. No bullet points, no emoji.\n" +
                        "Format: 2-3 sentences max. Start with caregiver arrival info. Add one specific care note if available.\n" +
                        "Output only the message text.",
                    messages: [{
                            role: "user",
                            content: `Senior: ${seniorName}\n` +
                                `Caregiver: ${caregiverName} arriving ${schedule}\n` +
                                factsLine + "\n" +
                                memLine,
                        }],
                });
                content = ((_f = resp.content[0].text) !== null && _f !== void 0 ? _f : "").trim();
                if (!content)
                    throw new Error("empty");
            }
            catch (_g) {
                // Fallback template
                const noteLine = topFacts.length > 0
                    ? ` Keep in mind: ${topFacts[0].toLowerCase()}.`
                    : "";
                content = `Good morning! ${caregiverName} is scheduled to arrive ${schedule} for ${seniorName}.${noteLine}`;
            }
            await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
                content,
                urgency: "standard",
                sourceAgent: "family_morning_briefing",
                canDrop: true,
            });
            await db.collection("agent_alerts_log").add({
                type: "family_morning_briefing",
                clientId,
                phone,
                sentAt: today,
            });
        }
        catch (err) {
            console.error("[sendFamilyMorningBriefings] error for client", clientId, err);
        }
    }
}
//# sourceMappingURL=morningBriefing.js.map