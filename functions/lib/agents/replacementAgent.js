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
exports.contactReplacementCandidate = contactReplacementCandidate;
exports.handleNoReplacementsFound = handleNoReplacementsFound;
exports.runEmergencyReplacement = runEmergencyReplacement;
const admin = __importStar(require("firebase-admin"));
const client_1 = require("../linq/client");
const caraAgent_1 = require("./caraAgent");
const replacementScorer_1 = require("./replacementScorer");
const triggerEngine_1 = require("../triggers/triggerEngine");
const db = admin.firestore();
// ── Contact a replacement candidate via Linq ──────────────────────────────────
async function contactReplacementCandidate(caregiver, appt, taskId) {
    var _a, _b, _c, _d, _e, _f;
    if (!caregiver.phone)
        return;
    const earnings = (((_b = (_a = appt.hourlyRate) !== null && _a !== void 0 ? _a : caregiver.hourlyRate) !== null && _b !== void 0 ? _b : 22) * ((_c = appt.durationHours) !== null && _c !== void 0 ? _c : 4)).toFixed(2);
    // Fetch care notes so the substitute arrives informed
    let careNoteLines = "";
    if (appt.clientId) {
        try {
            const [carePlanSnap, lastJournalSnap] = await Promise.all([
                db.collection("care_plans").doc(appt.clientId).get(),
                db.collection("care_journal")
                    .where("seniorId", "==", appt.clientId)
                    .orderBy("timestamp", "desc")
                    .limit(1)
                    .get(),
            ]);
            const carePlan = carePlanSnap.data();
            const meds = (_d = carePlan === null || carePlan === void 0 ? void 0 : carePlan.medications) !== null && _d !== void 0 ? _d : [];
            const needs = (_e = carePlan === null || carePlan === void 0 ? void 0 : carePlan.careNeeds) !== null && _e !== void 0 ? _e : [];
            const lastNote = lastJournalSnap.empty
                ? null
                : (_f = lastJournalSnap.docs[0].data().notes) === null || _f === void 0 ? void 0 : _f.slice(0, 100);
            const noteLines = [];
            if (needs.length)
                noteLines.push(`Needs: ${needs.slice(0, 3).join(", ")}`);
            if (meds.length)
                noteLines.push(`Meds: ${meds.slice(0, 2).join(", ")}`);
            if (lastNote)
                noteLines.push(`Last visit: ${lastNote}`);
            if (noteLines.length)
                careNoteLines = `\n${noteLines.join("\n")}`;
        }
        catch ( /* non-critical */_g) { /* non-critical */ }
    }
    const seniorLine = appt.seniorName ? `Client: ${appt.seniorName}\n` : "";
    const msg = `Hi ${caregiver.name.split(" ")[0]} — urgent opening today.\n\n` +
        `${appt.date} at ${appt.time}\n` +
        (appt.address ? `${appt.address}\n` : "") +
        seniorLine +
        `~$${earnings} for the visit` +
        careNoteLines +
        `\n\nReply YES if you can take it, or NO to pass.`;
    await (0, client_1.sendToPhone)(caregiver.phone, msg).catch((err) => console.error(`contactReplacementCandidate failed for ${caregiver.phone}:`, err));
    await db.collection("replacement_candidates").add({
        taskId,
        caregiverId: caregiver.caregiverId,
        phone: caregiver.phone,
        status: "contacted",
        contactedAt: new Date().toISOString(),
    });
}
// ── No replacements found — alert admin + notify family ───────────────────────
async function handleNoReplacementsFound(appointmentId, clientId, phone, appt) {
    var _a, _b;
    const now = new Date().toISOString();
    await db.collection("admin_alerts").add({
        type: "no_replacement_found",
        appointmentId,
        clientId,
        phone,
        date: appt.date,
        time: appt.time,
        createdAt: now,
        resolved: false,
    });
    const msg = `${(_a = appt.caregiverName) !== null && _a !== void 0 ? _a : "Your caregiver"} had to cancel and I wasn't able to find a replacement right now. ` +
        `I've flagged this for our team and I'm searching for new options — someone will follow up within the hour.`;
    await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
        content: msg,
        urgency: "immediate",
        sourceAgent: "emergency_replacement",
        canDrop: false,
    }).catch(() => (0, client_1.sendToPhone)(phone, msg));
    // Kick off a fresh broad matching pass as a fallback
    const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
    if (sessionSnap.exists) {
        const session = sessionSnap.data();
        const { runMatchingForClient } = await Promise.resolve().then(() => __importStar(require("./matchingAgent")));
        runMatchingForClient(phone, (_b = session.chatId) !== null && _b !== void 0 ? _b : "", session, session).catch(err => console.error("[handleNoReplacementsFound] fallback re-match failed:", err));
    }
}
// ── Full emergency replacement flow ──────────────────────────────────────────
async function runEmergencyReplacement(params) {
    var _a, _b, _c, _d;
    const { appointmentId, clientId, clientPhone, appt } = params;
    const now = new Date().toISOString();
    // Mark replacement as in-progress so Cara can tell the family what's happening
    await db.collection("agent_tasks_active").doc(clientPhone).set({
        type: "emergency_replacement",
        status: "searching",
        startedAt: now,
        description: `Searching for a replacement for ${(_a = appt.caregiverName) !== null && _a !== void 0 ? _a : "your caregiver"}'s cancelled ${(_b = appt.time) !== null && _b !== void 0 ? _b : ""} visit`,
    }).catch(() => { });
    const options = await (0, replacementScorer_1.scoreReplacements)({
        clientId,
        appointmentId,
        date: appt.date,
        time: appt.time,
        excludeId: (_c = appt.caregiverId) !== null && _c !== void 0 ? _c : "",
    });
    if (options.length === 0) {
        await db.collection("agent_tasks_active").doc(clientPhone).delete().catch(() => { });
        await handleNoReplacementsFound(appointmentId, clientId, clientPhone, appt);
        return;
    }
    const confirmToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const taskRef = await db.collection("agent_tasks").add({
        type: "replacement_confirmation",
        appointmentId,
        clientId,
        clientPhone,
        options,
        confirmToken,
        status: "awaiting_approval",
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        createdAt: now,
    });
    const numberEmojis = ["1️⃣", "2️⃣", "3️⃣"];
    const optionLines = options
        .slice(0, 3)
        .map((o, i) => {
        const rebookedNote = o.previouslyBooked ? " · booked before" : "";
        return `${numberEmojis[i]} ${o.name} · ${o.rating}⭐ · $${o.hourlyRate}/hr${rebookedNote}`;
    })
        .join("\n");
    const cancelMsg = `${(_d = appt.caregiverName) !== null && _d !== void 0 ? _d : "Your caregiver"} had to cancel the ${appt.time} visit.\n\n` +
        `I found ${options.length} available caregiver${options.length > 1 ? "s" : ""}:\n\n` +
        `${optionLines}\n\n` +
        `Reply 1, 2, or 3. Nothing is booked until you confirm.`;
    await (0, caraAgent_1.sendViaInteractionAgent)(clientPhone, {
        content: cancelMsg,
        urgency: "immediate",
        sourceAgent: "emergency_replacement",
        canDrop: false,
    }).catch(() => (0, client_1.sendToPhone)(clientPhone, cancelMsg));
    // Update active task status — waiting for family to pick
    await db.collection("agent_tasks_active").doc(clientPhone).set({
        type: "emergency_replacement",
        status: "awaiting_family_choice",
        taskId: taskRef.id,
        startedAt: now,
        description: `${options.length} replacement option${options.length > 1 ? "s" : ""} found — waiting for your reply`,
    }).catch(() => { });
    // Contact all candidates in parallel
    const caregiverSnaps = await Promise.all(options.slice(0, 3).map((o) => db.collection("caregivers").doc(o.caregiverId).get()));
    await Promise.all(options.slice(0, 3).map((o, i) => {
        var _a, _b;
        const phone = (_a = caregiverSnaps[i].data()) === null || _a === void 0 ? void 0 : _a.phone;
        return contactReplacementCandidate(Object.assign(Object.assign({}, o), { phone }), {
            date: appt.date, time: appt.time, address: appt.address,
            durationHours: appt.durationHours, hourlyRate: appt.hourlyRate,
            clientId, seniorName: (_b = appt.clientName) !== null && _b !== void 0 ? _b : appt.seniorName,
        }, taskRef.id);
    }));
    // Schedule 30-min escalation in case no one responds
    await (0, triggerEngine_1.scheduleTrigger)({
        userId: clientId,
        phone: clientPhone,
        type: "custom",
        message: `replacement_task:${taskRef.id}`,
        scheduledAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }).catch((err) => console.error("scheduleTrigger (replacement escalation) error:", err));
    await db.collection("agent_alerts_log").add({
        type: "emergency_replacement_started",
        clientId,
        phone: clientPhone,
        appointmentId,
        taskId: taskRef.id,
        sentAt: now,
    });
}
//# sourceMappingURL=replacementAgent.js.map