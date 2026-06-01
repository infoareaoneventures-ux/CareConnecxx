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
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleOnboardingStep = handleOnboardingStep;
exports.sendBgCheckRenewalLink = sendBgCheckRenewalLink;
exports.sendOnboardingLink = sendOnboardingLink;
exports.resendStuckStep = resendStuckStep;
exports.advanceOnboardingStep = advanceOnboardingStep;
const admin = __importStar(require("firebase-admin"));
const openaiClient_1 = require("../utils/openaiClient");
const jsonUtils_1 = require("../utils/jsonUtils");
const axios_1 = __importDefault(require("axios"));
const stripe_1 = __importDefault(require("stripe"));
const client_1 = require("../linq/client");
const emotionalContext_1 = require("./emotionalContext");
const tokenService_1 = require("./tokenService");
const notifications_1 = require("../notifications");
const memoryFiles_1 = require("../memory/memoryFiles");
const zepClient_1 = require("../memory/zepClient");
const buildJobPost_1 = require("./buildJobPost");
const caraMessage_1 = require("../utils/caraMessage");
const phoneVerification_1 = require("../utils/phoneVerification");
const language_1 = require("../utils/language");
const db = admin.firestore();
let _stripe = null;
function getStripe() {
    var _a;
    if (!_stripe)
        _stripe = new stripe_1.default((_a = process.env.STRIPE_SECRET_KEY) !== null && _a !== void 0 ? _a : "", { apiVersion: "2023-10-16" });
    return _stripe;
}
const APP_URL = (_a = process.env.APP_URL) !== null && _a !== void 0 ? _a : "https://cara.com";
// ── Helpers ───────────────────────────────────────────────────────────────────
async function updateSession(phone, updates) {
    await db.collection("agent_sessions").doc(phone).update(updates);
}
async function mergeOnboardingData(phone, data) {
    var _a, _b;
    const snap = await db.collection("agent_sessions").doc(phone).get();
    const existing = ((_b = (_a = snap.data()) === null || _a === void 0 ? void 0 : _a.onboardingData) !== null && _b !== void 0 ? _b : {});
    await db.collection("agent_sessions").doc(phone).update({
        onboardingData: Object.assign(Object.assign({}, existing), data),
    });
}
// Local single-shot parser used by onboarding step handlers. Powered by
// gpt-4o-mini under the hood for speed and lower rate-limit pressure.
// Strips markdown code fences from the response so JSON.parse callers don't
// fail when the model wraps the answer in ```json … ```.
async function parseWithClaude(prompt, userText) {
    try {
        const raw = await (0, openaiClient_1.quickComplete)(prompt, userText, { maxTokens: 200 });
        // Strip fences only — leaves plain-text answers untouched but cleans
        // up wrapped JSON. Callers that JSON.parse() the return value get a
        // clean string.
        return raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    }
    catch (_a) {
        return "__parse_error__";
    }
}
// Use unwrapJson where a JSON-shaped answer is needed and prose may sneak in
void jsonUtils_1.unwrapJson;
async function isQuestionOrOther(text) {
    const result = await parseWithClaude('Reply YES if this is a general question or off-topic comment. Reply NO if it is an answer to the question asked. Only reply YES or NO.', text);
    return result.toUpperCase().startsWith("Y");
}
// ── Mid-flow role-switch detector ────────────────────────────────────────────
// Catches the case where someone realized halfway through onboarding that they
// picked the wrong role ("wait, I'm actually a caregiver", "no I'm looking for
// care for my mom"). Returns the role they want to switch TO, or null.
async function detectRoleSwitch(text, currentRole) {
    if (!currentRole)
        return null;
    if (text.trim().length < 6)
        return null; // too short to be a switch
    const raw = await parseWithClaude(`The user is mid-onboarding as a ${currentRole}. Reply with JSON: ` +
        "{\"switchTo\": \"client\" | \"caregiver\" | \"none\"}. " +
        "Use \"client\" if they are clearly saying they need care for a loved one (not their own job). " +
        "Use \"caregiver\" if they are clearly saying they are a caregiver looking for work. " +
        `Use \"none\" if their message is just answering the current question or is ambiguous. ` +
        "Only flag clear role-switch intent; do NOT flag a client mentioning they have a caregiver background, " +
        "or a caregiver mentioning their own elderly parent in passing.", text);
    if (raw === "__parse_error__" || !raw.startsWith("{"))
        return null;
    try {
        const parsed = JSON.parse(raw);
        if (parsed.switchTo === "client" && currentRole !== "client")
            return "client";
        if (parsed.switchTo === "caregiver" && currentRole !== "caregiver")
            return "caregiver";
        return null;
    }
    catch (_a) {
        return null;
    }
}
// ── Mid-flow correction detector ─────────────────────────────────────────────
async function detectCorrection(text) {
    const raw = await parseWithClaude("The user is in a conversational onboarding flow. Detect if they are correcting previously " +
        "given information (e.g. 'actually my name is X', 'wait, I meant Y', 'sorry, it's Z'). " +
        "If yes, reply with JSON: {\"field\": \"<fieldName>\", \"value\": \"<newValue>\"}. " +
        "Valid fields: firstName, seniorName, city, zipCode, hourlyRate, yearsExperience, email. " +
        "If this is NOT a correction, reply with the literal word: null", text);
    if (raw === "__parse_error__" || raw === "null" || !raw.startsWith("{"))
        return null;
    try {
        return JSON.parse(raw);
    }
    catch (_a) {
        return null;
    }
}
// ── Silent Firebase Auth account creation ────────────────────────────────────
async function createFirebaseAuthAccount(phone, displayName) {
    try {
        await admin.auth().createUser({ phoneNumber: phone, displayName });
    }
    catch (err) {
        if (err.code !== "auth/phone-number-already-exists")
            throw err;
    }
}
// ── Main dispatcher ───────────────────────────────────────────────────────────
// Ordered step flow for client onboarding — used by the auto-skip logic so
// any step whose target field is already in onboardingData is silently
// advanced past instead of re-asking the user. Stops at client_ask_schedule
// because what follows is identity verification + plan selection — those have
// side effects (Stripe identity session, plan display) that can't be skipped
// based on cached fields. Caregiver flow has document uploads + payment
// redirects that can't be skipped, so we don't auto-skip caregiver steps either.
const CLIENT_STEP_ORDER = [
    "client_ask_name",
    "client_ask_senior",
    "client_ask_needs",
    "client_ask_location",
    "client_ask_schedule",
];
// Maps a client step to the onboardingData field(s) it collects. If the
// field is already present and non-empty, the step is skipped.
const CLIENT_STEP_FIELD = {
    client_ask_name: "firstName",
    client_ask_senior: "seniorName",
    client_ask_needs: "age",
    client_ask_location: "city",
    client_ask_schedule: "schedule",
};
function isFieldFilled(value) {
    if (value === undefined || value === null)
        return false;
    if (typeof value === "string")
        return value.trim().length > 0;
    if (typeof value === "number")
        return value > 0;
    if (Array.isArray(value))
        return value.length > 0;
    if (typeof value === "object")
        return Object.keys(value).length > 0;
    return true;
}
/**
 * Scan an inbound message for ANY client onboarding fields and return only
 * the ones not already saved. Lets a family say "Mom Dorothy, 82, dementia,
 * 3 mornings/week in Atlanta 30301" once and have all fields captured in
 * a single turn — instead of being asked five questions.
 *
 * Conservative: returns `{}` on parse error so the regular step handlers
 * still run and ask explicitly.
 */
