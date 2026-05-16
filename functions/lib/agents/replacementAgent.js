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
var _a;
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
const SUPPORT_PHONE = (_a = process.env.SUPPORT_PHONE) !== null && _a !== void 0 ? _a : "1-800-555-0199";
// ── Contact a replacement candidate via Linq ──────────────────────────────────
async function contactReplacementCandidate(caregiver, appt, taskId) {
    var _a, _b, _c;
    if (!caregiver.phone)
        return;
    const earnings = (((_b = (_a = appt.hourlyRate) !== null && _a !== void 0 ? _a : caregiver.hourlyRate) !== null && _b !== void 0 ? _b : 22) * ((_c = appt.durationHours) !== null && _c !== void 0 ? _c : 4)).toFixed(2);
    const msg = `Hi ${caregiver.name.split(" ")[0]} — urgent opening today.\n\n` +
        `${appt.date} at ${appt.time}\n` +
        (appt.address ? `${appt.address}\n` : "") +
        `~$${earnings} for the visit\n\n` +
        `Reply YES if you can take it, or NO to pass.`;
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
    var _a;
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
    const msg = `${(_a = appt.caregiverName) !== null && _a !== void 0 ? _a : "Your caregiver"} had to cancel and I wasn't able to find a replacement in time. ` +
        `Please call our support team at ${SUPPORT_PHONE} or open the app to reschedule.`;
    await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
        content: msg,
        urgency: "immediate",
        sourceAgent: "emergency_replacement",
        canDrop: false,
    }).catch(() => (0, client_1.sendToPhone)(phone, msg));
}
// ── Full emergency replacement flow ──────────────────────────────────────────
async function runEmergencyReplacement(params) {
    var _a, _b;
    const { appointmentId, clientId, clientPhone, appt } = params;
    const now = new Date().toISOString();
    const options = await (0, replacementScorer_1.scoreReplacements)({
        clientId,
        appointmentId,
        date: appt.date,
        time: appt.time,
        excludeId: (_a = appt.caregiverId) !== null && _a !== void 0 ? _a : "",
    });
    if (options.length === 0) {
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
    const cancelMsg = `${(_b = appt.caregiverName) !== null && _b !== void 0 ? _b : "Your caregiver"} had to cancel the ${appt.time} visit.\n\n` +
        `I found ${options.length} available caregiver${options.length > 1 ? "s" : ""}:\n\n` +
        `${optionLines}\n\n` +
        `Reply 1, 2, or 3. Nothing is booked until you confirm.`;
    await (0, caraAgent_1.sendViaInteractionAgent)(clientPhone, {
        content: cancelMsg,
        urgency: "immediate",
        sourceAgent: "emergency_replacement",
        canDrop: false,
    }).catch(() => (0, client_1.sendToPhone)(clientPhone, cancelMsg));
    // Contact all candidates in parallel
    const caregiverSnaps = await Promise.all(options.slice(0, 3).map((o) => db.collection("caregivers").doc(o.caregiverId).get()));
    await Promise.all(options.slice(0, 3).map((o, i) => {
        var _a;
        const phone = (_a = caregiverSnaps[i].data()) === null || _a === void 0 ? void 0 : _a.phone;
        return contactReplacementCandidate(Object.assign(Object.assign({}, o), { phone }), { date: appt.date, time: appt.time, address: appt.address, durationHours: appt.durationHours }, taskRef.id);
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