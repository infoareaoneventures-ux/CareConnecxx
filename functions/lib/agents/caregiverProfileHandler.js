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
exports.handleCaregiverProfileUpdate = handleCaregiverProfileUpdate;
exports.profileFieldFromIntent = profileFieldFromIntent;
const admin = __importStar(require("firebase-admin"));
const client_1 = require("../linq/client");
const parseWithClaude_1 = require("../utils/parseWithClaude");
const openaiClient_1 = require("../utils/openaiClient");
const caraMessage_1 = require("../utils/caraMessage");
const tokenService_1 = require("./tokenService");
const db = admin.firestore();
const APP_URL = (_a = process.env.APP_URL) !== null && _a !== void 0 ? _a : "https://cara.com";
async function isQuestionOrOther(text, currentQuestion) {
    const result = await (0, parseWithClaude_1.parseWithClaude)(`The caregiver is updating their profile. Current step's question: "${currentQuestion}". ` +
        "Reply YES if their message is a general question or off-topic comment unrelated to that question. " +
        "Reply NO if it is a direct answer. Only reply YES or NO.", text, 5);
    return result.toUpperCase().startsWith("Y");
}
async function answerMidFlow(text, reAsk) {
    const answer = await (0, openaiClient_1.quickComplete)("You are Cara, an AI care assistant helping a caregiver update their profile. " +
        "Answer their question briefly (1-2 sentences). Do NOT ask them to continue — that prompt comes next.", text, { maxTokens: 150 }).catch(() => "Let me get back to you on that. In the meantime —");
    return `${answer}\n\n${reAsk}`;
}
const KNOWN_SPECIALTIES = [
    "dementia", "alzheimer's", "mobility", "post-surgery", "companionship",
    "medication management", "hospice", "diabetes care", "wound care",
    "transportation", "meal prep", "personal care", "bathing", "transfers",
    "respite care", "parkinson's", "stroke recovery", "cognitive support",
];
async function clearProfileFlow(phone) {
    await db.collection("agent_sessions").doc(phone).update({
        profileUpdateStep: admin.firestore.FieldValue.delete(),
        profileUpdateField: admin.firestore.FieldValue.delete(),
        profileUpdateValue: admin.firestore.FieldValue.delete(),
        stateExpiresAt: admin.firestore.FieldValue.delete(),
    }).catch(() => { });
}
/**
 * Entry point — call when a profile-update intent (or active profileUpdateStep) is detected.
 * Routes to the correct sub-handler based on `field`.
 *
 * For pure-entry intents that may include the value inline (e.g. "change my rate to $28"),
 * pass `field` from intent classification. Otherwise the existing session.profileUpdateField is used.
 */