async function absorbClientFields(text, existing) {
    const raw = await parseWithClaude("You are extracting onboarding details from one message a family sent to Cara. " +
        "Return JSON only with the fields you can confidently extract. Omit fields not present. " +
        "Schema: " +
        `{"firstName":"family member first name (the person texting, not the senior)",` +
        `"seniorName":"senior's first name",` +
        `"relationship":"family relationship to senior (mother, father, etc.)",` +
        `"age":number,` +
        `"careNeeds":["short need phrase"],` +
        `"conditions":["short condition phrase"],` +
        `"city":"city name",` +
        `"zip":"5-digit US zip code",` +
        `"schedule":"plain-English schedule like '3 mornings a week'"}. ` +
        "Be conservative — only include a field if it is unambiguously stated. Reply with raw JSON, no markdown.", text).catch(() => "{}");
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (_a) {
        return {};
    }
    // Only return fields that are actually new
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
        if (!isFieldFilled(v))
            continue;
        if (isFieldFilled(existing[k]))
            continue;
        out[k] = v;
    }
    return out;
}
async function handleOnboardingStep(phone, chatId, text, session) {
    var _a, _b, _c, _d, _e;
    let step = (_a = session.onboardingStep) !== null && _a !== void 0 ? _a : "";
    const norm = text.trim().toUpperCase();
    // Global: "start over" resets
    if (norm === "START OVER" || norm === "RESTART") {
        await updateSession(phone, { onboardingStep: "ask_role", onboardingData: {} });
        await (0, client_1.sendMessage)(chatId, "No problem — let's start fresh.\n\n" +
            "Are you looking for care for a loved one, or are you a caregiver?\n\n" +
            "1️⃣  I need care for someone\n" +
            "2️⃣  I'm a caregiver looking for work");
        return;
    }
    // ── Emotional context (both flows) ──────────────────────────────────────────
    // Onboarding is where families first say the hard things ("Mom has Alzheimer's
    // and I'm scared"). Classify the posture once per turn, blend with any 12h-TTL
    // stored posture (reuses the same engine + session field as the QA agent), and
    // stash the directive on the session so step handlers can reflect the feeling
    // before logistics. Skipped for the OTP step and the RESUME sentinel — no
    // emotional content there, and it saves a model call.
    if (step !== "verify_phone" && text !== "__RESUME__") {
        const current = await (0, emotionalContext_1.classifyEmotionalContext)(text).catch(() => "calm");
        const stored = session.emotionalContext;
        const blended = (0, emotionalContext_1.blendEmotionalContext)(stored, current);
        if (blended.persist) {
            await updateSession(phone, { emotionalContext: blended.persist }).catch(() => { });
        }
        session._emotionalDirective =
            (0, emotionalContext_1.buildEmotionalContextDirective)(blended.value, (0, emotionalContext_1.classifyEmotionalTopic)(text));
    }
    // ── Multi-field absorption (client flow only) ───────────────────────────────
    // For any client step, scan the user's message for ALL fields present, save
    // them, and auto-skip any subsequent steps whose target field is already
    // collected. Lets users front-load their answers without being re-asked.
    // Skipped fields are filled in onboardingData; the dispatcher lands on the
    // first still-unfilled step.
    const isClientStep = step === "ask_role" || step.startsWith("client_ask_");
    if (isClientStep && step !== "ask_role" && session.userType !== "caregiver") {
        const existing = ((_b = session.onboardingData) !== null && _b !== void 0 ? _b : {});
        const absorbed = await absorbClientFields(text, existing).catch(() => ({}));
        if (Object.keys(absorbed).length > 0) {
            await mergeOnboardingData(phone, absorbed);
            session.onboardingData = Object.assign(Object.assign({}, existing), absorbed);
        }
        // Auto-advance past any client step whose target field is now filled.
        while (CLIENT_STEP_FIELD[step]) {
            const field = CLIENT_STEP_FIELD[step];
            const value = (_c = session.onboardingData) === null || _c === void 0 ? void 0 : _c[field];
            if (!isFieldFilled(value))
                break;
            const idx = CLIENT_STEP_ORDER.indexOf(step);
            const nextStep = idx >= 0 && idx < CLIENT_STEP_ORDER.length - 1
                ? CLIENT_STEP_ORDER[idx + 1]
                : null;
            if (!nextStep)
                break;
            step = nextStep;
        }
        if (step !== session.onboardingStep) {
            await updateSession(phone, { onboardingStep: step });
            session.onboardingStep = step;
        }
    }
    // Mid-flow role switch: "wait I'm actually a caregiver" / "no I need care, not a job".
    // Previously the only escape hatch was START OVER which wiped all progress.
    // Now: detect the intent, confirm before flipping role, and reset onboardingData
    // (different role = different fields, so previous answers don't transfer).
    if (step !== "ask_role" && step !== "verify_phone" && !step.endsWith("_send_payment")
        && !step.endsWith("_awaiting_payment") && !step.endsWith("_awaiting_stripe")
        && !step.endsWith("_awaiting_bgcheck") && !step.endsWith("_awaiting_membership")
        && !step.endsWith("_awaiting_documents") && !step.endsWith("_awaiting_photo")) {
        const switchTo = await detectRoleSwitch(text, (_d = session.userType) !== null && _d !== void 0 ? _d : null);
        if (switchTo) {
            await updateSession(phone, {
                onboardingStep: "ask_role",
                userType: null,
                onboardingData: {},
            });
            await (0, client_1.sendMessage)(chatId, switchTo === "caregiver"
                ? "Got it — switching you over. You're a caregiver looking for work, right? Reply 2 to confirm, or 1 if you actually meant client."
                : "Got it — switching you over. You need care for someone, right? Reply 1 to confirm, or 2 if you actually meant caregiver.");
            return;
        }
    }
    // Mid-flow correction: "actually my name is X", "sorry, my city is Y"
    // Only applies once user has started answering (not on ask_role)
    if (step !== "ask_role" && !step.endsWith("_send_payment") && !step.endsWith("_awaiting_payment")
        && !step.endsWith("_send_photo") && !step.endsWith("_awaiting_photo")
        && !step.endsWith("_send_documents") && !step.endsWith("_awaiting_documents")
        && !step.endsWith("_send_bgcheck") && !step.endsWith("_awaiting_bgcheck")
        && !step.endsWith("_send_stripe_connect") && !step.endsWith("_awaiting_stripe")
        && !step.endsWith("_send_membership") && !step.endsWith("_awaiting_membership")
        && step !== "client_confirm_intake"
        && !step.startsWith("job_")) {
        const correction = await detectCorrection(text);
        if (correction) {
            await mergeOnboardingData(phone, { [correction.field]: correction.value });
            // Re-ask the current question
            const stepMessages = {
                client_ask_name: "What's your name?",
                client_ask_senior: "Who are you looking for care for? (Their name and your relationship)",
                client_ask_needs: "What kind of help do they need, and how old are they?",
                client_ask_location: "What city and zip code are you in?",
                client_ask_schedule: "How many days a week and what hours do you need care?",
                caregiver_ask_name: "What's your name?",
                caregiver_ask_location: "What city and zip code are you based in?",
                caregiver_ask_experience: "How many years of caregiving experience do you have?",
                caregiver_ask_specialties: "What types of care do you specialize in?",
                caregiver_ask_availability: "What days and hours are you available to work?",
                caregiver_ask_job_type: "Are you looking for occasional, part-time, or full-time work?",
                caregiver_ask_rate: "What's your hourly rate?",
                caregiver_ask_email: "What's your email address?",
            };
            const repeat = (_e = stepMessages[step]) !== null && _e !== void 0 ? _e : "Could you continue where we left off?";
            await (0, client_1.sendMessage)(chatId, `Got it — updated.\n\n${repeat}`);
            return;
        }
    }
    // Route to the appropriate step handler
    switch (step) {
        case "verify_phone": return handleVerifyPhone(phone, chatId, text, session);
        case "ask_role": return handleAskRole(phone, chatId, text);
        case "client_ask_name": return handleClientAskName(phone, chatId, text, session);
        case "client_ask_senior": return handleClientAskSenior(phone, chatId, text, session);
        case "client_ask_needs": return handleClientAskNeeds(phone, chatId, text, session);
        case "client_ask_location": return handleClientAskLocation(phone, chatId, text, session);
        case "client_ask_schedule": return handleClientAskSchedule(phone, chatId, text, session);
        case "client_ask_start": return handleClientAskStart(phone, chatId, text, session);
        case "client_ask_preferences": return handleClientAskPreferences(phone, chatId, text, session);
        case "client_ask_budget": return handleClientAskBudget(phone, chatId, text, session);
        case "client_confirm_intake": return handleClientConfirmIntake(phone, chatId, text, session);
        case "client_ask_plan": return handleClientPlanReply(phone, chatId, text, session);
        case "client_send_payment": return handleClientSendPayment(phone, chatId, session);
        case "client_awaiting_identity": {
            const msgIdentity = await (0, caraMessage_1.generateCaraMessage)({
                audience: "family",
                context: "A family member texted Cara while their identity verification is still in progress. Reassure them it's still being verified and that Cara will send their caregiver options as soon as it clears.",
                fallback: "Still verifying — I'll send your caregiver options as soon as it clears.",
                maxTokens: 80,
            });
            await (0, client_1.sendMessage)(chatId, msgIdentity);
            return;
        }
        case "client_awaiting_payment":
            await (0, client_1.sendMessage)(chatId, "I'm still waiting for your payment setup to complete. Tap the link I sent to finish up — it only takes 30 seconds! 💳");
            return;
        case "job_confirm_prefill": return handleJobConfirmPrefill(phone, chatId, text, session);
        case "job_ask_start": return handleJobAskStart(phone, chatId, text, session);
        case "job_ask_frequency": return handleJobAskFrequency(phone, chatId, text, session);
        case "job_ask_days": return handleJobAskDays(phone, chatId, text, session);
        case "job_ask_time": return handleJobAskTime(phone, chatId, text, session);
        case "job_ask_care_needs": return handleJobAskCareNeeds(phone, chatId, text, session);
        case "job_ask_care_level": return handleJobAskCareLevel(phone, chatId, text, session);
        case "job_ask_environment": return handleJobAskEnvironment(phone, chatId, text, session);
        case "job_ask_rate": return handleJobAskRate(phone, chatId, text, session);
        case "job_ask_pay_method": return handleJobAskPayMethod(phone, chatId, text, session);
        case "job_ask_description": return handleJobAskDescription(phone, chatId, text, session);
        case "job_confirm_post": return handleJobConfirmPost(phone, chatId, text, session);
        case "caregiver_ask_name": return handleCaregiverAskName(phone, chatId, text, session);
        case "caregiver_ask_location": return handleCaregiverAskLocation(phone, chatId, text, session);
        case "caregiver_ask_experience": return handleCaregiverAskExperience(phone, chatId, text, session);
        case "caregiver_ask_specialties": return handleCaregiverAskSpecialties(phone, chatId, text, session);
        case "caregiver_ask_profile": return handleCaregiverAskProfile(phone, chatId, text, session);
        case "caregiver_ask_availability": return handleCaregiverAskAvailability(phone, chatId, text, session);
        case "caregiver_ask_job_type": return handleCaregiverAskJobType(phone, chatId, text, session);
        case "caregiver_ask_rate": return handleCaregiverAskRate(phone, chatId, text, session);
        case "caregiver_ask_email": return handleCaregiverAskEmail(phone, chatId, text, session);
        case "caregiver_ask_bio": return handleCaregiverAskBio(phone, chatId, text, session);
        case "caregiver_send_photo": return handleCaregiverSendPhoto(phone, chatId, session);
        case "caregiver_awaiting_photo":
            await (0, client_1.sendMessage)(chatId, "Still waiting for your photo! Tap the upload link I sent 📷");
            return;
        case "caregiver_send_documents": return handleCaregiverSendDocuments(phone, chatId, session);
        case "caregiver_awaiting_documents":
            if (norm === "SKIP") {
                await updateSession(phone, { onboardingStep: "caregiver_ask_mvr" });
                return handleCaregiverAskMvr(phone, chatId, session);
            }
            await (0, client_1.sendMessage)(chatId, "Tap the link I sent to upload your certifications, or reply SKIP to continue without them.");
            return;
        case "caregiver_ask_mvr": return handleCaregiverAskMvr(phone, chatId, text, session);
        case "caregiver_send_membership": return handleCaregiverSendMembership(phone, chatId, session);
        case "caregiver_awaiting_membership":
            await handleCaregiverResendMembership(phone, chatId, session, text);
            return;
        case "caregiver_send_bgcheck": return handleCaregiverSendBgcheck(phone, chatId, session);
        case "caregiver_awaiting_bgcheck": {
            const msgBgcheck = await (0, caraMessage_1.generateCaraMessage)({
                audience: "caregiver",
                context: "A caregiver texted Cara while their background check is still processing. Let them know it's still in progress, that it usually takes 1–3 days, and that Cara will text them the moment results are in.",
                fallback: "Your background check is still processing — usually 1–3 days. I'll text you the moment results are in.",
                maxTokens: 80,
            });
            await (0, client_1.sendMessage)(chatId, msgBgcheck);
            return;
        }
        case "caregiver_send_stripe_connect": return handleCaregiverSendStripeConnect(phone, chatId, session);
        case "caregiver_awaiting_stripe":
            await (0, client_1.sendMessage)(chatId, "Tap the link I sent to set up your payout account so you can get paid after each visit.");
            return;
        default:
            await (0, client_1.sendMessage)(chatId, "I think something went sideways. Reply START OVER to begin fresh.");
    }
}
// ── verify_phone ──────────────────────────────────────────────────────────────
// Phone-possession check. The session was created with an OTP that we texted
// to the FROM number; only the real owner of that number receives it. We block
// progression past this step until they reply with the code.
async function handleVerifyPhone(phone, chatId, text, session) {
    var _a;
    const norm = text.trim().toUpperCase();
    const otp = session.otp;
    const lang = (0, language_1.languageFromSession)(session);
    // If the message looks more like a question than an OTP code or RESEND/STOP keyword,
    // answer it and re-prompt instead of failing the OTP attempt.
    const looksLikeCode = /^\s*\d{4,6}\s*$/.test(text);
    if (!looksLikeCode && norm !== "RESEND" && norm !== "START OVER" && norm !== "RESTART" && await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, "Please reply with the 6-digit verification code I just texted you. (Reply RESEND if you didn't get it.)");
        return;
    }
    // RESEND — issue a new code (rate-limited to once per 30s by checking issuedAt)
    if (norm === "RESEND") {
        const issuedMs = (otp === null || otp === void 0 ? void 0 : otp.issuedAt) ? new Date(otp.issuedAt).getTime() : 0;
        if (Date.now() - issuedMs < 30000) {
            await (0, client_1.sendMessage)(chatId, language_1.t.otp_resend_too_soon(lang));
            return;
        }
        const fresh = (0, phoneVerification_1.generateOtp)();
        await updateSession(phone, { otp: fresh });
        await (0, client_1.sendMessage)(chatId, language_1.t.otp_resend_new_code((0, phoneVerification_1.formatOtpForDisplay)(fresh.code), lang));
        return;
    }
    const result = (0, phoneVerification_1.verifyOtp)(text, otp);
    if (result.status === "ok") {
        await updateSession(phone, {
            onboardingStep: "ask_role",
            otp: null,
        });
        await (0, client_1.sendMessage)(chatId, language_1.t.otp_verified_role_question(lang));
        return;
    }
    if (result.status === "expired" || result.status === "locked" || result.status === "no_state") {
        const fresh = (0, phoneVerification_1.generateOtp)();
        await updateSession(phone, { otp: fresh });
        await (0, client_1.sendMessage)(chatId, language_1.t.otp_fresh_code_after_expiry((0, phoneVerification_1.formatOtpForDisplay)(fresh.code), lang));
        return;
    }
    // wrong — increment attempts, prompt again
    const attempts = ((_a = otp === null || otp === void 0 ? void 0 : otp.attempts) !== null && _a !== void 0 ? _a : 0) + 1;
    await updateSession(phone, { otp: Object.assign(Object.assign({}, otp), { attempts }) });
    await (0, client_1.sendMessage)(chatId, language_1.t.otp_wrong(result.attemptsLeft, lang));
}
// ── ask_role ──────────────────────────────────────────────────────────────────
async function handleAskRole(phone, chatId, text) {
    const raw = await parseWithClaude('The user is choosing between two options: (1) they need care for a loved one (family/client) or ' +
        '(2) they are a caregiver looking for work. ' +
        '"1", "family", "need care", "mom", "dad", "parent", "loved one" → client. ' +
        '"2", "caregiver", "CNA", "HHA", "nurse", "work", "job", "looking for work" → caregiver. ' +
        'Reply with exactly one word: client or caregiver. If truly unclear, reply: unclear', text);
    if (raw === "client") {
        await updateSession(phone, { onboardingStep: "client_ask_name", userType: "client" });
        const msg1 = await (0, caraMessage_1.generateCaraMessage)({
            audience: "family",
            context: "Cara is greeting a new family member who just said they're looking for care for a loved one. Ask for their name warmly.",
            fallback: "I'd love to help. What's your name?",
            maxTokens: 80,
        });
        await (0, client_1.sendMessage)(chatId, msg1);
        return;
    }
    if (raw === "caregiver") {
        await updateSession(phone, { onboardingStep: "caregiver_ask_name", userType: "caregiver" });
        const msg2 = await (0, caraMessage_1.generateCaraMessage)({
            audience: "caregiver",
            context: "Cara is greeting a new caregiver who just said they're looking for work. Let them know profile setup takes about 5 minutes and everything happens right here over text. Then ask for their name.",
            fallback: "Great — let's get your profile set up. Takes about 5 minutes and everything happens right here.\n\nWhat's your name?",
            maxTokens: 80,
        });
        await (0, client_1.sendMessage)(chatId, msg2);
        return;
    }
    await (0, client_1.sendMessage)(chatId, "I want to make sure I help you with the right thing!\n\n" +
        "Reply 1 if you need care for a loved one, or 2 if you're a caregiver looking for work.");
}
// ── CLIENT FLOW ───────────────────────────────────────────────────────────────
async function handleClientAskName(phone, chatId, text, session) {
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, "What's your name?");
        return;
    }
    const firstName = await parseWithClaude("Extract only the first name from this message. Reply with just the first name, nothing else. If you cannot find a name, reply: unknown", text);
    const safeName = (!firstName || firstName === "__parse_error__" || firstName === "unknown") ? "there" : firstName;
    if (safeName === "there") {
        await (0, client_1.sendMessage)(chatId, "I didn't catch your name — could you share it?");
        return;
    }
    await mergeOnboardingData(phone, { firstName: safeName });
    await updateSession(phone, { onboardingStep: "client_ask_senior" });
    const msg3 = await (0, caraMessage_1.generateCaraMessage)({
        audience: "family",
        context: `Cara just learned the client's name is ${safeName}. Greet them warmly by name and ask who they're looking for care for (name and relationship to them, e.g. "my mom Dorothy").`,
        fallback: `Nice to meet you, ${safeName}. Who are we caring for?`,
        maxTokens: 80,
    });
    await (0, client_1.sendMessage)(chatId, msg3);
}
async function handleClientAskSenior(phone, chatId, text, session) {
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, "Now, who are you looking for care for? (Their name and your relationship, e.g. 'my mom Dorothy')");
        return;
    }
    const raw = await parseWithClaude('Extract the senior\'s first name and the user\'s relationship to them from this message. Reply in JSON format: {"seniorName":"...","relationship":"..."}', text);
    let seniorName = "your loved one", relationship = "family member";
    try {
        const parsed = JSON.parse(raw);
        seniorName = parsed.seniorName || seniorName;
        relationship = parsed.relationship || relationship;
    }
    catch ( /* keep defaults */_a) { /* keep defaults */ }
    await mergeOnboardingData(phone, { seniorName, relationship });
    await updateSession(phone, { onboardingStep: "client_ask_needs" });
    const msg4 = await (0, caraMessage_1.generateCaraMessage)({
        audience: "family",
        context: `Cara is onboarding a family. They just said they're looking for care for ${seniorName} (their ${relationship}). Ask how old ${seniorName} is and what kind of help they need these days.`,
        fallback: `Got it. How old is ${seniorName}, and what do they need help with these days?`,
        maxTokens: 80,
    });
    await (0, client_1.sendMessage)(chatId, msg4);
}
async function handleClientAskNeeds(phone, chatId, text, session) {
    var _a, _b, _c, _d, _e, _f;
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        const d = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
        await (0, client_1.sendMessage)(chatId, `How old is ${(_b = d.seniorName) !== null && _b !== void 0 ? _b : "your loved one"}, and what kind of help do they need?`);
        return;
    }
    const raw = await parseWithClaude('Extract age (as number), careNeeds (array of strings), and conditions (array of strings) from this message. Reply in JSON: {"age":0,"careNeeds":[],"conditions":[]}', text);
    let age = 0;
    let careNeeds = [];
    let conditions = [];
    try {
        const parsed = JSON.parse(raw);
        age = (_c = parsed.age) !== null && _c !== void 0 ? _c : 0;
        careNeeds = (_d = parsed.careNeeds) !== null && _d !== void 0 ? _d : [];
        conditions = (_e = parsed.conditions) !== null && _e !== void 0 ? _e : [];
    }
    catch ( /* keep defaults */_g) { /* keep defaults */ }
    await mergeOnboardingData(phone, { age, careNeeds, conditions });
    await updateSession(phone, { onboardingStep: "client_ask_location" });
    const seniorName = (_f = session.onboardingData) === null || _f === void 0 ? void 0 : _f.seniorName;
    const condLabel = conditions.length > 0 ? conditions.join(", ") : (careNeeds.length > 0 ? careNeeds.join(", ") : "");
    const msg5 = await (0, caraMessage_1.generateCaraMessage)({
        audience: "family",
        context: `Cara is collecting onboarding info for a family caring for ${seniorName !== null && seniorName !== void 0 ? seniorName : "their loved one"}. ` +
            `They just shared the care situation${condLabel ? ` (${condLabel})` : ""}. ` +
            `If the situation is emotionally heavy (memory care, a serious diagnosis, or the family sounds worried), ` +
            `acknowledge that weight warmly in one short sentence first — no platitudes, no clinical hedging. ` +
            `Then ask what city and zip code ${seniorName !== null && seniorName !== void 0 ? seniorName : "they"} lives in so you can find specialists nearby.`,
        fallback: `And where does ${seniorName !== null && seniorName !== void 0 ? seniorName : "they"} live?`,
        emotionalDirective: session._emotionalDirective,
        maxTokens: 120,
    });
    await (0, client_1.sendMessage)(chatId, msg5);
}
async function handleClientAskLocation(phone, chatId, text, session) {
    var _a, _b, _c, _d, _e, _f;
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, "What city and zip code are you in? (e.g. \"Austin, TX 78701\")");
        return;
    }
    const raw = await parseWithClaude('Extract city and zipCode from this address text. Reply in JSON: {"city":"...","zipCode":"..."}', text);
    let city = "", zipCode = "";
    try {
        if (raw !== "__parse_error__") {
            const parsed = JSON.parse(raw);
            city = (_a = parsed.city) !== null && _a !== void 0 ? _a : "";
            zipCode = (_b = parsed.zipCode) !== null && _b !== void 0 ? _b : "";
        }
    }
    catch ( /* keep defaults */_g) { /* keep defaults */ }
    if (!city && !zipCode) {
        await (0, client_1.sendMessage)(chatId, "Hmm, I didn't catch that. Could you share your city and zip code? (e.g. \"Austin, TX 78701\")");
        return;
    }
    await mergeOnboardingData(phone, { city, zipCode });
    await updateSession(phone, { onboardingStep: "client_ask_schedule" });
    const d = (_c = session.onboardingData) !== null && _c !== void 0 ? _c : {};
    const msg6 = await (0, caraMessage_1.generateCaraMessage)({
        audience: "family",
        context: `Cara is onboarding a family. They just gave the location where ${(_d = d.seniorName) !== null && _d !== void 0 ? _d : "their loved one"} lives. Ask how often ${(_e = d.seniorName) !== null && _e !== void 0 ? _e : "they"} needs a caregiver and what times of day work best.`,
        fallback: `How often does ${(_f = d.seniorName) !== null && _f !== void 0 ? _f : "they"} need someone, and what times of day work best?`,
        maxTokens: 80,
    });
    await (0, client_1.sendMessage)(chatId, msg6);
}
async function handleClientAskSchedule(phone, chatId, text, session) {
    var _a, _b, _c, _d, _e, _f, _g;
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        const d = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
        await (0, client_1.sendMessage)(chatId, `How often does ${(_b = d.seniorName) !== null && _b !== void 0 ? _b : "they"} need someone, and what times of day work best?`);
        return;
    }
    const raw = await parseWithClaude('Extract daysPerWeek (number), timeOfDay (morning/afternoon/evening/all-day), and hoursPerDay (number) from this message. Reply in JSON: {"daysPerWeek":0,"timeOfDay":"","hoursPerDay":0}', text);
    if (raw === "__parse_error__") {
        await (0, client_1.sendMessage)(chatId, "Hmm, I didn't catch that. What days and hours do you need care? (e.g. \"Mon–Fri, 9am to 3pm\" or \"3 days a week, mornings\")");
        return;
    }
    let daysPerWeek = 3, timeOfDay = "mornings", hoursPerDay = 4;
    try {
        const parsed = JSON.parse(raw);
        daysPerWeek = (_c = parsed.daysPerWeek) !== null && _c !== void 0 ? _c : daysPerWeek;
        timeOfDay = (_d = parsed.timeOfDay) !== null && _d !== void 0 ? _d : timeOfDay;
        hoursPerDay = (_e = parsed.hoursPerDay) !== null && _e !== void 0 ? _e : hoursPerDay;
    }
    catch ( /* keep defaults */_h) { /* keep defaults */ }
    await mergeOnboardingData(phone, { daysPerWeek, timeOfDay, hoursPerDay });
    await updateSession(phone, { onboardingStep: "client_ask_start" });
    const dSched = (_f = session.onboardingData) !== null && _f !== void 0 ? _f : {};
    const seniorSched = (_g = dSched.seniorName) !== null && _g !== void 0 ? _g : "your loved one";
    const startMsg = await (0, caraMessage_1.generateCaraMessage)({
        audience: "family",
        context: `Cara is onboarding a family for ${seniorSched}. They just gave their schedule. Acknowledge it in one short line, then ask when they'd like care to start — right away, or a specific date.`,
        fallback: `Got it. And when would you like care to start for ${seniorSched} — right away, or a specific date?`,
        emotionalDirective: session._emotionalDirective,
        maxTokens: 90,
    });
    await (0, client_1.sendMessage)(chatId, startMsg);
}
// ── New intake steps: start date → preferences → budget → playback confirm ─────
async function handleClientAskStart(phone, chatId, text, session) {
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, "When would you like care to start — right away, or a specific date?");
        return;
    }
    const parsed = await parseWithClaude("Extract when the family wants care to start. Reply with a short phrase: \"asap\" if they want it right away/" +
        "urgently, the specific date in their own words if they gave one, or \"flexible\" if they're unsure. Just the phrase.", text);
    const startDate = (!parsed || parsed === "__parse_error__") ? "flexible" : parsed;
    await mergeOnboardingData(phone, { startDate });
    await updateSession(phone, { onboardingStep: "client_ask_preferences" });
    const prefMsg = await (0, caraMessage_1.generateCaraMessage)({
        audience: "family",
        context: `Cara is onboarding a family; care should start "${startDate}". Acknowledge briefly, then ask if they have any preferences for the caregiver — gender, language, or whether they need someone who can drive. Make clear it's optional and they can just say "no preference".`,
        fallback: "Any preferences for the caregiver — gender, language, or someone who can drive? Totally optional — just say \"no preference\" if not.",
        emotionalDirective: session._emotionalDirective,
        maxTokens: 90,
    });
    await (0, client_1.sendMessage)(chatId, prefMsg);
}
async function handleClientAskPreferences(phone, chatId, text, session) {
    var _a, _b, _c, _d, _e;
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, "Any preferences for the caregiver — gender, language, driving? (or \"no preference\")");
        return;
    }
    const raw = await parseWithClaude("Extract caregiver preferences. Reply in JSON: {\"gender\":\"\",\"language\":\"\",\"driving\":false,\"other\":\"\"}. " +
        "gender: \"female\"/\"male\" or \"\" if none. language: a language name or \"\". driving: true only if they need " +
        "someone who can drive. other: any other preference (pets, smoking, non-smoker, etc.) or \"\". If they say no " +
        "preference, return all empty/false.", text);
    let prefs = {};
    try {
        prefs = JSON.parse(raw);
    }
    catch ( /* none */_f) { /* none */ }
    await mergeOnboardingData(phone, {
        caregiverPreferences: prefs,
        // Top-level keys the matching engine reads directly (matchingAgent + claudeMatching).
        genderPreference: (_a = prefs.gender) !== null && _a !== void 0 ? _a : "",
        languagePreference: (_b = prefs.language) !== null && _b !== void 0 ? _b : "",
        needsDriving: prefs.driving === true,
        otherPreference: (_c = prefs.other) !== null && _c !== void 0 ? _c : "",
    });
    await updateSession(phone, { onboardingStep: "client_ask_budget" });
    const d = (_d = session.onboardingData) !== null && _d !== void 0 ? _d : {};
    const city = (_e = d.city) !== null && _e !== void 0 ? _e : "";
    const rangeHint = city ? `Caregivers near ${city} typically run $18–28/hr` : "Caregivers typically run $18–28/hr";
    const budgetMsg = await (0, caraMessage_1.generateCaraMessage)({
        audience: "family",
        context: `Cara is onboarding a family. They just shared caregiver preferences. Now ask about budget. In one line make clear the caregiver's hourly pay is SEPARATE from the CareConnex membership, include this hint verbatim: "${rangeHint}", and ask if they have an hourly budget in mind (they can say "not sure"). Warm and brief.`,
        fallback: `One more — caregivers are paid hourly, separate from your CareConnex membership. ${rangeHint}. Do you have an hourly budget in mind? ("not sure" is totally fine)`,
        maxTokens: 110,
    });
    await (0, client_1.sendMessage)(chatId, budgetMsg);
}
async function handleClientAskBudget(phone, chatId, text, session) {
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, "Do you have an hourly budget in mind? (\"not sure\" is fine)");
        return;
    }
    const raw = await parseWithClaude("Extract the family's hourly budget. Reply in JSON: {\"min\":0,\"max\":0}. If one number, set both to it. " +
        "If a range, set min and max. If they're not sure / no budget, return {\"min\":0,\"max\":0}.", text);
    let budget = { min: 0, max: 0 };
    try {
        const p = JSON.parse(raw);
        budget = { min: Number(p.min) || 0, max: Number(p.max) || 0 };
    }
    catch ( /* none */_a) { /* none */ }
    // Store budgetMax top-level too — the matching engine reads it directly.
    await mergeOnboardingData(phone, { budget, budgetMin: budget.min, budgetMax: budget.max });
    await updateSession(phone, { onboardingStep: "client_confirm_intake" });
    const refreshed = await db.collection("agent_sessions").doc(phone).get();
    const rs = refreshed.data();
    await sendClientIntakeSummary(chatId, rs);
}
// Plain-text playback of everything Cara captured — a confirmation gate before
// the paywall so a parse error can't slip through unnoticed.
function buildIntakeSummary(d) {
    var _a, _b;
    const seniorName = d.seniorName || "your loved one";
    const age = d.age ? `${d.age}` : "";
    const conditions = Array.isArray(d.conditions) && d.conditions.length
        ? d.conditions.join(", ")
        : Array.isArray(d.careNeeds) && d.careNeeds.length
            ? d.careNeeds.join(", ")
            : "";
    const loc = [d.city, d.zipCode].filter(Boolean).join(" ");
    const days = d.daysPerWeek ? `${d.daysPerWeek} day${Number(d.daysPerWeek) === 1 ? "" : "s"}/week` : "";
    const tod = d.timeOfDay || "";
    const sched = [days, tod].filter(Boolean).join(", ");
    const start = d.startDate || "";
    const prefs = (_a = d.caregiverPreferences) !== null && _a !== void 0 ? _a : {};
    const prefBits = [];
    if (prefs.gender)
        prefBits.push(String(prefs.gender));
    if (prefs.language)
        prefBits.push(`${prefs.language}-speaking`);
    if (prefs.driving)
        prefBits.push("can drive");
    if (prefs.other)
        prefBits.push(String(prefs.other));
    const b = (_b = d.budget) !== null && _b !== void 0 ? _b : {};
    const budget = (b.min || b.max)
        ? (b.min === b.max ? `$${b.max}/hr` : `$${b.min}–${b.max}/hr`)
        : "";
    const lines = ["Here's what I've got:"];
    lines.push(`• Care for ${seniorName}${age || conditions ? ` (${[age, conditions].filter(Boolean).join(", ")})` : ""}`);
    if (loc)
        lines.push(`• In ${loc}`);
    if (sched)
        lines.push(`• ${sched}`);
    if (start)
        lines.push(`• Starting: ${start}`);
    if (prefBits.length)
        lines.push(`• Preference: ${prefBits.join(", ")}`);
    if (budget)
        lines.push(`• Budget: ${budget}`);
    lines.push("", "Did I get that right? Reply YES to see your matches, or tell me what to fix.");
    return lines.join("\n");
}
async function sendClientIntakeSummary(chatId, session) {
    var _a;
    await (0, client_1.sendMessage)(chatId, buildIntakeSummary((_a = session.onboardingData) !== null && _a !== void 0 ? _a : {}));
}
// Pull any corrected intake fields out of a free-text edit at the confirm step.
async function extractIntakeCorrections(text) {
    const raw = await parseWithClaude("The family is correcting their care intake. Extract ONLY the fields they're changing; omit the rest. " +
        "Return raw JSON with any of: {\"seniorName\":\"\",\"age\":0,\"careNeeds\":[],\"conditions\":[],\"city\":\"\"," +
        "\"zipCode\":\"\",\"daysPerWeek\":0,\"timeOfDay\":\"\",\"hoursPerDay\":0,\"startDate\":\"\",\"budget\":{\"min\":0,\"max\":0}}. " +
        "Only include a field if they clearly changed it.", text).catch(() => "{}");
    try {
        const parsed = JSON.parse(raw);
        const out = {};
        for (const [k, v] of Object.entries(parsed)) {
            if (v === null || v === undefined)
                continue;
            if (typeof v === "string" && v.trim() === "")
                continue;
            if (typeof v === "number" && v === 0)
                continue;
            if (Array.isArray(v) && v.length === 0)
                continue;
            if (k === "budget") {
                const bv = v;
                if (!bv.min && !bv.max)
                    continue;
            }
            out[k] = v;
        }
        return out;
    }
    catch (_a) {
        return {};
    }
}
async function handleClientConfirmIntake(phone, chatId, text, session) {
    const intent = await parseWithClaude('"yes", "yep", "correct", "looks good", "that\'s right", "go", "perfect" → confirm. ' +
        'Anything that corrects/changes a detail, or says no → edit. Reply with exactly one word: confirm or edit.', text);
    if (intent === "confirm") {
        const refreshed = await db.collection("agent_sessions").doc(phone).get();
        const rs = refreshed.data();
        rs._emotionalDirective = session._emotionalDirective;
        await handleClientShowCaregivers(phone, chatId, rs);
        return;
    }
    const corrections = await extractIntakeCorrections(text);
    if (Object.keys(corrections).length > 0) {
        await mergeOnboardingData(phone, corrections);
        const refreshed = await db.collection("agent_sessions").doc(phone).get();
        await (0, client_1.sendMessage)(chatId, "Got it — updated.");
        await sendClientIntakeSummary(chatId, refreshed.data());
    }
    else {
        await (0, client_1.sendMessage)(chatId, "No problem — tell me what to change and I'll fix it. Or reply YES to go ahead.");
    }
}
async function createClientIdentitySession(phone) {
    var _a;
    const caraPhone = encodeURIComponent((_a = process.env.LINQ_PHONE_NUMBER) !== null && _a !== void 0 ? _a : "");
    const session = await getStripe().identity.verificationSessions.create({
        type: "document",
        metadata: { phone },
        return_url: `${APP_URL}/client/identity-callback?source=cara&caraPhone=${caraPhone}`,
    });
    await db.collection("agent_sessions").doc(phone).update({ identitySessionId: session.id });
    return session.url;
}
async function handleClientShowCaregivers(phone, chatId, session) {
    var _a, _b, _c;
    const d = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
    const city = (_b = d.city) !== null && _b !== void 0 ? _b : "";
    const seniorName = (_c = d.seniorName) !== null && _c !== void 0 ? _c : "your loved one";
    const careNeeds = Array.isArray(d.careNeeds) ? d.careNeeds : [];
    // Query caregivers in their city first. If none, WIDEN to any active caregiver
    // (nearest available) rather than dead-ending — and only if there's truly zero
    // supply anywhere do we honestly hold and skip the paywall.
    const localSnap = await db
        .collection("caregivers")
        .where("status", "==", "active")
        .where("city", "==", city)
        .limit(5)
        .get();
    let docs;
    let total;
    let widened = false;
    if (!localSnap.empty) {
        docs = localSnap.docs.map(doc => doc.data());
        total = localSnap.size;
    }
    else {
        const widerSnap = await db.collection("caregivers").where("status", "==", "active").limit(5).get();
        if (widerSnap.empty) {
            // No supply at all — don't take payment for something we can't deliver.
            await updateSession(phone, { onboardingStep: "complete", awaitingSupply: true });
            await (0, client_1.sendMessage)(chatId, `I don't have caregivers available in ${city || "your area"} just yet — but I've saved everything about ` +
                `${seniorName}'s care, and I'll text you the moment the right person is available. No charge until then. 💙`);
            return;
        }
        docs = widerSnap.docs.map(doc => doc.data());
        total = widerSnap.size;
        widened = true;
    }
    const preview = docs.slice(0, 3).map(c => {
        var _a, _b, _c, _d, _e, _f;
        const name = ((_a = c.name) !== null && _a !== void 0 ? _a : "Caregiver");
        const exp = (_c = (_b = c.yearsExperience) !== null && _b !== void 0 ? _b : c.experience) !== null && _c !== void 0 ? _c : "";
        const spec = Array.isArray(c.specialties)
            ? c.specialties[0]
            : ((_f = (_e = (_d = c.primaryServices) === null || _d === void 0 ? void 0 : _d[0]) === null || _e === void 0 ? void 0 : _e.name) !== null && _f !== void 0 ? _f : "");
        return `• ${name}${exp ? ` — ${exp} yrs exp` : ""}${spec ? `, ${spec}` : ""}`;
    }).join("\n");
    const locationLabel = city || "your area";
    const needsLabel = careNeeds.length > 0
        ? careNeeds.slice(0, 2).join(" & ")
        : "care";
    const caregiverMsg = widened
        ? `I don't have caregivers right in ${locationLabel} yet, but here are the nearest ones available:\n\n${preview}\n\n` +
            `Here's how I'd get ${seniorName} connected with one:`
        : `I found ${total > 5 ? "6+" : total} caregiver${total !== 1 ? "s" : ""} near ${locationLabel} ` +
            `who can help with ${needsLabel}:\n\n${preview}\n\n` +
            `Here's how I'd get ${seniorName} connected with them:`;
    await (0, client_1.sendMessage)(chatId, caregiverMsg);
    // Value first (real caregivers shown above), then price, THEN identity, THEN
    // payment — so a family never has to scan a government ID before they even
    // know what CareConnex costs. handleClientPresentPlan sets up the price.
    await updateSession(phone, { onboardingStep: "client_ask_plan" });
    await handleClientPresentPlan(phone, chatId, session);
}
// When a caregiver activates, re-engage families we honestly held (awaitingSupply)
// in that city: clear the flag, tell them care is now available, and drop them
// back into the show-caregivers → price flow (which now has real supply).
async function notifyWaitlistedFamilies(caregiverCity) {
    var _a, _b, _c, _d;
    if (!caregiverCity)
        return;
    const cityLower = caregiverCity.toLowerCase();
    const snap = await db.collection("agent_sessions").where("awaitingSupply", "==", true).get();
    for (const doc of snap.docs) {
        try {
            const s = doc.data();
            const famCity = ((_b = (_a = s.onboardingData) === null || _a === void 0 ? void 0 : _a.city) !== null && _b !== void 0 ? _b : "").toLowerCase();
            if (!famCity || famCity !== cityLower)
                continue;
            const chatId = s.chatId;
            if (!chatId)
                continue;
            const seniorName = (_d = (_c = s.onboardingData) === null || _c === void 0 ? void 0 : _c.seniorName) !== null && _d !== void 0 ? _d : "your loved one";
            await db.collection("agent_sessions").doc(doc.id).update({ awaitingSupply: false }).catch(() => { });
            await (0, client_1.sendMessage)(chatId, `Good news — a caregiver just became available near ${caregiverCity}! Let me show you who can help ${seniorName}.`);
            await handleClientShowCaregivers(doc.id, chatId, s);
        }
        catch (err) {
            console.error("[notifyWaitlistedFamilies] error for", doc.id, err);
        }
    }
}
// Resolve the single configured client price. The 3-tier STRIPE_PLAN_*_PRICE_ID
// vars are not set in prod — only one monthly price exists — so picking a tier
// used to hand Stripe an empty priceId. Lead with the one real price.
function resolveClientPriceId() {
    var _a, _b, _c;
    return (_c = (_b = (_a = process.env.STRIPE_MEMBERSHIP_PRICE_ID) !== null && _a !== void 0 ? _a : process.env.STRIPE_PRICE_MONTHLY) !== null && _b !== void 0 ? _b : process.env.STRIPE_PLAN_FAMILY_PRICE_ID) !== null && _c !== void 0 ? _c : "";
}
// Single source of truth for the displayed price: read the amount straight from
// the live Stripe price object so the copy can never drift from what the family
// is actually charged. Returns "" on any error (copy degrades to generic).
async function describeClientPrice(priceId) {
    var _a;
    try {
        if (!priceId)
            return "";
        const price = await getStripe().prices.retrieve(priceId);
        if (price.unit_amount == null)
            return "";
        const dollars = price.unit_amount / 100;
        const amount = Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
        const interval = (_a = price.recurring) === null || _a === void 0 ? void 0 : _a.interval;
        return interval ? `${amount}/${interval === "month" ? "mo" : interval}` : amount;
    }
    catch (err) {
        console.error("describeClientPrice error:", err);
        return "";
    }
}
async function handleClientPresentPlan(phone, chatId, session) {
    var _a, _b;
    const d = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
    const seniorName = (_b = d.seniorName) !== null && _b !== void 0 ? _b : "your loved one";
    const priceId = resolveClientPriceId();
    await mergeOnboardingData(phone, { selectedPlan: "CareConnex", selectedPlanPriceId: priceId });
    const priceLabel = await describeClientPrice(priceId);
    const msg = await (0, caraMessage_1.generateCaraMessage)({
        audience: "family",
        context: `Cara just showed a family real local caregivers for ${seniorName}. Now state the price in one warm, simple ` +
            `message: CareConnex is ${priceLabel || "a simple monthly membership"}, and for that Cara coordinates ` +
            `everything for ${seniorName} — scheduling, weekly summaries, and keeping the whole family in the loop. ` +
            `2-3 sentences, no bullet lists, no pressure. End by asking if they'd like you to set them up (they can reply YES, or ask about options).`,
        fallback: `CareConnex is ${priceLabel || "one simple monthly membership"} — I coordinate everything for ${seniorName}: ` +
            `scheduling, weekly summaries, and keeping your whole family in the loop. Want me to set you up? (reply YES)`,
        emotionalDirective: session._emotionalDirective,
        maxTokens: 130,
    });
    await (0, client_1.sendMessage)(chatId, msg);
}
async function handleClientPlanReply(phone, chatId, text, session) {
    var _a, _b;
    // Mid-flow question (e.g. "is it monthly?") — answer, then re-offer.
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, "Want me to set you up? Reply YES and I'll get you verified and your matches connected.");
        return;
    }
    const intent = await parseWithClaude('"yes", "ok", "sure", "1", "sounds good", "let\'s do it", "sign me up" → confirm. ' +
        '"what are my options", "other plans", "cheaper", "more expensive", "upgrade", "tiers", "premium", "basic" → options. ' +
        'Anything unclear → unclear. Reply with exactly one word: confirm, options, or unclear.', text);
    if (intent === "options") {
        await (0, client_1.sendMessage)(chatId, "Right now everyone starts on the same simple membership — it covers me coordinating care, weekly summaries, " +
            "and family updates. Once you're set up, I can add things like 24/7 urgent response or a dedicated coordinator " +
            "if you ever want them. Want me to set you up? (reply YES)");
        return;
    }
    if (intent !== "confirm") {
        await (0, client_1.sendMessage)(chatId, "Just reply YES when you're ready and I'll get you connected with caregivers — happy to answer anything first.");
        return;
    }
    // Confirmed → ensure a price is stored, then send the identity link.
    const d = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
    let priceId = (_b = d.selectedPlanPriceId) !== null && _b !== void 0 ? _b : "";
    if (!priceId) {
        priceId = resolveClientPriceId();
        await mergeOnboardingData(phone, { selectedPlan: "CareConnex", selectedPlanPriceId: priceId });
    }
    await (0, client_1.signalThinking)(chatId, session.service);
    let identityUrl;
    try {
        identityUrl = await createClientIdentitySession(phone);
    }
    catch (err) {
        console.error("createClientIdentitySession error — falling back to payment:", err);
        await updateSession(phone, { onboardingStep: "client_send_payment" });
        await handleClientSendPayment(phone, chatId, session);
        return;
    }
    await (0, client_1.sendMessage)(chatId, "Perfect. Quick 30-second identity check first — it's how I keep every family on the platform real and safe:");
    await (0, client_1.sendMessage)(chatId, { parts: [{ type: "link", value: identityUrl }] });
    await updateSession(phone, { onboardingStep: "client_awaiting_identity" });
}
async function handleClientSendPayment(phone, chatId, session) {
    var _a, _b, _c, _d, _e;
    const d = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
    const caraPhone = encodeURIComponent((_b = process.env.LINQ_PHONE_NUMBER) !== null && _b !== void 0 ? _b : "");
    const priceId = (d.selectedPlanPriceId || resolveClientPriceId()).trim();
    let checkoutUrl = `${APP_URL}/payment/success?source=cara&caraPhone=${caraPhone}`;
    await (0, client_1.signalThinking)(chatId, session.service);
    try {
        // Real recurring membership — mode "subscription" actually starts billing.
        // (Falls back to setup/card-on-file only if no price is configured, so the
        // flow never hard-fails — but with STRIPE_MEMBERSHIP_PRICE_ID set this bills.)
        const stripeSession = priceId
            ? await getStripe().checkout.sessions.create({
                mode: "subscription",
                payment_method_types: ["card"],
                line_items: [{ price: priceId, quantity: 1 }],
                success_url: `${APP_URL}/payment/success?source=cara&caraPhone=${caraPhone}`,
                cancel_url: `${APP_URL}/start`,
                metadata: { phone, task: "client_payment_setup" },
                subscription_data: { metadata: { phone } },
            })
            : await getStripe().checkout.sessions.create({
                mode: "setup",
                payment_method_types: ["card"],
                success_url: `${APP_URL}/payment/success?source=cara&caraPhone=${caraPhone}`,
                cancel_url: `${APP_URL}/start`,
                metadata: { phone, task: "client_payment_setup" },
            });
        checkoutUrl = (_c = stripeSession.url) !== null && _c !== void 0 ? _c : checkoutUrl;
    }
    catch (err) {
        console.error("handleClientSendPayment stripe error:", err);
    }
    await updateSession(phone, { onboardingStep: "client_awaiting_payment" });
    const msg7 = await (0, caraMessage_1.generateCaraMessage)({
        audience: "family",
        context: `Cara has collected everything needed to start finding caregivers for ${(_d = d.seniorName) !== null && _d !== void 0 ? _d : "a loved one"}. Let the family know warmly, then tell them the last step is to start their membership so Cara can begin coordinating care, and that it takes about 30 seconds.`,
        fallback: `Perfect — I have everything I need to start finding caregivers for ${(_e = d.seniorName) !== null && _e !== void 0 ? _e : "your loved one"}.\n\nLast step: start your membership so I can begin coordinating care.\nTakes about 30 seconds:`,
        maxTokens: 100,
    });
    await (0, client_1.sendMessage)(chatId, msg7);
    await (0, client_1.sendMessage)(chatId, { parts: [{ type: "link", value: checkoutUrl }] });
    await (0, client_1.sendMessage)(chatId, "I'll start searching while you set that up.");
}
// ── CAREGIVER FLOW ────────────────────────────────────────────────────────────
async function handleCaregiverAskName(phone, chatId, text, session) {
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session !== null && session !== void 0 ? session : { onboardingData: {} });
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, "What's your name?");
        return;
    }
    const name = await parseWithClaude("Extract the full name from this message. Reply with just the name, nothing else.", text);
    if (name === "__parse_error__" || !name) {
        await (0, client_1.sendMessage)(chatId, "I didn't catch your name — could you share it?");
        return;
    }
    await mergeOnboardingData(phone, { name });
    await updateSession(phone, { onboardingStep: "caregiver_ask_location" });
    const msg9 = await (0, caraMessage_1.generateCaraMessage)({
        audience: "caregiver",
        context: `Cara just learned the caregiver's name is ${name}. Greet them by name and ask what city and zip code they work in.`,
        fallback: `Hi ${name} — what city and zip code do you work in?`,
        maxTokens: 80,
    });
    await (0, client_1.sendMessage)(chatId, msg9);
}
async function handleCaregiverAskLocation(phone, chatId, text, session) {
    var _a, _b, _c, _d, _e;
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, "What city and zip code do you work in?");
        return;
    }
    const raw = await parseWithClaude('Extract city and zipCode from this message. Reply in JSON: {"city":"...","zipCode":"..."}', text);
    let city = "", zipCode = "";
    try {
        const p = JSON.parse(raw);
        city = (_a = p.city) !== null && _a !== void 0 ? _a : "";
        zipCode = (_b = p.zipCode) !== null && _b !== void 0 ? _b : "";
    }
    catch ( /* keep defaults */_f) { /* keep defaults */ }
    await mergeOnboardingData(phone, { city, zipCode });
    // Value hook (founder direction): the moment a caregiver shares their location,
    // show REAL local demand so the platform proves it's legit before we ask for
    // anything. Honest empty state when nothing is open yet — no fabricated jobs.
    if (city) {
        try {
            const openSnap = await db.collection("job_posts").where("status", "==", "open").limit(50).get();
            const cityLower = city.toLowerCase();
            const localJobs = openSnap.docs.filter((doc) => {
                var _a;
                const c = (_a = doc.data().location) === null || _a === void 0 ? void 0 : _a.city;
                return c && String(c).toLowerCase() === cityLower;
            }).slice(0, 3);
            if (localJobs.length > 0) {
                const lines = localJobs.map((doc, i) => {
                    var _a;
                    const j = doc.data();
                    const needs = ((_a = j.careTypes) !== null && _a !== void 0 ? _a : []).join(", ") || "general care";
                    const rate = j.hourlyRate ? ` · $${j.hourlyRate}/hr` : "";
                    return `${i + 1}. ${needs}${rate}`;
                }).join("\n");
                await (0, client_1.sendMessage)(chatId, `Good news — there ${localJobs.length === 1 ? "is" : "are"} ${localJobs.length} open care ` +
                    `${localJobs.length === 1 ? "job" : "jobs"} near ${city} right now:\n\n${lines}\n\n` +
                    `Finish your quick profile and you'll be able to apply.`);
            }
            else {
                await (0, client_1.sendMessage)(chatId, `I don't have open jobs in ${city} this minute — new ones post daily and I'll text you ` +
                    `the moment one matches your skills. Let's finish your profile so you're ready to apply.`);
            }
        }
        catch (err) {
            console.error("[handleCaregiverAskLocation] local job teaser failed:", err);
        }
    }
    await updateSession(phone, { onboardingStep: "caregiver_ask_experience" });
    const d = (_c = session.onboardingData) !== null && _c !== void 0 ? _c : {};
    const msg10intro = await (0, caraMessage_1.generateCaraMessage)({
        audience: "caregiver",
        context: `Cara is onboarding caregiver ${(_d = d.name) !== null && _d !== void 0 ? _d : ""}. They just shared their city and zip code. Ask how many years of caregiving experience they have and whether they hold any certifications. Keep it warm and encouraging.`,
        fallback: `Great, ${(_e = d.name) !== null && _e !== void 0 ? _e : ""}! How many years of caregiving experience do you have, and do you hold any certifications?`,
        maxTokens: 80,
    });
    await (0, client_1.sendMessage)(chatId, `${msg10intro}\n\nFor example: "5 years, CNA and CPR" or "2 years, no certifications".`);
}
async function handleCaregiverAskExperience(phone, chatId, text, session) {
    var _a, _b;
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, "How many years of caregiving experience do you have, and do you hold any certifications?");
        return;
    }
    const raw = await parseWithClaude('Extract yearsExperience (number) and certifications (array of strings) from this message. Reply in JSON: {"yearsExperience":0,"certifications":[]}', text);
    let yearsExperience = 0, certifications = [];
    try {
        const p = JSON.parse(raw);
        yearsExperience = (_a = p.yearsExperience) !== null && _a !== void 0 ? _a : 0;
        certifications = (_b = p.certifications) !== null && _b !== void 0 ? _b : [];
    }
    catch ( /* keep defaults */_c) { /* keep defaults */ }
    await mergeOnboardingData(phone, { yearsExperience, certifications });
    await updateSession(phone, { onboardingStep: "caregiver_ask_specialties" });
    const msg11intro = await (0, caraMessage_1.generateCaraMessage)({
        audience: "caregiver",
        context: `Cara is onboarding a caregiver who just told her they have ${yearsExperience || "some"} years of experience` +
            `${certifications.length ? ` and these certifications: ${certifications.join(", ")}` : ""}. ` +
            `Acknowledge that warmly in one short line (genuine, not flattery clichés), then ask what types of care they specialize in.`,
        fallback: "What types of care do you specialize in?",
        maxTokens: 80,
    });
    await (0, client_1.sendMessage)(chatId, `${msg11intro}\n\nFor example: dementia, Alzheimer's, mobility assistance, post-surgery, companionship, medication management...`);
}
async function handleCaregiverAskSpecialties(phone, chatId, text, session) {
    var _a;
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, "What types of care do you specialize in? (e.g. dementia, mobility, post-surgery, companionship)");
        return;
    }
    const raw = await parseWithClaude("Extract a list of care specialties from this message. Reply in JSON: {\"specialties\":[\"...\",\"...\"]}", text);
    let specialties = [];
    try {
        const p = JSON.parse(raw);
        specialties = (_a = p.specialties) !== null && _a !== void 0 ? _a : [];
    }
    catch ( /* keep defaults */_b) { /* keep defaults */ }
    await mergeOnboardingData(phone, { specialties });
    await updateSession(phone, { onboardingStep: "caregiver_ask_profile" });
    const msgProfile = await (0, caraMessage_1.generateCaraMessage)({
        audience: "caregiver",
        context: `Cara is onboarding a caregiver who just shared their specialties${specialties.length ? `: ${specialties.join(", ")}` : ""}. ` +
            `Acknowledge it warmly in one short line, then ask three quick profile details families use when matching: ` +
            `whether they're male or female (some families have a preference), what languages they speak, and whether they can ` +
            `drive clients to appointments. Keep it light and quick.`,
        fallback: "A few quick details families use to match — are you male or female, what languages do you speak, and can you drive clients to appointments?",
        maxTokens: 100,
    });
    await (0, client_1.sendMessage)(chatId, msgProfile);
}
async function handleCaregiverAskProfile(phone, chatId, text, session) {
    var _a;
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, "Are you male or female, what languages do you speak, and can you drive clients to appointments?");
        return;
    }
    const raw = await parseWithClaude("Extract the caregiver's gender, the languages they speak, and whether they can drive clients. " +
        "Reply in JSON: {\"gender\":\"\",\"languages\":[],\"canDrive\":false}. " +
        "gender: \"female\"/\"male\"/\"other\" or \"\" if not stated. languages: array of language names; if they're writing " +
        "in English and didn't specify, include \"English\". canDrive: true if they say they can drive / have a car or " +
        "license, false otherwise.", text);
    let gender = "";
    let languages = [];
    let canDrive = false;
    try {
        const p = JSON.parse(raw);
        gender = (_a = p.gender) !== null && _a !== void 0 ? _a : "";
        languages = Array.isArray(p.languages) ? p.languages : [];
        canDrive = p.canDrive === true;
    }
    catch ( /* none */_b) { /* none */ }
    await mergeOnboardingData(phone, { gender, languages, canDrive });
    await updateSession(phone, { onboardingStep: "caregiver_ask_availability" });
    const msg12 = await (0, caraMessage_1.generateCaraMessage)({
        audience: "caregiver",
        context: "Cara is onboarding a caregiver who just shared a couple profile details. Acknowledge briefly, then ask what days and hours they're generally available to work.",
        fallback: "What days and hours are you generally available to work?",
        maxTokens: 80,
    });
    await (0, client_1.sendMessage)(chatId, msg12);
}
async function handleCaregiverAskAvailability(phone, chatId, text, session) {
    var _a, _b;
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, "What days and hours are you generally available to work?");
        return;
    }
    const raw = await parseWithClaude("Extract availability days (array of strings) and hours (string) from this message. Reply in JSON: {\"days\":[\"Monday\",\"Tuesday\"],\"hours\":\"9am-5pm\"}", text);
    let days = [], hours = "";
    try {
        const p = JSON.parse(raw);
        days = (_a = p.days) !== null && _a !== void 0 ? _a : [];
        hours = (_b = p.hours) !== null && _b !== void 0 ? _b : "";
    }
    catch ( /* keep defaults */_c) { /* keep defaults */ }
    await mergeOnboardingData(phone, { availability: { days, hours } });
    await updateSession(phone, { onboardingStep: "caregiver_ask_job_type" });
    const availIntro = await (0, caraMessage_1.generateCaraMessage)({
        audience: "caregiver",
        context: `Cara is onboarding a caregiver who just shared their availability${hours ? ` (${hours})` : ""}. ` +
            `Acknowledge it warmly in one short line, then lead into asking whether they want occasional, part-time, or ` +
            `full-time work. Do NOT list the numbered options yourself — Cara appends those on the next line.`,
        fallback: "Got it, thanks!",
        maxTokens: 60,
    });
    await (0, client_1.sendMessage)(chatId, `${availIntro}\n\nAre you looking for occasional fill-in shifts, part-time (less than 25 hrs/week), or full-time work?\n\n` +
        "Reply 1 for Occasional, 2 for Part-time, or 3 for Full-time.");
}
async function handleCaregiverAskRate(phone, chatId, text, session) {
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, "What's your hourly rate? Just a number works (e.g. \"22\").");
        return;
    }
    const raw = await parseWithClaude("Extract the hourly rate as a number from this message. Reply with just the number (e.g. 22). No dollar sign.", text);
    if (raw === "__parse_error__") {
        await (0, client_1.sendMessage)(chatId, "Hmm, I didn't catch that. What's your hourly rate? Just a number works (e.g. \"22\")");
        return;
    }
    const hourlyRate = parseFloat(raw);
    if (isNaN(hourlyRate) || hourlyRate < 5 || hourlyRate > 200) {
        await (0, client_1.sendMessage)(chatId, "Could you share your hourly rate as a number between $5 and $200? (e.g. \"22\")");
        return;
    }
    await mergeOnboardingData(phone, { hourlyRate });
    await updateSession(phone, { onboardingStep: "caregiver_ask_email" });
    const rateIntro = await (0, caraMessage_1.generateCaraMessage)({
        audience: "caregiver",
        context: `Cara is onboarding a caregiver who just set their rate at $${hourlyRate}/hr. Acknowledge it in one short, ` +
            `genuine line (no flattery clichés), then ask for their email address, mentioning it's used to set up their payout account.`,
        fallback: `$${hourlyRate}/hr works. What's your email address? I'll use it to set up your payout account.`,
        maxTokens: 70,
    });
    await (0, client_1.sendMessage)(chatId, rateIntro);
}
async function handleCaregiverAskJobType(phone, chatId, text, session) {
    var _a, _b, _c;
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, "Are you looking for occasional, part-time, or full-time work? Reply 1, 2, or 3.");
        return;
    }
    const raw = await parseWithClaude('"1", occasional, fill-in, as-needed, flexible, sometimes → occasional. ' +
        '"2", part-time, part time, a few days, some days → part_time. ' +
        '"3", full-time, full time, every day, all week → full_time. ' +
        'Reply with exactly one of: occasional, part_time, full_time', text);
    const jobType = ["occasional", "part_time", "full_time"].includes(raw) ? raw : "part_time";
    const jobTypeLabel = { occasional: "Occasional", part_time: "Part-time", full_time: "Full-time" };
    await mergeOnboardingData(phone, { jobType });
    await updateSession(phone, { onboardingStep: "caregiver_ask_rate" });
    const d = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
    const city = (_b = d.city) !== null && _b !== void 0 ? _b : "";
    await (0, client_1.sendMessage)(chatId, `${(_c = jobTypeLabel[jobType]) !== null && _c !== void 0 ? _c : "Got it"}! What's your hourly rate?\n\n` +
        (city ? `(Most caregivers in ${city} charge $18–28/hr)` : "(Most caregivers charge $18–28/hr)"));
}
async function handleCaregiverAskEmail(phone, chatId, text, session) {
    // For email, only treat as question if it doesn't even look like an email attempt —
    // skip the isQuestionOrOther LLM hop when there's a "@" in the trimmed text.
    const email = text.trim().toLowerCase();
    if (!email.includes("@") && await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, "What's your email address?");
        return;
    }
    if (!/\S+@\S+\.\S+/.test(email)) {
        await (0, client_1.sendMessage)(chatId, "That doesn't look like a valid email. Could you double-check? (e.g. name@example.com)");
        return;
    }
    await mergeOnboardingData(phone, { email });
    await updateSession(phone, { onboardingStep: "caregiver_ask_bio" });
    await (0, client_1.sendMessage)(chatId, "Got it, thank you. Last question before your photo — tell me about your approach to care in a sentence or two. Families will see this on your profile.");
}
async function handleCaregiverAskBio(phone, chatId, text, session) {
    // Only treat as question if the message is short (< 60 chars) — a bio that's
    // also a question is unlikely at this stage.
    if (text.trim().length < 60 && text.trim().toLowerCase() !== "skip" && await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, "Tell me about your approach to care in a sentence or two — or reply SKIP.");
        return;
    }
    const bio = text.trim().toLowerCase() === "skip" || text.trim().length < 10 ? "" : text.trim();
    await mergeOnboardingData(phone, { bio });
    await updateSession(phone, { onboardingStep: "caregiver_send_photo" });
    await handleCaregiverSendPhoto(phone, chatId, session);
}
// Called immediately after doc upload — ask before building the checkout so MVR can be bundled
async function handleCaregiverAskMvr(phone, chatId, textOrSession, session) {
    // When called as a switch case, textOrSession is the user's reply text
    // When called programmatically (no reply yet), textOrSession is the session object
    if (typeof textOrSession !== "string") {
        // First visit — ask the question
        await updateSession(phone, { onboardingStep: "caregiver_ask_mvr" });
        await (0, client_1.sendMessage)(chatId, "Do you transport clients to appointments or errands?\n\n" +
            "Adding a Motor Vehicle Record check to your profile shows families you're a verified driver. " +
            "It's an optional add-on you can include with your membership.\n\n" +
            "Reply YES to add it, or NO to skip.");
        return;
    }
    // User has replied — process their answer
    const norm = textOrSession.trim().toUpperCase();
    const wantsMvr = norm === "YES" || norm === "Y";
    await mergeOnboardingData(phone, { wantsMvr });
    await updateSession(phone, { onboardingStep: "caregiver_send_membership" });
    await handleCaregiverSendMembership(phone, chatId, session);
}
async function handleCaregiverSendMembership(phone, chatId, session) {
    var _a, _b, _c, _d, _e, _f, _g;
    const d = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
    const wantsMvr = (_b = d.wantsMvr) !== null && _b !== void 0 ? _b : false;
    const token = (0, tokenService_1.generateToken)({ phone, task: "caregiver_membership" });
    let checkoutUrl = `${APP_URL}/done?task=caregiver_membership&t=${token}`;
    await (0, client_1.signalThinking)(chatId, session.service);
    try {
        const membershipPriceId = (_e = (_d = (_c = process.env.STRIPE_CAREGIVER_ANNUAL_PRICE_ID) !== null && _c !== void 0 ? _c : process.env.STRIPE_CAREGIVER_ANNUAL) !== null && _d !== void 0 ? _d : process.env.VITE_STRIPE_CAREGIVER_ANNUAL) !== null && _e !== void 0 ? _e : "";
        const mvrPriceId = ((_f = process.env.STRIPE_MVR_PRICE_ID) !== null && _f !== void 0 ? _f : "").trim();
        if (membershipPriceId) {
            const lineItems = [
                { price: membershipPriceId, quantity: 1 },
            ];
            if (wantsMvr && mvrPriceId && !mvrPriceId.startsWith("FILL_IN")) {
                lineItems.push({ price: mvrPriceId, quantity: 1 });
            }
            // Recurring annual membership (mode "subscription" → renews yearly).
            // NOTE: STRIPE_CAREGIVER_ANNUAL must be a *recurring* annual price in Stripe.
            // The optional MVR add-on is a one-time price, added to the first invoice.
            const stripeSession = await getStripe().checkout.sessions.create({
                mode: "subscription",
                payment_method_types: ["card"],
                line_items: lineItems,
                success_url: `${APP_URL}/done?task=caregiver_membership&t=${token}`,
                cancel_url: `${APP_URL}/start`,
                metadata: { phone, task: "caregiver_membership", includeMVR: wantsMvr ? "true" : "false" },
                subscription_data: { metadata: { phone, kind: "caregiver_membership" } },
            });
            checkoutUrl = (_g = stripeSession.url) !== null && _g !== void 0 ? _g : checkoutUrl;
        }
    }
    catch (err) {
        console.error("handleCaregiverSendMembership stripe error:", err);
    }
    const mvrLine = wantsMvr
        ? "\n\nYour order includes the $24.95/yr membership + MVR driver check."
        : "";
    // Store URL on session so we can resend it
    await updateSession(phone, {
        onboardingStep: "caregiver_awaiting_membership",
        membershipCheckoutUrl: checkoutUrl,
    });
    await (0, client_1.sendMessage)(chatId, "You're almost ready to apply! Activate your membership ($24.95/year) to unlock applying to the " +
        `jobs near you, getting booked, and Cara's scheduling + payout tools.${mvrLine}\n\nTap to activate:`);
    await (0, client_1.sendMessage)(chatId, { parts: [{ type: "link", value: checkoutUrl }] });
}
async function handleCaregiverResendMembership(phone, chatId, session, text) {
    // If the caregiver replied with a question while waiting on Stripe, answer it
    // before resending the link.
    if (text && await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
    }
    const url = session.membershipCheckoutUrl;
    if (url) {
        await (0, client_1.sendMessage)(chatId, "Tap the link below to complete your membership payment:");
        await (0, client_1.sendMessage)(chatId, { parts: [{ type: "link", value: url }] });
    }
    else {
        // Re-generate if URL was lost
        await handleCaregiverSendMembership(phone, chatId, session);
    }
}
async function handleCaregiverSendPhoto(phone, chatId, session) {
    var _a;
    const token = (0, tokenService_1.generateToken)({ phone, task: "photo_upload" });
    const photoUrl = `${APP_URL}/upload/photo?t=${token}`;
    await updateSession(phone, { onboardingStep: "caregiver_awaiting_photo" });
    const d = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
    await (0, client_1.sendMessage)(chatId, `Almost there${d.name ? `, ${d.name}` : ""}. One more thing — families want to see who they're trusting.\n\n` +
        `Tap to add your profile photo:`);
    await (0, client_1.sendMessage)(chatId, { parts: [{ type: "link", value: photoUrl }] });
}
async function handleCaregiverSendDocuments(phone, chatId, session) {
    const token = (0, tokenService_1.generateToken)({ phone, task: "doc_upload" });
    const docUrl = `${APP_URL}/upload/document?t=${token}`;
    await updateSession(phone, { onboardingStep: "caregiver_awaiting_documents" });
    await (0, client_1.sendMessage)(chatId, "Do you have certifications to upload? (CNA license, CPR card, etc.)\n\nTap to upload, or reply SKIP:");
    await (0, client_1.sendMessage)(chatId, { parts: [{ type: "link", value: docUrl }] });
}
async function handleCaregiverSendBgcheck(phone, chatId, session) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
    let inviteUrl = `${APP_URL}/done?task=background_check`;
    await (0, client_1.signalThinking)(chatId, session.service);
    try {
        const d = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
        const nameParts = ((_b = d.name) !== null && _b !== void 0 ? _b : "").split(" ");
        // Use MVR package if caregiver paid for it; flag is set on session by stripe.ts webhook
        const mvrPaid = session.mvrPaid === true;
        const checkrPkg = mvrPaid
            ? ((_c = process.env.CHECKR_PACKAGE_MVR) !== null && _c !== void 0 ? _c : "tasker_standard")
            : ((_d = process.env.CHECKR_PACKAGE) !== null && _d !== void 0 ? _d : "tasker_standard");
        const resp = await axios_1.default.post("https://api.checkr.com/v1/invitations", {
            package: checkrPkg,
            first_name: (_e = nameParts[0]) !== null && _e !== void 0 ? _e : "",
            last_name: (_f = nameParts.slice(1).join(" ")) !== null && _f !== void 0 ? _f : "",
        }, { auth: { username: (_g = process.env.CHECKR_API_KEY) !== null && _g !== void 0 ? _g : "", password: "" } });
        inviteUrl = (_j = (_h = resp.data) === null || _h === void 0 ? void 0 : _h.invitation_url) !== null && _j !== void 0 ? _j : inviteUrl;
        // Pre-create the caregivers doc so the Checkr webhook can find this caregiver
        // by checkrCandidateId when the report comes back.
        const candidateId = ((_l = (_k = resp.data) === null || _k === void 0 ? void 0 : _k.candidate_id) !== null && _l !== void 0 ? _l : (_m = resp.data) === null || _m === void 0 ? void 0 : _m.id);
        if (candidateId && !session.caregiverId) {
            const caregiverRef = await db.collection("caregivers").add(Object.assign({ phone, status: "pending_review", createdAt: new Date().toISOString(), backgroundCheckData: {
                    checkrCandidateId: candidateId,
                    status: "pending",
                    submittedAt: new Date().toISOString(),
                    mvrIncluded: mvrPaid,
                } }, (mvrPaid && { mvrPaid: true })));
            await updateSession(phone, { caregiverId: caregiverRef.id });
        }
    }
    catch (err) {
        console.error("Checkr invitation error:", err);
    }
    await updateSession(phone, { onboardingStep: "caregiver_awaiting_bgcheck" });
    await (0, client_1.sendMessage)(chatId, "Almost done! A background check is required for all caregivers.\n\n" +
        "Tap to get started — usually takes about 5 minutes:");
    await (0, client_1.sendMessage)(chatId, { parts: [{ type: "link", value: inviteUrl }] });
    await (0, client_1.sendMessage)(chatId, "I'll text you when results come in (usually 1–3 days).");
}
// Re-issue a Checkr background-check link for an already-onboarded caregiver whose
// check expired / is expiring (they replied "RENEW" to the expiry nudge). Mirrors the
// onboarding invitation logic but updates the EXISTING caregiver doc instead of creating one.
async function sendBgCheckRenewalLink(phone, chatId, session) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
    let inviteUrl = `${APP_URL}/done?task=background_check`;
    try {
        // Resolve the caregiver's name: prefer the caregivers doc, fall back to session.
        let firstName = "";
        let lastName = "";
        const caregiverId = session.caregiverId;
        if (caregiverId) {
            const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
            const parts = ((_b = (_a = cgSnap.data()) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : "").split(" ");
            firstName = (_c = parts[0]) !== null && _c !== void 0 ? _c : "";
            lastName = parts.slice(1).join(" ");
        }
        if (!firstName) {
            const parts = ((_e = ((_d = session.onboardingData) !== null && _d !== void 0 ? _d : {}).name) !== null && _e !== void 0 ? _e : "").split(" ");
            firstName = (_f = parts[0]) !== null && _f !== void 0 ? _f : "";
            lastName = parts.slice(1).join(" ");
        }
        const checkrPkg = (_g = process.env.CHECKR_PACKAGE) !== null && _g !== void 0 ? _g : "tasker_standard";
        const resp = await axios_1.default.post("https://api.checkr.com/v1/invitations", { package: checkrPkg, first_name: firstName, last_name: lastName }, { auth: { username: (_h = process.env.CHECKR_API_KEY) !== null && _h !== void 0 ? _h : "", password: "" } });
        inviteUrl = (_k = (_j = resp.data) === null || _j === void 0 ? void 0 : _j.invitation_url) !== null && _k !== void 0 ? _k : inviteUrl;
        const candidateId = ((_m = (_l = resp.data) === null || _l === void 0 ? void 0 : _l.candidate_id) !== null && _m !== void 0 ? _m : (_o = resp.data) === null || _o === void 0 ? void 0 : _o.id);
        if (caregiverId) {
            await db.collection("caregivers").doc(caregiverId).update({
                "backgroundCheckData.checkrCandidateId": candidateId !== null && candidateId !== void 0 ? candidateId : null,
                "backgroundCheckData.status": "pending",
                "backgroundCheckData.submittedAt": new Date().toISOString(),
            }).catch(() => { });
        }
    }
    catch (err) {
        console.error("[sendBgCheckRenewalLink] Checkr invitation error:", err);
    }
    await (0, client_1.sendMessage)(chatId, "Here's your background check renewal link — usually about 5 minutes:");
    await (0, client_1.sendMessage)(chatId, { parts: [{ type: "link", value: inviteUrl }] });
    await (0, client_1.sendMessage)(chatId, "I'll text you the moment results come in (usually 1–3 days). Bookings stay paused until it clears.");
}
async function handleCaregiverSendStripeConnect(phone, chatId, session) {
    var _a, _b, _c;
    const token = (0, tokenService_1.generateToken)({ phone, task: "stripe_connect" });
    let connectUrl = `${APP_URL}/done?task=stripe_connect&t=${token}`;
    await (0, client_1.signalThinking)(chatId, session.service);
    try {
        const d = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
        const account = await getStripe().accounts.create({
            type: "express",
            country: "US",
            email: ((_b = d.email) !== null && _b !== void 0 ? _b : ""),
            metadata: { phone, caregiverName: ((_c = d.name) !== null && _c !== void 0 ? _c : "") },
        });
        const link = await getStripe().accountLinks.create({
            account: account.id,
            type: "account_onboarding",
            return_url: `${APP_URL}/done?task=stripe_connect&t=${token}`,
            refresh_url: `${APP_URL}/done?task=stripe_connect&t=${token}`,
        });
        connectUrl = link.url;
        await mergeOnboardingData(phone, { stripeAccountId: account.id });
    }
    catch (err) {
        console.error("Stripe Connect error:", err);
    }
    await updateSession(phone, { onboardingStep: "caregiver_awaiting_stripe" });
    await (0, client_1.sendMessage)(chatId, "Last step — set up your payout account so you can get paid after every visit:\n");
    await (0, client_1.sendMessage)(chatId, { parts: [{ type: "link", value: connectUrl }] });
}
async function sendOnboardingLink(phone, linkType) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u;
    const snap = await db.collection("agent_sessions").doc(phone).get();
    if (!snap.exists)
        throw new Error(`sendOnboardingLink: no session for ${phone}`);
    const session = snap.data();
    const chatId = session.chatId;
    if (!chatId)
        throw new Error(`sendOnboardingLink: no chatId for ${phone}`);
    const d = ((_a = session.onboardingData) !== null && _a !== void 0 ? _a : {});
    const caraPhone = encodeURIComponent((_b = process.env.LINQ_PHONE_NUMBER) !== null && _b !== void 0 ? _b : "");
    let url;
    switch (linkType) {
        case "client_identity": {
            url = await createClientIdentitySession(phone);
            break;
        }
        case "client_payment": {
            url = `${APP_URL}/payment/success?source=cara&caraPhone=${caraPhone}`;
            const stripeSession = await getStripe().checkout.sessions.create({
                mode: "setup",
                payment_method_types: ["card"],
                success_url: `${APP_URL}/payment/success?source=cara&caraPhone=${caraPhone}`,
                cancel_url: `${APP_URL}/start`,
                metadata: { phone, task: "client_payment_setup" },
            });
            url = (_c = stripeSession.url) !== null && _c !== void 0 ? _c : url;
            break;
        }
        case "caregiver_membership": {
            const stored = session.membershipCheckoutUrl;
            if (stored) {
                url = stored;
                break;
            }
            const token = (0, tokenService_1.generateToken)({ phone, task: "caregiver_membership" });
            url = `${APP_URL}/done?task=caregiver_membership&t=${token}`;
            const membershipPriceId = (_f = (_e = (_d = process.env.STRIPE_CAREGIVER_ANNUAL_PRICE_ID) !== null && _d !== void 0 ? _d : process.env.STRIPE_CAREGIVER_ANNUAL) !== null && _e !== void 0 ? _e : process.env.VITE_STRIPE_CAREGIVER_ANNUAL) !== null && _f !== void 0 ? _f : "";
            if (membershipPriceId) {
                const wantsMvr = (_g = d.wantsMvr) !== null && _g !== void 0 ? _g : false;
                const mvrPriceId = ((_h = process.env.STRIPE_MVR_PRICE_ID) !== null && _h !== void 0 ? _h : "").trim();
                const lineItems = [{ price: membershipPriceId, quantity: 1 }];
                if (wantsMvr && mvrPriceId && !mvrPriceId.startsWith("FILL_IN"))
                    lineItems.push({ price: mvrPriceId, quantity: 1 });
                const stripeSession = await getStripe().checkout.sessions.create({
                    mode: "subscription",
                    payment_method_types: ["card"],
                    line_items: lineItems,
                    success_url: `${APP_URL}/done?task=caregiver_membership&t=${token}`,
                    cancel_url: `${APP_URL}/start`,
                    metadata: { phone, task: "caregiver_membership", includeMVR: wantsMvr ? "true" : "false" },
                    subscription_data: { metadata: { phone, kind: "caregiver_membership" } },
                });
                url = (_j = stripeSession.url) !== null && _j !== void 0 ? _j : url;
            }
            await updateSession(phone, { membershipCheckoutUrl: url });
            break;
        }
        case "caregiver_photo": {
            url = `${APP_URL}/upload/photo?t=${(0, tokenService_1.generateToken)({ phone, task: "photo_upload" })}`;
            break;
        }
        case "caregiver_documents": {
            url = `${APP_URL}/upload/document?t=${(0, tokenService_1.generateToken)({ phone, task: "doc_upload" })}`;
            break;
        }
        case "caregiver_background_check": {
            const stored = session.bgcheckInviteUrl;
            if (stored) {
                url = stored;
                break;
            }
            url = `${APP_URL}/done?task=background_check`;
            const nameParts = ((_k = d.name) !== null && _k !== void 0 ? _k : "").split(" ");
            const mvrPaid = session.mvrPaid === true;
            const checkrPkg = mvrPaid
                ? ((_l = process.env.CHECKR_PACKAGE_MVR) !== null && _l !== void 0 ? _l : "tasker_standard")
                : ((_m = process.env.CHECKR_PACKAGE) !== null && _m !== void 0 ? _m : "tasker_standard");
            const resp = await axios_1.default.post("https://api.checkr.com/v1/invitations", { package: checkrPkg, first_name: (_o = nameParts[0]) !== null && _o !== void 0 ? _o : "", last_name: (_p = nameParts.slice(1).join(" ")) !== null && _p !== void 0 ? _p : "" }, { auth: { username: (_q = process.env.CHECKR_API_KEY) !== null && _q !== void 0 ? _q : "", password: "" } });
            url = (_s = (_r = resp.data) === null || _r === void 0 ? void 0 : _r.invitation_url) !== null && _s !== void 0 ? _s : url;
            await updateSession(phone, { bgcheckInviteUrl: url });
            break;
        }
        case "caregiver_payouts": {
            const token = (0, tokenService_1.generateToken)({ phone, task: "stripe_connect" });
            let accountId = d.stripeAccountId;
            if (!accountId) {
                const account = await getStripe().accounts.create({
                    type: "express",
                    country: "US",
                    email: ((_t = d.email) !== null && _t !== void 0 ? _t : ""),
                    metadata: { phone, caregiverName: ((_u = d.name) !== null && _u !== void 0 ? _u : "") },
                });
                accountId = account.id;
                await mergeOnboardingData(phone, { stripeAccountId: accountId });
            }
            const link = await getStripe().accountLinks.create({
                account: accountId,
                type: "account_onboarding",
                return_url: `${APP_URL}/done?task=stripe_connect&t=${token}`,
                refresh_url: `${APP_URL}/done?task=stripe_connect&t=${token}`,
            });
            url = link.url;
            break;
        }
        default:
            throw new Error(`sendOnboardingLink: unknown linkType ${linkType}`);
    }
    await (0, client_1.sendMessage)(chatId, { parts: [{ type: "link", value: url }] });
    return { success: true, linkType };
}
// ── Resend a stuck onboarding link (called by stale-session nudge after 7 days) ─
async function resendStuckStep(phone) {
    const snap = await db.collection("agent_sessions").doc(phone).get();
    if (!snap.exists)
        return false;
    const session = snap.data();
    const chatId = session.chatId;
    const step = session.onboardingStep;
    if (!chatId || !step)
        return false;
    switch (step) {
        case "caregiver_awaiting_bgcheck":
        case "caregiver_send_bgcheck": {
            // Re-send the Checkr invite link
            await updateSession(phone, { onboardingStep: "caregiver_send_bgcheck" });
            await handleCaregiverSendBgcheck(phone, chatId, session);
            return true;
        }
        case "caregiver_awaiting_stripe":
        case "caregiver_send_stripe_connect": {
            // Re-generate Stripe Connect link (creates new account if needed)
            await updateSession(phone, { onboardingStep: "caregiver_send_stripe_connect" });
            await handleCaregiverSendStripeConnect(phone, chatId, session);
            return true;
        }
        case "client_awaiting_payment":
        case "client_send_payment": {
            // Re-generate Stripe Checkout session
            await handleClientSendPayment(phone, chatId, session);
            return true;
        }
        default:
            return false;
    }
}
// ── Webhook-triggered step advancement ───────────────────────────────────────
// Called from stripe.ts and checkr.ts when webhooks fire
async function advanceOnboardingStep(phone, task, taskData) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1, _2, _3, _4, _5, _6;
    const snap = await db.collection("agent_sessions").doc(phone).get();
    if (!snap.exists)
        return;
    const session = snap.data();
    const chatId = session.chatId;
    if (!chatId) {
        console.error(`advanceOnboardingStep: missing chatId for phone=${phone}`);
        return;
    }
    // Idempotency: skip if this task was already processed for this session
    const processedTasks = (_a = session.processedWebhookTasks) !== null && _a !== void 0 ? _a : [];
    if (processedTasks.includes(task)) {
        console.info(`advanceOnboardingStep: skipping duplicate webhook task="${task}" for phone=${phone}`);
        return;
    }
    switch (task) {
        case "payment": {
            // Mark task processed before any writes to prevent race on retry
            await db.collection("agent_sessions").doc(phone).update({
                processedWebhookTasks: admin.firestore.FieldValue.arrayUnion(task),
            });
            const d = (_b = session.onboardingData) !== null && _b !== void 0 ? _b : {};
            // Get or create Firebase Auth UID (may already exist from identity step)
            let uid = session.userId;
            if (!uid) {
                try {
                    const userRecord = await admin.auth().getUserByPhoneNumber(phone);
                    uid = userRecord.uid;
                }
                catch (_7) {
                    try {
                        const newUser = await admin.auth().createUser({
                            phoneNumber: phone,
                            displayName: ((_c = d.firstName) !== null && _c !== void 0 ? _c : ""),
                        });
                        uid = newUser.uid;
                    }
                    catch (err) {
                        console.error("advanceOnboardingStep(payment) createUser error:", err);
                    }
                }
                if (uid)
                    await updateSession(phone, { userId: uid });
            }
            // Write subscription status to users/{uid} so web app shows membership as active
            if (uid) {
                await db.collection("users").doc(uid).set(Object.assign(Object.assign({ membershipStatus: "active", subscriptionActive: true }, (taskData ? { stripeSubscriptionId: taskData } : {})), { phone, firstName: ((_d = d.firstName) !== null && _d !== void 0 ? _d : ""), updatedAt: admin.firestore.FieldValue.serverTimestamp(), onboardingProgress: {
                        identityVerified: true,
                        membershipActive: true,
                    } }), { merge: true });
                // Write initial carePlans/{uid} with what we know so far
                const seniorName = ((_e = d.seniorName) !== null && _e !== void 0 ? _e : "");
                const firstName = seniorName.split(" ")[0] || seniorName;
                const relationship = ((_f = d.relationship) !== null && _f !== void 0 ? _f : "");
                const city = ((_g = d.city) !== null && _g !== void 0 ? _g : "");
                const zipCode = ((_h = d.zipCode) !== null && _h !== void 0 ? _h : "");
                const conditions = ((_j = d.conditions) !== null && _j !== void 0 ? _j : []);
                const careNeeds = ((_k = d.careNeeds) !== null && _k !== void 0 ? _k : []);
                const seniorAge = d.age;
                const recipientKey = `recipient_${firstName.toLowerCase().replace(/[^a-z0-9]/g, "_") || "primary"}`;
                await db.collection("carePlans").doc(uid).set({
                    clientId: uid,
                    phone,
                    recipientPlans: {
                        [recipientKey]: {
                            name: seniorName,
                            age: seniorAge,
                            relationship,
                            careNeeds,
                            conditions,
                            updatedAt: new Date().toISOString(),
                        },
                    },
                    locationPool: [{ city, zipCode, primary: true }],
                    updatedAt: new Date().toISOString(),
                }, { merge: true });
            }
            // Write intake to Firestore for admin records
            await db.collection("clientIntakes").add({
                phone,
                userId: uid !== null && uid !== void 0 ? uid : null,
                firstName: d.firstName,
                seniorName: d.seniorName,
                relationship: d.relationship,
                age: d.age,
                careNeeds: d.careNeeds,
                conditions: d.conditions,
                city: d.city,
                zipCode: d.zipCode,
                daysPerWeek: d.daysPerWeek,
                timeOfDay: d.timeOfDay,
                hoursPerDay: d.hoursPerDay,
                status: "pending",
                createdAt: new Date().toISOString(),
            });
            // Notify admin of new client signup
            (0, notifications_1.notifyAdminNewClientSignup)({
                clientId: uid !== null && uid !== void 0 ? uid : phone,
                firstName: ((_l = d.firstName) !== null && _l !== void 0 ? _l : ""),
                seniorName: ((_m = d.seniorName) !== null && _m !== void 0 ? _m : ""),
                phone,
                city: ((_o = d.city) !== null && _o !== void 0 ? _o : ""),
            }).catch((err) => console.error("notifyAdminNewClientSignup error:", err));
            // Initialize memory files with onboarding data
            (0, memoryFiles_1.initializeMemoryFiles)(uid !== null && uid !== void 0 ? uid : phone, {
                seniorName: d.seniorName,
                seniorAge: d.age,
                conditions: d.conditions,
                careNeeds: d.careNeeds,
                city: d.city,
                clientName: d.firstName,
                relationship: d.relationship,
            }).catch((err) => console.error("initializeMemoryFiles error:", err));
            Promise.all([
                (0, memoryFiles_1.writeMemoryFile)(uid !== null && uid !== void 0 ? uid : phone, "recent_episodes", `# Recent Episodes\n`),
                (0, memoryFiles_1.writeMemoryFile)(uid !== null && uid !== void 0 ? uid : phone, "procedural", `# Procedural Notes\n`),
            ]).catch((err) => console.error("initializeExtraMemoryFiles error:", err));
            (0, zepClient_1.pushOnboardingDataToZep)({
                phone,
                firstName: ((_p = d.firstName) !== null && _p !== void 0 ? _p : ""),
                seniorName: ((_q = d.seniorName) !== null && _q !== void 0 ? _q : ""),
                seniorAge: d.age ? Number(d.age) : undefined,
                conditions: Array.isArray(d.conditions) ? d.conditions : undefined,
                careNeeds: Array.isArray(d.careNeeds) ? d.careNeeds : undefined,
                city: d.city,
                relationship: d.relationship,
                daysPerWeek: d.daysPerWeek ? Number(d.daysPerWeek) : undefined,
                timeOfDay: d.timeOfDay,
            }).catch((err) => console.error("pushOnboardingDataToZep error:", err));
            // We already collected schedule, care needs, and budget during intake —
            // don't make them re-answer it all. Pre-fill the job post and ask for a
            // single confirmation (they can still choose to edit, which drops into the
            // full step-by-step flow).
            await presentPrefilledJobPost(phone, chatId, session);
            break;
        }
        case "photo_upload": {
            await updateSession(phone, { onboardingStep: "caregiver_send_documents" });
            await handleCaregiverSendDocuments(phone, chatId, session);
            break;
        }
        case "doc_upload": {
            await updateSession(phone, { onboardingStep: "caregiver_ask_mvr" });
            await handleCaregiverAskMvr(phone, chatId, session);
            break;
        }
        case "membership": {
            await db.collection("agent_sessions").doc(phone).update({
                processedWebhookTasks: admin.firestore.FieldValue.arrayUnion(task),
            });
            await updateSession(phone, { onboardingStep: "caregiver_send_bgcheck" });
            await (0, client_1.sendMessage)(chatId, "Payment received — thank you! Now for the final step: a background check is required for all caregivers.\n\n" +
                "Tap to get started — usually takes about 5 minutes:");
            await handleCaregiverSendBgcheck(phone, chatId, session);
            break;
        }
        case "background_check": {
            await db.collection("agent_sessions").doc(phone).update({
                processedWebhookTasks: admin.firestore.FieldValue.arrayUnion(task),
            });
            // Checkr came back clear → advance to Stripe Connect
            await updateSession(phone, { onboardingStep: "caregiver_send_stripe_connect" });
            await (0, client_1.sendMessage)(chatId, "Your background check came back clear.\n\n" +
                "One last step: set up your payout account so you can get paid after every visit.");
            await handleCaregiverSendStripeConnect(phone, chatId, session);
            break;
        }
        case "identity": {
            const step = (_r = session.onboardingStep) !== null && _r !== void 0 ? _r : "";
            if (step === "client_awaiting_identity") {
                // Ensure Firebase Auth account exists and get UID so we can write to users/{uid}
                let uid = session.userId;
                if (!uid) {
                    try {
                        const userRecord = await admin.auth().getUserByPhoneNumber(phone);
                        uid = userRecord.uid;
                    }
                    catch (_8) {
                        try {
                            const d = (_s = session.onboardingData) !== null && _s !== void 0 ? _s : {};
                            const newUser = await admin.auth().createUser({
                                phoneNumber: phone,
                                displayName: ((_t = d.firstName) !== null && _t !== void 0 ? _t : ""),
                            });
                            uid = newUser.uid;
                        }
                        catch (err) {
                            console.error("advanceOnboardingStep(identity) createUser error:", err);
                        }
                    }
                    if (uid)
                        await updateSession(phone, { userId: uid });
                }
                // Write identityCheckStatus to the web app's users doc
                if (uid) {
                    await db.collection("users").doc(uid).set({
                        identityCheckStatus: "verified",
                        identityVerifiedAt: admin.firestore.FieldValue.serverTimestamp(),
                        phone,
                        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    }, { merge: true });
                }
                // New order: plan/price was accepted before identity, so once identity
                // clears we go straight to collecting payment (card on file).
                await updateSession(phone, { onboardingStep: "client_send_payment" });
                await handleClientSendPayment(phone, chatId, session);
            }
            else if (step === "caregiver_awaiting_identity") {
                await updateSession(phone, { onboardingStep: "caregiver_send_bgcheck" });
                await handleCaregiverSendBgcheck(phone, chatId, session);
            }
            break;
        }
        case "stripe_connect": {
            // Mark processed first to prevent duplicate caregiver doc creation on retry
            await db.collection("agent_sessions").doc(phone).update({
                processedWebhookTasks: admin.firestore.FieldValue.arrayUnion(task),
            });
            // Caregiver Stripe Connect complete → finalize caregiver doc
            const d = (_u = session.onboardingData) !== null && _u !== void 0 ? _u : {};
            const profileData = {
                phone,
                name: d.name,
                city: d.city,
                zipCode: d.zipCode,
                yearsExperience: d.yearsExperience,
                certifications: d.certifications,
                specialties: d.specialties,
                availability: d.availability,
                hourlyRate: d.hourlyRate,
                stripeAccountId: d.stripeAccountId,
                email: (_v = d.email) !== null && _v !== void 0 ? _v : null,
                bio: (_w = d.bio) !== null && _w !== void 0 ? _w : null,
                jobType: (_x = d.jobType) !== null && _x !== void 0 ? _x : null,
                gender: (_y = d.gender) !== null && _y !== void 0 ? _y : null,
                languages: Array.isArray(d.languages) ? d.languages : [],
                canDrive: (_z = d.canDrive) !== null && _z !== void 0 ? _z : null,
                membershipSubscriptionId: (_0 = session.caregiverSubscriptionId) !== null && _0 !== void 0 ? _0 : null,
                status: "active",
            };
            let caregiverId;
            if (session.caregiverId) {
                // Doc was pre-created during bg check — update it with full profile
                await db.collection("caregivers").doc(session.caregiverId).update(profileData);
                caregiverId = session.caregiverId;
            }
            else {
                const caregiverRef = await db.collection("caregivers").add(Object.assign(Object.assign({}, profileData), { createdAt: new Date().toISOString() }));
                caregiverId = caregiverRef.id;
            }
            await updateSession(phone, {
                caregiverId,
                onboardingStep: "caregiver_ask_permissions",
            });
            // Waitlist trigger: a new active caregiver just landed. Notify any families
            // we honestly held (awaitingSupply) in this caregiver's city that care is
            // now available, and clear the flag so they're not pinged twice.
            notifyWaitlistedFamilies((_1 = d.city) !== null && _1 !== void 0 ? _1 : "").catch((err) => console.error("notifyWaitlistedFamilies error:", err));
            // Silently create Firebase Auth account so web dashboard login works later
            await createFirebaseAuthAccount(phone, ((_2 = d.name) !== null && _2 !== void 0 ? _2 : ""));
            // Notify admin
            (0, notifications_1.notifyAdminNewCaregiverSignup)({
                caregiverId,
                name: ((_3 = d.name) !== null && _3 !== void 0 ? _3 : ""),
                phone,
                city: ((_4 = d.city) !== null && _4 !== void 0 ? _4 : ""),
            }).catch((err) => console.error("notifyAdminNewCaregiverSignup error:", err));
            await db.collection("admin_alerts").add({
                type: "new_caregiver_signup",
                caregiverId,
                name: d.name,
                phone,
                createdAt: new Date().toISOString(),
                resolved: false,
            });
            // Push caregiver profile to Zep knowledge graph
            (0, zepClient_1.addBusinessDataToZep)({
                userId: (0, zepClient_1.getZepUserId)(phone),
                data: {
                    user_type: "caregiver",
                    user_name: ((_5 = d.name) !== null && _5 !== void 0 ? _5 : ""),
                    caregiver_city: d.city,
                    caregiver_years_experience: d.yearsExperience,
                    caregiver_specialties: Array.isArray(d.specialties) ? d.specialties : [],
                    caregiver_availability: d.availability,
                    caregiver_hourly_rate: d.hourlyRate,
                    caregiver_certifications: Array.isArray(d.certifications) ? d.certifications : [],
                    data_source: "cara_caregiver_onboarding",
                    timestamp: new Date().toISOString(),
                },
            }).catch((err) => console.error("addBusinessDataToZep caregiver error:", err));
            // Warm "you're approved" milestone message before handing off to permissions
            const firstName = ((_6 = d.name) !== null && _6 !== void 0 ? _6 : "").split(" ")[0] || "you";
            const specialties = Array.isArray(d.specialties) ? d.specialties.join(", ") : "";
            const activationMsg = await (0, caraMessage_1.generateCaraMessage)({
                audience: "caregiver",
                context: `Caregiver first name: ${firstName}. ` +
                    `Their background check came back clear and they just finished setting up payouts — they're now fully approved and active. ` +
                    `${specialties ? `Their specialties: ${specialties}. ` : ""}` +
                    `Write a warm 2-3 sentence "you're approved" celebration message. Reassure them their profile is live, ` +
                    `mention they'll start getting matched with families soon, and that I'll text them as new jobs come in. ` +
                    `Sound genuinely happy for them.`,
                fallback: `🎉 You're approved, ${firstName}! Your profile is live and I'll start matching you with families that need help. ` +
                    `Watch for job alerts here — reply YES to any that interest you. Welcome to CareConnex!`,
                maxTokens: 180,
            });
            await (0, client_1.sendMessage)(chatId, activationMsg);
            const { sendCaregiverPermissionsFlow } = await Promise.resolve().then(() => __importStar(require("./permissionsConversation")));
            await sendCaregiverPermissionsFlow(phone, chatId, session, d.name);
            break;
        }
    }
}
// ── JOB POSTING FLOW ──────────────────────────────────────────────────────────
// Triggered after client pays membership. Mirrors the 6-step PostJobFlow web
// form and writes to the same Firestore collections so the web dashboard syncs.
// Map an intake time-of-day phrase to the job post's slot enum.
function mapTimeOfDayToSlots(tod) {
    const t = (tod || "").toLowerCase();
    if (t.includes("all") || t.includes("any"))
        return ["Morning", "Afternoon", "Evening"];
    const slots = [];
    if (t.includes("morning") || t.includes("am"))
        slots.push("Morning");
    if (t.includes("afternoon") || t.includes("noon"))
        slots.push("Afternoon");
    if (t.includes("evening") || t.includes("night") || t.includes("pm"))
        slots.push("Evening");
    if (t.includes("overnight") || t.includes("24"))
        slots.push("Overnight");
    return slots.length ? slots : ["Morning"];
}
// Derive a ready-to-post job draft from the intake we ALREADY collected, so the
// client confirms once instead of re-answering schedule/needs/budget after paying.
function deriveJobDataFromIntake(d) {
    var _a, _b, _c, _d;
    const daysPerWeek = Number((_a = d.daysPerWeek) !== null && _a !== void 0 ? _a : 0);
    const frequency = daysPerWeek >= 5 ? "full_time" : daysPerWeek >= 3 ? "part_time" : "occasional";
    const conditions = (Array.isArray(d.conditions) ? d.conditions : []);
    const careNeeds = (Array.isArray(d.careNeeds) ? d.careNeeds : []);
    const heavy = [...conditions, ...careNeeds].join(" ").toLowerCase();
    const careLevel = /dementia|alzheimer|medical|wound|catheter|feeding|insulin/.test(heavy)
        ? "intensive"
        : (careNeeds.length || conditions.length) ? "moderate" : "light";
    const budgetMax = Number((_b = d.budgetMax) !== null && _b !== void 0 ? _b : 0);
    const budgetMin = Number((_c = d.budgetMin) !== null && _c !== void 0 ? _c : 0);
    const hourlyRate = budgetMax || budgetMin || "flexible";
    return {
        jobStartDate: d.startDate || "ASAP",
        jobFrequency: frequency,
        jobDays: [],
        jobTimeOfDay: mapTimeOfDayToSlots((_d = d.timeOfDay) !== null && _d !== void 0 ? _d : ""),
        jobCareNeeds: careNeeds.length ? careNeeds : conditions,
        jobCareLevel: careLevel,
        jobHourlyRate: hourlyRate,
        jobPaymentMethod: "card",
        petsInHome: false,
        smokingHousehold: false,
    };
}
async function presentPrefilledJobPost(phone, chatId, session) {
    var _a, _b;
    const d = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
    const jobData = deriveJobDataFromIntake(d);
    await mergeOnboardingData(phone, jobData);
    await updateSession(phone, { onboardingStep: "job_confirm_prefill" });
    const seniorName = (_b = d.seniorName) !== null && _b !== void 0 ? _b : "your loved one";
    const freqMap = { occasional: "Occasional", part_time: "Part-time", full_time: "Full-time" };
    const rateLabel = jobData.jobHourlyRate === "flexible" ? "flexible rate" : `$${jobData.jobHourlyRate}/hr`;
    const needs = jobData.jobCareNeeds.join(", ") || "general care";
    await (0, client_1.sendMessage)(chatId, `Membership active — thank you! I'll post ${seniorName}'s care request using what you already told me:\n\n` +
        `📅 Start ${jobData.jobStartDate} · ${freqMap[jobData.jobFrequency]} · ${jobData.jobTimeOfDay.join(", ")}\n` +
        `💛 ${needs}\n` +
        `💰 ${rateLabel}\n\n` +
        `Want me to post it as-is? Reply YES, or tell me what to change.`);
}
async function handleJobConfirmPrefill(phone, chatId, text, session) {
    var _a, _b, _c;
    const intent = await parseWithClaude('"yes","yep","post it","go","looks good","sounds good","sure","ok","perfect" → confirm. ' +
        'Anything that asks to change/edit a detail, or says no → edit. Reply with exactly one word: confirm or edit.', text);
    if (intent !== "confirm") {
        // Let them adjust everything via the detailed step-by-step flow.
        await updateSession(phone, { onboardingStep: "job_ask_start" });
        await (0, client_1.sendMessage)(chatId, "No problem — let's set it up together.");
        await handleJobAskStart(phone, chatId, "", session);
        return;
    }
    const uid = session.userId;
    if (!uid) {
        await updateSession(phone, { onboardingStep: "job_ask_start" });
        await handleJobAskStart(phone, chatId, "", session);
        return;
    }
    try {
        const refreshed = await db.collection("agent_sessions").doc(phone).get();
        const onboarding = ((_b = (_a = refreshed.data()) === null || _a === void 0 ? void 0 : _a.onboardingData) !== null && _b !== void 0 ? _b : {});
        const jobId = await (0, buildJobPost_1.buildAndSaveJobPost)({ uid, phone, onboardingData: onboarding, jobData: onboarding });
        const city = (_c = onboarding.city) !== null && _c !== void 0 ? _c : "your area";
        await updateSession(phone, { onboardingStep: "client_ask_permissions" });
        await (0, client_1.sendMessage)(chatId, `Your care request is live! 🎉 I've notified caregivers within 25 miles of ${city} and I'll message you the moment someone applies.`);
        const { sendClientPermissionsFlow } = await Promise.resolve().then(() => __importStar(require("./permissionsConversation")));
        const freshSnap = await db.collection("agent_sessions").doc(phone).get();
        await sendClientPermissionsFlow(phone, chatId, freshSnap.data());
        console.log(`[handleJobConfirmPrefill] Job posted: ${jobId} for uid=${uid}`);
    }
    catch (err) {
        console.error("[handleJobConfirmPrefill] buildAndSaveJobPost error:", err);
        await (0, client_1.sendMessage)(chatId, "There was a problem posting your request — our team has been notified. You can also post it at " + APP_URL + "/client/post-job");
    }
}
async function handleJobAskStart(phone, chatId, _text, session) {
    var _a, _b;
    const d = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
    await (0, client_1.sendMessage)(chatId, `Your membership is active! 🎉 Let's find the perfect caregiver for ${(_b = d.seniorName) !== null && _b !== void 0 ? _b : "your loved one"}.\n\n` +
        `When would you like care to start? (e.g. "next Monday", "ASAP", "June 1")`);
    await updateSession(phone, { onboardingStep: "job_ask_frequency" });
}
async function handleJobAskFrequency(phone, chatId, text, session) {
    const startDate = await parseWithClaude("Extract a start date from this message. If the user says 'ASAP' or similar, return 'ASAP'. " +
        "Otherwise return the date in YYYY-MM-DD format if possible, or a plain text description. Reply with just the date value.", text);
    await mergeOnboardingData(phone, { jobStartDate: startDate !== "__parse_error__" ? startDate : text.trim() });
    await updateSession(phone, { onboardingStep: "job_ask_days" });
    await (0, client_1.sendMessage)(chatId, "How often do you need help?\n\n" +
        "1️⃣  Occasional (1–2 days/week)\n" +
        "2️⃣  Part-time (3–4 days/week)\n" +
        "3️⃣  Full-time (5+ days/week)");
}
async function handleJobAskDays(phone, chatId, text, session) {
    var _a;
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, "How often do you need help?\n\n" +
            "1️⃣  Occasional (1–2 days/week)\n" +
            "2️⃣  Part-time (3–4 days/week)\n" +
            "3️⃣  Full-time (5+ days/week)");
        return;
    }
    const raw = await parseWithClaude('Classify the care frequency. "1", occasional, 1-2 days = occasional. ' +
        '"2", part-time, part time, 3-4 days = part_time. ' +
        '"3", full-time, full time, every day, 5+ days = full_time. ' +
        'Reply with exactly one of: occasional, part_time, full_time', text);
    const frequency = ["occasional", "part_time", "full_time"].includes(raw) ? raw : "occasional";
    const freqLabel = { occasional: "Occasional", part_time: "Part-time", full_time: "Full-time" };
    await mergeOnboardingData(phone, { jobFrequency: frequency });
    await updateSession(phone, { onboardingStep: "job_ask_time" });
    await (0, client_1.sendMessage)(chatId, `${(_a = freqLabel[frequency]) !== null && _a !== void 0 ? _a : "Got it"}! Which days work best?\n\n(e.g. "Mon, Wed, Fri" or "weekdays" or "every day")`);
}
async function handleJobAskTime(phone, chatId, text, session) {
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, "Which days work best? (e.g. \"Mon, Wed, Fri\" or \"weekdays\")");
        return;
    }
    const raw = await parseWithClaude('Extract days of the week as a JSON array using full names (Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday). ' +
        '"weekdays" or "mon-fri" = ["Monday","Tuesday","Wednesday","Thursday","Friday"]. ' +
        '"weekends" = ["Saturday","Sunday"]. ' +
        '"every day" or "daily" = all 7 days. ' +
        'Return only a JSON array, nothing else.', text);
    let days = [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0)
            days = parsed;
    }
    catch ( /**/_a) { /**/ }
    if (days.length === 0)
        days = ["Monday", "Wednesday", "Friday"];
    await mergeOnboardingData(phone, { jobDays: days });
    await updateSession(phone, { onboardingStep: "job_ask_care_needs" });
    await (0, client_1.sendMessage)(chatId, `${days.length === 7 ? "Every day" : days.join(", ")} — perfect! What time of day works best?\n\n` +
        "Reply with one or more numbers:\n\n" +
        "1️⃣  Morning (6am–noon)\n" +
        "2️⃣  Afternoon (noon–6pm)\n" +
        "3️⃣  Evening (6pm–10pm)\n" +
        "4️⃣  Overnight");
}
async function handleJobAskCareNeeds(phone, chatId, text, session) {
    var _a, _b;
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, "What time of day works best?\n\n" +
            "1️⃣  Morning  2️⃣  Afternoon  3️⃣  Evening  4️⃣  Overnight");
        return;
    }
    const raw = await parseWithClaude('Extract the times of day as a JSON array. Valid values: "Morning", "Afternoon", "Evening", "Overnight". ' +
        '"1" or "morning" or "am" → Morning. "2" or "afternoon" or "noon" → Afternoon. ' +
        '"3" or "evening" or "night" or "pm" → Evening. "4" or "overnight" or "24" → Overnight. ' +
        'Return only a JSON array of matching values.', text);
    let timeOfDay = [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0)
            timeOfDay = parsed;
    }
    catch ( /**/_c) { /**/ }
    if (timeOfDay.length === 0)
        timeOfDay = ["Morning"];
    const d = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
    await mergeOnboardingData(phone, { jobTimeOfDay: timeOfDay });
    await updateSession(phone, { onboardingStep: "job_ask_care_level" });
    await (0, client_1.sendMessage)(chatId, `Got it — ${timeOfDay.join(" & ")}! What kind of help does ${(_b = d.seniorName) !== null && _b !== void 0 ? _b : "your loved one"} need?\n\n` +
        "Reply with numbers (pick all that apply):\n\n" +
        "1️⃣  Mobility & Movement\n" +
        "2️⃣  Memory Care / Dementia\n" +
        "3️⃣  Medications\n" +
        "4️⃣  Personal Care (bathing, dressing)\n" +
        "5️⃣  Meals & Nutrition\n" +
        "6️⃣  Transportation\n" +
        "7️⃣  Light Housekeeping\n" +
        "8️⃣  Companionship");
}
async function handleJobAskCareLevel(phone, chatId, text, session) {
    var _a, _b, _c, _d;
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        const d2 = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
        await (0, client_1.sendMessage)(chatId, `What kind of help does ${(_b = d2.seniorName) !== null && _b !== void 0 ? _b : "your loved one"} need? Reply with numbers.`);
        return;
    }
    const NEEDS_MAP = {
        "1": "Mobility & Movement", "2": "Memory Care / Dementia",
        "3": "Medications", "4": "Personal Care",
        "5": "Meals & Nutrition", "6": "Transportation",
        "7": "Light Housekeeping", "8": "Companionship",
    };
    const raw = await parseWithClaude('Return a JSON array of care need numbers that match the user\'s message. ' +
        '1=Mobility, 2=Memory Care/Dementia, 3=Medications, 4=Personal Care (bathing/dressing), ' +
        '5=Meals/Nutrition, 6=Transportation, 7=Housekeeping, 8=Companionship. ' +
        'Match by number or keyword. Return only a JSON array of number strings like ["1","3"].', text);
    let careNeeds = [];
    try {
        const nums = JSON.parse(raw);
        if (Array.isArray(nums))
            careNeeds = nums.map(n => NEEDS_MAP[n]).filter(Boolean);
    }
    catch ( /**/_e) { /**/ }
    if (careNeeds.length === 0)
        careNeeds = ["Companionship"];
    const d = (_c = session.onboardingData) !== null && _c !== void 0 ? _c : {};
    await mergeOnboardingData(phone, { jobCareNeeds: careNeeds });
    await updateSession(phone, { onboardingStep: "job_ask_environment" });
    await (0, client_1.sendMessage)(chatId, `Noted — ${careNeeds.join(", ")}. How much support does ${(_d = d.seniorName) !== null && _d !== void 0 ? _d : "your loved one"} need overall?\n\n` +
        "1️⃣  Light — mostly supervision & companionship\n" +
        "2️⃣  Moderate — hands-on help with some tasks\n" +
        "3️⃣  Intensive — full assistance with most tasks");
}
async function handleJobAskEnvironment(phone, chatId, text, session) {
    var _a;
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, "How much support is needed?\n1️⃣ Light  2️⃣ Moderate  3️⃣ Intensive");
        return;
    }
    const raw = await parseWithClaude('"1", light, supervision, minimal, companion = light. ' +
        '"2", moderate, some help, hands-on = moderate. ' +
        '"3", intensive, full assist, full help, a lot = intensive. ' +
        'Reply with exactly one of: light, moderate, intensive', text);
    const careLevel = ["light", "moderate", "intensive"].includes(raw) ? raw : "moderate";
    const levelLabel = { light: "Light", moderate: "Moderate", intensive: "Intensive" };
    await mergeOnboardingData(phone, { jobCareLevel: careLevel });
    await updateSession(phone, { onboardingStep: "job_ask_rate" });
    await (0, client_1.sendMessage)(chatId, `${(_a = levelLabel[careLevel]) !== null && _a !== void 0 ? _a : "Got it"}. Two quick things about the home: Are there pets? Is it a smoking household?\n\n` +
        `(e.g. "dog, non-smoking" or "no pets, non-smoking")`);
}
async function handleJobAskRate(phone, chatId, text, session) {
    var _a, _b;
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, "Are there pets in the home? Is it a smoking household?");
        return;
    }
    const rawPets = await parseWithClaude('Does the user mention pets (dog, cat, pet, bird, animal) in a positive sense (not "no pet")? Reply yes or no.', text);
    const rawSmoke = await parseWithClaude('Does the user mention smoking in a positive sense (not "non-smoking", "no smoking")? Reply yes or no.', text);
    const petsInHome = rawPets.toLowerCase().startsWith("yes");
    const smokingHousehold = rawSmoke.toLowerCase().startsWith("yes");
    const petsLabel = petsInHome ? "pets in home" : "no pets";
    const smokeLabel = smokingHousehold ? "smoking household" : "non-smoking";
    const d = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
    const city = (_b = d.city) !== null && _b !== void 0 ? _b : "";
    await mergeOnboardingData(phone, { petsInHome, smokingHousehold });
    await updateSession(phone, { onboardingStep: "job_ask_pay_method" });
    await (0, client_1.sendMessage)(chatId, `Got it — ${petsLabel}, ${smokeLabel}. What hourly rate are you hoping to pay?\n\n` +
        (city
            ? `Most families in ${city} pay $18–$28/hr. Reply with a number or "flexible".`
            : `Most families pay $18–$28/hr. Reply with a number or "flexible".`));
}
async function handleJobAskPayMethod(phone, chatId, text, session) {
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, "What hourly rate are you hoping to pay? (or \"flexible\")");
        return;
    }
    const raw = await parseWithClaude('Extract an hourly pay rate. If the user says flexible, open, negotiable, or similar, return "flexible". ' +
        'Otherwise extract just the number (e.g. 20, 22.50). Return only the number or the word flexible.', text);
    let hourlyRate = "flexible";
    if (raw !== "flexible") {
        const n = parseFloat(raw);
        if (!isNaN(n) && n >= 5 && n <= 200)
            hourlyRate = n;
    }
    const rateLabel = hourlyRate === "flexible" ? "flexible rate" : `$${hourlyRate}/hr`;
    await mergeOnboardingData(phone, { jobHourlyRate: hourlyRate });
    await updateSession(phone, { onboardingStep: "job_ask_description" });
    await (0, client_1.sendMessage)(chatId, `${rateLabel} — sounds good! How will you pay the caregiver?\n\n` +
        "1️⃣  Credit/debit card\n" +
        "2️⃣  Cash directly");
}
async function handleJobAskDescription(phone, chatId, text, session) {
    var _a, _b;
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, "How will you pay the caregiver?\n1️⃣ Card  2️⃣ Cash");
        return;
    }
    const raw = await parseWithClaude('"1", card, credit, debit, stripe = card. "2", cash, direct, hand = cash. ' +
        'Reply with exactly one of: card, cash', text);
    const paymentMethod = raw === "cash" ? "cash" : "card";
    const payLabel = paymentMethod === "cash" ? "Cash" : "Card";
    const d = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
    await mergeOnboardingData(phone, { jobPaymentMethod: paymentMethod });
    await updateSession(phone, { onboardingStep: "job_confirm_post" });
    await (0, client_1.sendMessage)(chatId, `${payLabel} — perfect! Last step: in 1–3 sentences, describe a typical day of care for ` +
        `${(_b = d.seniorName) !== null && _b !== void 0 ? _b : "your loved one"}. What should a caregiver know?`);
}
async function handleJobConfirmPost(phone, chatId, text, session) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
    const norm = text.trim().toUpperCase();
    // If this is the first time we're here, store description and show summary
    const d = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
    if (!d.jobDescription) {
        await mergeOnboardingData(phone, { jobDescription: text.trim() });
        // Refresh onboarding data after merge
        const refreshed = await db.collection("agent_sessions").doc(phone).get();
        const rd = ((_c = (_b = refreshed.data()) === null || _b === void 0 ? void 0 : _b.onboardingData) !== null && _c !== void 0 ? _c : {});
        const rateLabel = rd.jobHourlyRate === "flexible" ? "flexible rate" : `$${rd.jobHourlyRate}/hr`;
        const payLabel = rd.jobPaymentMethod === "cash" ? "cash" : "card";
        const daysArr = Array.isArray(rd.jobDays) ? rd.jobDays.join(", ") : "—";
        const timeArr = Array.isArray(rd.jobTimeOfDay) ? rd.jobTimeOfDay.join(", ") : "—";
        const needsArr = Array.isArray(rd.jobCareNeeds) ? rd.jobCareNeeds.join(", ") : "—";
        const levelLabel = (_d = rd.jobCareLevel) !== null && _d !== void 0 ? _d : "moderate";
        const startLabel = (_e = rd.jobStartDate) !== null && _e !== void 0 ? _e : "ASAP";
        const frequencyMap = { occasional: "Occasional", part_time: "Part-time", full_time: "Full-time" };
        const freqLabel = (_g = frequencyMap[(_f = rd.jobFrequency) !== null && _f !== void 0 ? _f : "occasional"]) !== null && _g !== void 0 ? _g : "Occasional";
        await (0, client_1.sendMessage)(chatId, `Here's your care request:\n\n` +
            `📅 Starting ${startLabel} · ${freqLabel} · ${daysArr} · ${timeArr}\n` +
            `🏠 ${(_h = rd.city) !== null && _h !== void 0 ? _h : "—"}, ${(_j = rd.zipCode) !== null && _j !== void 0 ? _j : ""}\n` +
            `💛 ${needsArr}\n` +
            `📊 ${levelLabel.charAt(0).toUpperCase() + levelLabel.slice(1)} care\n` +
            `💰 ${rateLabel} · ${payLabel}\n\n` +
            `Shall I post this? Reply YES to go live, or NO to make a change.`);
        return;
    }
    // User replied YES/NO to the confirmation
    if (norm === "YES" || norm === "Y" || norm === "YEP" || norm === "SURE" || norm === "OK" || norm === "OKAY") {
        const uid = session.userId;
        if (!uid) {
            await (0, client_1.sendMessage)(chatId, "Something went wrong — please try again or head to the app to complete your care request.");
            return;
        }
        try {
            const refreshed = await db.collection("agent_sessions").doc(phone).get();
            const jobData = ((_l = (_k = refreshed.data()) === null || _k === void 0 ? void 0 : _k.onboardingData) !== null && _l !== void 0 ? _l : {});
            const onboarding = jobData; // same object holds both
            const jobId = await (0, buildJobPost_1.buildAndSaveJobPost)({ uid, phone, onboardingData: onboarding, jobData: onboarding });
            const city = (_m = onboarding.city) !== null && _m !== void 0 ? _m : "your area";
            await updateSession(phone, { onboardingStep: "client_ask_permissions" });
            await (0, client_1.sendMessage)(chatId, `Your care request is live! 🎉\n\n` +
                `I've notified caregivers within 25 miles of ${city}. ` +
                `I'll message you as soon as someone applies!\n\n` +
                `You can also browse caregivers and manage everything at ${APP_URL}/client/dashboard`);
            // Move to permissions after a short pause
            const { sendClientPermissionsFlow } = await Promise.resolve().then(() => __importStar(require("./permissionsConversation")));
            const freshSnap = await db.collection("agent_sessions").doc(phone).get();
            await sendClientPermissionsFlow(phone, chatId, freshSnap.data());
            console.log(`[handleJobConfirmPost] Job posted: ${jobId} for uid=${uid}`);
        }
        catch (err) {
            console.error("[handleJobConfirmPost] buildAndSaveJobPost error:", err);
            await (0, client_1.sendMessage)(chatId, "There was a problem posting your request — our team has been notified. Try again or visit " + APP_URL + "/client/post-job");
        }
    }
    else if (norm === "NO" || norm === "N" || norm === "NOPE") {
        // Clear description so the summary won't re-fire and restart from the top
        await db.collection("agent_sessions").doc(phone).update({
            "onboardingData.jobDescription": admin.firestore.FieldValue.delete(),
            onboardingStep: "job_ask_start",
        });
        await (0, client_1.sendMessage)(chatId, "No problem! Let's go through it again. When would you like care to start?");
    }
    else {
        await (0, client_1.sendMessage)(chatId, "Just reply YES to post or NO to make a change.");
    }
}
// ── Mid-flow question answering ───────────────────────────────────────────────
async function answerQuestionMidFlow(text, session) {
    var _a, _b, _c;
    const d = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
    return (await (0, openaiClient_1.quickComplete)("You are Cara, an AI care assistant. " +
        "A user is in the middle of signing up and has a question. " +
        `Context: they are ${session.userType === "caregiver" ? "a caregiver looking for work" : "a family member looking for care"}. ` +
        `Name: ${((_c = (_b = d.name) !== null && _b !== void 0 ? _b : d.firstName) !== null && _c !== void 0 ? _c : "")}. ` +
        "Answer briefly (1–2 sentences). Be warm and helpful.", text, { maxTokens: 100 })).trim();
}
//# sourceMappingURL=onboardingConversation.js.map