async function handleCaregiverProfileUpdate(caregiverId, caregiverPhone, text, session, chatId, field) {
    const activeField = (field !== null && field !== void 0 ? field : session.profileUpdateField);
    if (!activeField) {
        await (0, client_1.sendMessage)(chatId, "I'm not sure what you wanted to update. Try something like \"change my rate to $25\" or \"add dementia care to my skills\".");
        return;
    }
    // ── Inbound MMS media detection (photo path uses this) ─────────────────────
    // The webhooks router passes `text` as the joined text, so MMS-only messages
    // come through as "". The photo handler relies on session.pendingPhotoUrl
    // (set by the router when it sees a media part) — see webhooks.ts wiring.
    switch (activeField) {
        case "rate": return handleRateUpdate(caregiverId, caregiverPhone, text, session, chatId);
        case "skills": return handleSkillsUpdate(caregiverId, caregiverPhone, text, session, chatId);
        case "bio": return handleBioUpdate(caregiverId, caregiverPhone, text, session, chatId);
        case "photo": return handlePhotoUpdate(caregiverId, caregiverPhone, text, session, chatId);
        case "pause": return handlePauseAccount(caregiverId, caregiverPhone, text, session, chatId);
        case "reactivate": return handleReactivate(caregiverId, caregiverPhone, session, chatId);
    }
}
// ── RATE ────────────────────────────────────────────────────────────────────
async function handleRateUpdate(caregiverId, phone, text, session, chatId) {
    var _a, _b;
    const step = (_a = session.profileUpdateStep) !== null && _a !== void 0 ? _a : "collect";
    if (step === "collect") {
        const reAsk = "What hourly rate would you like? (e.g. \"$25\" — must be between $15 and $150)";
        if (await isQuestionOrOther(text, reAsk)) {
            await (0, client_1.sendMessage)(chatId, await answerMidFlow(text, reAsk));
            return;
        }
        const raw = await (0, parseWithClaude_1.parseWithClaude)("Extract the requested hourly rate as a number (no $ sign). " +
            "If the caregiver hasn't yet mentioned a rate, reply: __none__. " +
            "Reply with just the number, e.g. 25.", text, 10);
        const rate = parseFloat(raw);
        if (raw === "__none__" || isNaN(rate)) {
            await db.collection("agent_sessions").doc(phone).update({
                profileUpdateStep: "collect",
                profileUpdateField: "rate",
                stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            });
            await (0, client_1.sendMessage)(chatId, reAsk);
            return;
        }
        if (rate < 15 || rate > 150) {
            await (0, client_1.sendMessage)(chatId, `Hourly rate must be between $15 and $150 — you said $${rate}. What rate would you like?`);
            return;
        }
        await db.collection("agent_sessions").doc(phone).update({
            profileUpdateStep: "confirm",
            profileUpdateField: "rate",
            profileUpdateValue: String(rate),
            stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        });
        await (0, client_1.sendMessage)(chatId, `Set your hourly rate to $${rate}/hr? Reply YES to save, or NO to cancel.`);
        return;
    }
    // confirm
    const proposedRate = parseFloat((_b = session.profileUpdateValue) !== null && _b !== void 0 ? _b : "0");
    const reAskConfirm = `Set your hourly rate to $${proposedRate}/hr? Reply YES to save, or NO to cancel.`;
    if (await isQuestionOrOther(text, reAskConfirm)) {
        await (0, client_1.sendMessage)(chatId, await answerMidFlow(text, reAskConfirm));
        return;
    }
    const decision = await (0, parseWithClaude_1.parseWithClaude)('"yes", "save", "confirm", "do it" → YES. "no", "cancel", "wait", "never mind" → NO. Reply exactly YES or NO.', text, 5);
    await clearProfileFlow(phone);
    if (decision === "YES" && proposedRate > 0) {
        await db.collection("caregivers").doc(caregiverId).update({
            hourlyRate: proposedRate,
            rateUpdatedAt: new Date().toISOString(),
        });
        await (0, client_1.sendMessage)(chatId, `Done — your hourly rate is now $${proposedRate}/hr.`);
    }
    else {
        await (0, client_1.sendMessage)(chatId, "No problem — your rate wasn't changed.");
    }
}
// ── SKILLS ──────────────────────────────────────────────────────────────────
async function handleSkillsUpdate(caregiverId, phone, text, session, chatId) {
    var _a, _b, _c;
    const step = (_a = session.profileUpdateStep) !== null && _a !== void 0 ? _a : "collect";
    if (step === "collect") {
        const reAsk = "Which specialties would you like to add or remove? " +
            "(e.g. \"add dementia and hospice\", or \"remove mobility\")";
        if (await isQuestionOrOther(text, reAsk)) {
            await (0, client_1.sendMessage)(chatId, await answerMidFlow(text, reAsk));
            return;
        }
        const raw = await (0, parseWithClaude_1.parseWithClaude)("Parse the caregiver's skill-update request. Reply JSON: " +
            '{"action":"add"|"remove"|"replace","skills":["skill1","skill2"]}. ' +
            "Skills should be lowercase short phrases. " +
            "If the caregiver hasn't said yet, reply: __none__.", text, 150);
        if (raw === "__none__" || raw === "__parse_error__") {
            await db.collection("agent_sessions").doc(phone).update({
                profileUpdateStep: "collect",
                profileUpdateField: "skills",
                stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            });
            await (0, client_1.sendMessage)(chatId, reAsk);
            return;
        }
        let action = "add";
        let skills = [];
        try {
            const parsed = JSON.parse(raw);
            action = ["add", "remove", "replace"].includes(parsed.action) ? parsed.action : "add";
            skills = Array.isArray(parsed.skills) ? parsed.skills.map((s) => String(s).toLowerCase().trim()).filter(Boolean) : [];
        }
        catch ( /* fall through */_d) { /* fall through */ }
        if (skills.length === 0) {
            await (0, client_1.sendMessage)(chatId, "I didn't catch any specific skills in that. Try \"add dementia care\" or \"remove mobility\".");
            return;
        }
        // Show proposed change against current
        const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
        const current = ((_c = (_b = cgSnap.data()) === null || _b === void 0 ? void 0 : _b.specialties) !== null && _c !== void 0 ? _c : []);
        const currentNorm = current.map(s => s.toLowerCase());
        let proposed = [];
        if (action === "add") {
            proposed = [...new Set([...currentNorm, ...skills])];
        }
        else if (action === "remove") {
            proposed = currentNorm.filter(s => !skills.includes(s));
        }
        else {
            proposed = skills;
        }
        await db.collection("agent_sessions").doc(phone).update({
            profileUpdateStep: "confirm",
            profileUpdateField: "skills",
            profileUpdateValue: JSON.stringify(proposed),
            stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        });
        await (0, client_1.sendMessage)(chatId, `Updated skills will be: ${proposed.length ? proposed.join(", ") : "(none)"}\n\n` +
            `Save? Reply YES or NO.`);
        return;
    }
    // confirm
    const proposed = (() => {
        var _a;
        try {
            return JSON.parse((_a = session.profileUpdateValue) !== null && _a !== void 0 ? _a : "[]");
        }
        catch (_b) {
            return [];
        }
    })();
    const reAskConfirm = `Save these skills: ${proposed.join(", ") || "(none)"}? Reply YES or NO.`;
    if (await isQuestionOrOther(text, reAskConfirm)) {
        await (0, client_1.sendMessage)(chatId, await answerMidFlow(text, reAskConfirm));
        return;
    }
    const decision = await (0, parseWithClaude_1.parseWithClaude)('"yes", "save", "confirm" → YES. "no", "cancel", "wait" → NO. Reply exactly YES or NO.', text, 5);
    await clearProfileFlow(phone);
    if (decision === "YES") {
        await db.collection("caregivers").doc(caregiverId).update({
            specialties: proposed,
            skillsUpdatedAt: new Date().toISOString(),
        });
        await (0, client_1.sendMessage)(chatId, `Done — your specialties are updated.`);
    }
    else {
        await (0, client_1.sendMessage)(chatId, "No problem — your skills weren't changed.");
    }
    void KNOWN_SPECIALTIES;
}
// ── BIO ─────────────────────────────────────────────────────────────────────
async function handleBioUpdate(caregiverId, phone, text, session, chatId) {
    var _a, _b;
    const step = (_a = session.profileUpdateStep) !== null && _a !== void 0 ? _a : "collect";
    if (step === "collect") {
        const reAsk = "What would you like your new bio to say? (Up to ~300 characters — this is what families see on your profile.)";
        if (await isQuestionOrOther(text, reAsk)) {
            await (0, client_1.sendMessage)(chatId, await answerMidFlow(text, reAsk));
            return;
        }
        const trimmed = text.trim();
        if (trimmed.length < 15) {
            await db.collection("agent_sessions").doc(phone).update({
                profileUpdateStep: "collect",
                profileUpdateField: "bio",
                stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            });
            await (0, client_1.sendMessage)(chatId, reAsk);
            return;
        }
        const bio = trimmed.slice(0, 300);
        await db.collection("agent_sessions").doc(phone).update({
            profileUpdateStep: "confirm",
            profileUpdateField: "bio",
            profileUpdateValue: bio,
            stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        });
        await (0, client_1.sendMessage)(chatId, `Here's your new bio:\n\n"${bio}"\n\nSave? Reply YES or NO.`);
        return;
    }
    // confirm
    const proposedBio = (_b = session.profileUpdateValue) !== null && _b !== void 0 ? _b : "";
    const reAskConfirm = `Save this bio?\n\n"${proposedBio}"\n\nReply YES or NO.`;
    if (await isQuestionOrOther(text, reAskConfirm)) {
        await (0, client_1.sendMessage)(chatId, await answerMidFlow(text, reAskConfirm));
        return;
    }
    const decision = await (0, parseWithClaude_1.parseWithClaude)('"yes", "save", "confirm" → YES. "no", "cancel", "wait" → NO. Reply exactly YES or NO.', text, 5);
    await clearProfileFlow(phone);
    if (decision === "YES" && proposedBio) {
        await db.collection("caregivers").doc(caregiverId).update({
            bio: proposedBio,
            bioUpdatedAt: new Date().toISOString(),
        });
        await (0, client_1.sendMessage)(chatId, "Done — your bio is updated.");
    }
    else {
        await (0, client_1.sendMessage)(chatId, "No problem — your bio wasn't changed.");
    }
}
// ── PHOTO ───────────────────────────────────────────────────────────────────
// Uses a web upload link (auto-returns to SMS on completion per the web→SMS
// handoff rule). MMS attachments aren't reliably available on all carriers
// and the existing onboarding photo flow already uses this pattern.
async function handlePhotoUpdate(_caregiverId, phone, _text, _session, chatId) {
    const token = (0, tokenService_1.generateToken)({ phone, task: "photo_upload" });
    const photoUrl = `${APP_URL}/upload/photo?t=${token}&return=sms`;
    await clearProfileFlow(phone);
    await (0, client_1.sendMessage)(chatId, "Tap to upload a new profile photo — it'll bring you right back here when you're done:");
    await (0, client_1.sendMessage)(chatId, { parts: [{ type: "link", url: photoUrl, value: "📷 Upload New Photo →" }] });
}
// ── PAUSE ACCOUNT ──────────────────────────────────────────────────────────
async function handlePauseAccount(caregiverId, phone, text, session, chatId) {
    var _a, _b;
    const step = (_a = session.profileUpdateStep) !== null && _a !== void 0 ? _a : "collect";
    if (step === "collect") {
        const reAsk = "When would you like to pause until? (e.g. \"until July 12\", \"for two weeks\", \"indefinitely\")";
        if (await isQuestionOrOther(text, reAsk)) {
            await (0, client_1.sendMessage)(chatId, await answerMidFlow(text, reAsk));
            return;
        }
        const todayIso = new Date().toISOString().slice(0, 10);
        const raw = await (0, parseWithClaude_1.parseWithClaude)(`Parse the caregiver's pause-until date. Today is ${todayIso}. Reply JSON: ` +
            '{"until":"YYYY-MM-DD"} for a specific end date, or {"until":"indefinite"} for an open-ended pause. ' +
            'If you cannot extract any date or duration, reply: __none__.', text, 40);
        if (raw === "__none__" || raw === "__parse_error__") {
            await db.collection("agent_sessions").doc(phone).update({
                profileUpdateStep: "collect",
                profileUpdateField: "pause",
                stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            });
            await (0, client_1.sendMessage)(chatId, reAsk);
            return;
        }
        let until = "indefinite";
        try {
            const parsed = JSON.parse(raw);
            if (typeof parsed.until === "string")
                until = parsed.until;
        }
        catch ( /* keep default */_c) { /* keep default */ }
        await db.collection("agent_sessions").doc(phone).update({
            profileUpdateStep: "confirm",
            profileUpdateField: "pause",
            profileUpdateValue: until,
            stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        });
        const untilLabel = until === "indefinite" ? "indefinitely" : `until ${until}`;
        await (0, client_1.sendMessage)(chatId, `Pause your account ${untilLabel}? You won't receive job matches during this time. ` +
            `Reply YES to pause, or NO to cancel.`);
        return;
    }
    // confirm
    const until = (_b = session.profileUpdateValue) !== null && _b !== void 0 ? _b : "indefinite";
    const untilLabel = until === "indefinite" ? "indefinitely" : `until ${until}`;
    const reAskConfirm = `Pause your account ${untilLabel}? Reply YES or NO.`;
    if (await isQuestionOrOther(text, reAskConfirm)) {
        await (0, client_1.sendMessage)(chatId, await answerMidFlow(text, reAskConfirm));
        return;
    }
    const decision = await (0, parseWithClaude_1.parseWithClaude)('"yes", "pause", "confirm", "do it" → YES. "no", "cancel", "wait" → NO. Reply exactly YES or NO.', text, 5);
    await clearProfileFlow(phone);
    if (decision === "YES") {
        const pausedUntil = until === "indefinite"
            ? "2099-12-31"
            : until;
        await db.collection("caregivers").doc(caregiverId).update({
            pausedUntil: pausedUntil,
            pausedAt: new Date().toISOString(),
        });
        const backWhen = until === "indefinite" ? "Text REACTIVATE whenever you're ready to come back." : `You'll be reactivated on ${until}. Text REACTIVATE sooner if your plans change.`;
        await (0, client_1.sendMessage)(chatId, `Done — your account is paused. ${backWhen}`);
    }
    else {
        await (0, client_1.sendMessage)(chatId, "No problem — your account is still active.");
    }
}
// ── REACTIVATE ─────────────────────────────────────────────────────────────
async function handleReactivate(caregiverId, phone, _session, chatId) {
    await db.collection("caregivers").doc(caregiverId).update({
        pausedUntil: admin.firestore.FieldValue.delete(),
        reactivatedAt: new Date().toISOString(),
    });
    await clearProfileFlow(phone);
    const msg = await (0, caraMessage_1.generateCaraMessage)({
        audience: "caregiver",
        context: "A caregiver just reactivated their account after being paused. Welcome them back warmly in one short sentence.",
        fallback: "Welcome back — you're set to receive job matches again.",
        maxTokens: 60,
    });
    await (0, client_1.sendMessage)(chatId, msg);
}
/**
 * Helper: detect which profile-update field an inbound intent corresponds to.
 * Returns undefined if the intent isn't a profile-update intent.
 */
function profileFieldFromIntent(intent) {
    switch (intent) {
        case "UPDATE_RATE": return "rate";
        case "UPDATE_SKILLS": return "skills";
        case "UPDATE_BIO": return "bio";
        case "UPDATE_PHOTO": return "photo";
        case "PAUSE_ACCOUNT": return "pause";
        case "REACTIVATE": return "reactivate";
        default: return undefined;
    }
}
//# sourceMappingURL=caregiverProfileHandler.js.map