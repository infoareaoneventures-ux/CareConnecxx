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
exports.resendStuckStep = resendStuckStep;
exports.advanceOnboardingStep = advanceOnboardingStep;
const admin = __importStar(require("firebase-admin"));
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const axios_1 = __importDefault(require("axios"));
const stripe_1 = __importDefault(require("stripe"));
const client_1 = require("../linq/client");
const tokenService_1 = require("./tokenService");
const notifications_1 = require("../notifications");
const memoryFiles_1 = require("../memory/memoryFiles");
const zepClient_1 = require("../memory/zepClient");
const buildJobPost_1 = require("./buildJobPost");
const db = admin.firestore();
let _claude = null;
function getClaude() {
    if (!_claude)
        _claude = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    return _claude;
}
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
async function parseWithClaude(prompt, userText) {
    var _a;
    try {
        const response = await getClaude().messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 200,
            system: prompt,
            messages: [{ role: "user", content: userText }],
        });
        return ((_a = response.content[0].text) !== null && _a !== void 0 ? _a : "").trim();
    }
    catch (_b) {
        return "__parse_error__";
    }
}
async function isQuestionOrOther(text) {
    const result = await parseWithClaude('Reply YES if this is a general question or off-topic comment. Reply NO if it is an answer to the question asked. Only reply YES or NO.', text);
    return result.toUpperCase().startsWith("Y");
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
async function handleOnboardingStep(phone, chatId, text, session) {
    var _a, _b;
    const step = (_a = session.onboardingStep) !== null && _a !== void 0 ? _a : "";
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
    // Mid-flow correction: "actually my name is X", "sorry, my city is Y"
    // Only applies once user has started answering (not on ask_role)
    if (step !== "ask_role" && !step.endsWith("_send_payment") && !step.endsWith("_awaiting_payment")
        && !step.endsWith("_send_photo") && !step.endsWith("_awaiting_photo")
        && !step.endsWith("_send_documents") && !step.endsWith("_awaiting_documents")
        && !step.endsWith("_send_bgcheck") && !step.endsWith("_awaiting_bgcheck")
        && !step.endsWith("_send_stripe_connect") && !step.endsWith("_awaiting_stripe")
        && !step.endsWith("_send_membership") && !step.endsWith("_awaiting_membership")
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
            const repeat = (_b = stepMessages[step]) !== null && _b !== void 0 ? _b : "Could you continue where we left off?";
            await (0, client_1.sendMessage)(chatId, `Got it — updated.\n\n${repeat}`);
            return;
        }
    }
    // Route to the appropriate step handler
    switch (step) {
        case "ask_role": return handleAskRole(phone, chatId, text);
        case "client_ask_name": return handleClientAskName(phone, chatId, text, session);
        case "client_ask_senior": return handleClientAskSenior(phone, chatId, text, session);
        case "client_ask_needs": return handleClientAskNeeds(phone, chatId, text, session);
        case "client_ask_location": return handleClientAskLocation(phone, chatId, text, session);
        case "client_ask_schedule": return handleClientAskSchedule(phone, chatId, text, session);
        case "client_ask_plan": return handleClientPlanReply(phone, chatId, text, session);
        case "client_send_payment": return handleClientSendPayment(phone, chatId, session);
        case "client_awaiting_identity":
            await (0, client_1.sendMessage)(chatId, "Still verifying — I'll send your caregiver options as soon as it clears.");
            return;
        case "client_awaiting_payment":
            await (0, client_1.sendMessage)(chatId, "I'm still waiting for your payment setup to complete. Tap the link I sent to finish up — it only takes 30 seconds! 💳");
            return;
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
        case "caregiver_ask_name": return handleCaregiverAskName(phone, chatId, text);
        case "caregiver_ask_location": return handleCaregiverAskLocation(phone, chatId, text, session);
        case "caregiver_ask_experience": return handleCaregiverAskExperience(phone, chatId, text, session);
        case "caregiver_ask_specialties": return handleCaregiverAskSpecialties(phone, chatId, text, session);
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
            await handleCaregiverResendMembership(phone, chatId, session);
            return;
        case "caregiver_send_bgcheck": return handleCaregiverSendBgcheck(phone, chatId, session);
        case "caregiver_awaiting_bgcheck":
            await (0, client_1.sendMessage)(chatId, "Your background check is still processing — usually 1–3 days. I'll text you the moment results are in.");
            return;
        case "caregiver_send_stripe_connect": return handleCaregiverSendStripeConnect(phone, chatId, session);
        case "caregiver_awaiting_stripe":
            await (0, client_1.sendMessage)(chatId, "Tap the link I sent to set up your payout account so you can get paid after each visit.");
            return;
        default:
            await (0, client_1.sendMessage)(chatId, "I think something went sideways. Reply START OVER to begin fresh.");
    }
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
        await (0, client_1.sendMessage)(chatId, "I'd love to help. What's your name?");
        return;
    }
    if (raw === "caregiver") {
        await updateSession(phone, { onboardingStep: "caregiver_ask_name", userType: "caregiver" });
        await (0, client_1.sendMessage)(chatId, "Great — let's get your profile set up. Takes about 5 minutes and everything happens right here.\n\nWhat's your name?");
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
    await (0, client_1.sendMessage)(chatId, `Nice to meet you, ${safeName}. Who are we caring for?`);
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
    await (0, client_1.sendMessage)(chatId, `Got it. How old is ${seniorName}, and what do they need help with these days?`);
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
    await (0, client_1.sendMessage)(chatId, `And where does ${seniorName !== null && seniorName !== void 0 ? seniorName : "they"} live?`);
}
async function handleClientAskLocation(phone, chatId, text, session) {
    var _a, _b, _c, _d;
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
    catch ( /* keep defaults */_e) { /* keep defaults */ }
    if (!city && !zipCode) {
        await (0, client_1.sendMessage)(chatId, "Hmm, I didn't catch that. Could you share your city and zip code? (e.g. \"Austin, TX 78701\")");
        return;
    }
    await mergeOnboardingData(phone, { city, zipCode });
    await updateSession(phone, { onboardingStep: "client_ask_schedule" });
    const d = (_c = session.onboardingData) !== null && _c !== void 0 ? _c : {};
    await (0, client_1.sendMessage)(chatId, `How often does ${(_d = d.seniorName) !== null && _d !== void 0 ? _d : "they"} need someone, and what times of day work best?`);
}
async function handleClientAskSchedule(phone, chatId, text, session) {
    var _a, _b, _c, _d, _e;
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
    catch ( /* keep defaults */_f) { /* keep defaults */ }
    await mergeOnboardingData(phone, { daysPerWeek, timeOfDay, hoursPerDay });
    // Refresh session so handleClientShowCaregivers has the full onboardingData
    const refreshed = await db.collection("agent_sessions").doc(phone).get();
    await handleClientShowCaregivers(phone, chatId, refreshed.data());
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
    // Query caregivers by city; fall back to any active caregivers
    let snap = await db
        .collection("caregivers")
        .where("status", "==", "active")
        .where("city", "==", city)
        .limit(5)
        .get();
    if (snap.empty) {
        snap = await db.collection("caregivers").where("status", "==", "active").limit(5).get();
    }
    const docs = snap.docs.map(doc => doc.data());
    const total = snap.size;
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
    const caregiverMsg = `I found ${total > 5 ? "6+" : total} caregiver${total !== 1 ? "s" : ""} near ${locationLabel} ` +
        `who can help with ${needsLabel}:\n\n${total > 0 ? preview + "\n\n" : ""}` +
        `To connect ${seniorName} with them, I need to quickly verify your identity — takes 30 seconds:`;
    await (0, client_1.sendMessage)(chatId, caregiverMsg);
    // Send identity link immediately (back-to-back, no reply needed)
    let identityUrl;
    try {
        identityUrl = await createClientIdentitySession(phone);
    }
    catch (err) {
        console.error("createClientIdentitySession error — skipping identity, advancing to plan:", err);
        await updateSession(phone, { onboardingStep: "client_ask_plan" });
        await handleClientAskPlan(phone, chatId);
        return;
    }
    await (0, client_1.sendMessage)(chatId, { parts: [{ type: "link", url: identityUrl, value: "🔒 Verify My Identity →" }] });
    await updateSession(phone, { onboardingStep: "client_awaiting_identity" });
}
async function handleClientAskPlan(phone, chatId) {
    await (0, client_1.sendMessage)(chatId, `Almost done! Choose your plan:\n\n` +
        `1️⃣ Basic — $49/mo\n` +
        `   · AI care assistant (Cara)\n` +
        `   · Weekly care summaries\n\n` +
        `2️⃣ Family — $99/mo\n` +
        `   · Everything in Basic\n` +
        `   · Group family updates\n` +
        `   · Priority matching\n\n` +
        `3️⃣ Premium — $199/mo\n` +
        `   · Everything in Family\n` +
        `   · 24/7 urgent response\n` +
        `   · Dedicated care coordinator\n\n` +
        `Reply 1, 2, or 3.`);
}
async function handleClientPlanReply(phone, chatId, text, session) {
    var _a, _b, _c;
    const raw = await parseWithClaude('"1", "basic", "cheapest", "starter" → basic. ' +
        '"2", "family", "middle", "group" → family. ' +
        '"3", "premium", "best", "top", "priority", "coordinator" → premium. ' +
        'Reply with exactly one word: basic, family, or premium. If unclear, reply: unclear', text);
    const plans = {
        basic: { name: "Basic", priceId: (_a = process.env.STRIPE_PLAN_BASIC_PRICE_ID) !== null && _a !== void 0 ? _a : "" },
        family: { name: "Family", priceId: (_b = process.env.STRIPE_PLAN_FAMILY_PRICE_ID) !== null && _b !== void 0 ? _b : "" },
        premium: { name: "Premium", priceId: (_c = process.env.STRIPE_PLAN_PREMIUM_PRICE_ID) !== null && _c !== void 0 ? _c : "" },
    };
    const plan = plans[raw];
    if (!plan) {
        await (0, client_1.sendMessage)(chatId, "Just reply 1, 2, or 3 to choose your plan — or tell me which tier you'd like (Basic, Family, or Premium).");
        return;
    }
    await mergeOnboardingData(phone, { selectedPlan: plan.name, selectedPlanPriceId: plan.priceId });
    await updateSession(phone, { onboardingStep: "client_send_payment" });
    await handleClientSendPayment(phone, chatId, session);
}
async function handleClientSendPayment(phone, chatId, session) {
    var _a, _b, _c, _d;
    const d = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
    const token = (0, tokenService_1.generateToken)({ phone, task: "payment" });
    const caraPhone = encodeURIComponent((_b = process.env.LINQ_PHONE_NUMBER) !== null && _b !== void 0 ? _b : "");
    let checkoutUrl = `${APP_URL}/payment/success?source=cara&caraPhone=${caraPhone}`;
    try {
        const stripeSession = await getStripe().checkout.sessions.create({
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
    await (0, client_1.sendMessage)(chatId, `Perfect — I have everything I need to start finding caregivers for ${(_d = d.seniorName) !== null && _d !== void 0 ? _d : "your loved one"}.\n\n` +
        `One last step: add a payment method so caregivers know you're ready to book.\n` +
        `Takes about 30 seconds:`);
    await (0, client_1.sendMessage)(chatId, { parts: [{ type: "link", url: checkoutUrl, value: "💳 Add Payment Method →" }] });
    await (0, client_1.sendMessage)(chatId, "I'll start searching while you set that up.");
}
// ── CAREGIVER FLOW ────────────────────────────────────────────────────────────
async function handleCaregiverAskName(phone, chatId, text) {
    const name = await parseWithClaude("Extract the full name from this message. Reply with just the name, nothing else.", text);
    await mergeOnboardingData(phone, { name });
    await updateSession(phone, { onboardingStep: "caregiver_ask_location" });
    await (0, client_1.sendMessage)(chatId, `Hi ${name} — what city and zip code do you work in?`);
}
async function handleCaregiverAskLocation(phone, chatId, text, session) {
    var _a, _b, _c, _d;
    const raw = await parseWithClaude('Extract city and zipCode from this message. Reply in JSON: {"city":"...","zipCode":"..."}', text);
    let city = "", zipCode = "";
    try {
        const p = JSON.parse(raw);
        city = (_a = p.city) !== null && _a !== void 0 ? _a : "";
        zipCode = (_b = p.zipCode) !== null && _b !== void 0 ? _b : "";
    }
    catch ( /* keep defaults */_e) { /* keep defaults */ }
    await mergeOnboardingData(phone, { city, zipCode });
    await updateSession(phone, { onboardingStep: "caregiver_ask_experience" });
    const d = (_c = session.onboardingData) !== null && _c !== void 0 ? _c : {};
    await (0, client_1.sendMessage)(chatId, `Great, ${(_d = d.name) !== null && _d !== void 0 ? _d : ""}! How many years of caregiving experience do you have, and do you hold any certifications?\n\n` +
        `For example: "5 years, CNA and CPR" or "2 years, no certifications".`);
}
async function handleCaregiverAskExperience(phone, chatId, text, session) {
    var _a, _b;
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
    await (0, client_1.sendMessage)(chatId, "What types of care do you specialize in?\n\n" +
        "For example: dementia, Alzheimer's, mobility assistance, post-surgery, companionship, medication management...");
}
async function handleCaregiverAskSpecialties(phone, chatId, text, session) {
    var _a;
    const raw = await parseWithClaude("Extract a list of care specialties from this message. Reply in JSON: {\"specialties\":[\"...\",\"...\"]}", text);
    let specialties = [];
    try {
        const p = JSON.parse(raw);
        specialties = (_a = p.specialties) !== null && _a !== void 0 ? _a : [];
    }
    catch ( /* keep defaults */_b) { /* keep defaults */ }
    await mergeOnboardingData(phone, { specialties });
    await updateSession(phone, { onboardingStep: "caregiver_ask_availability" });
    await (0, client_1.sendMessage)(chatId, "What days and hours are you generally available to work?");
}
async function handleCaregiverAskAvailability(phone, chatId, text, session) {
    var _a, _b;
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
    await (0, client_1.sendMessage)(chatId, "Are you looking for occasional fill-in shifts, part-time (less than 25 hrs/week), or full-time work?\n\n" +
        "Reply 1 for Occasional, 2 for Part-time, or 3 for Full-time.");
}
async function handleCaregiverAskRate(phone, chatId, text, session) {
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
    await (0, client_1.sendMessage)(chatId, "What's your email address? I'll use it to set up your payout account.");
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
    const email = text.trim().toLowerCase();
    if (!/\S+@\S+\.\S+/.test(email)) {
        await (0, client_1.sendMessage)(chatId, "That doesn't look like a valid email. Could you double-check? (e.g. name@example.com)");
        return;
    }
    await mergeOnboardingData(phone, { email });
    await updateSession(phone, { onboardingStep: "caregiver_ask_bio" });
    await (0, client_1.sendMessage)(chatId, "Last question before your photo — tell me about your approach to care in a sentence or two. Families will see this on your profile.");
}
async function handleCaregiverAskBio(phone, chatId, text, session) {
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
    var _a, _b, _c, _d, _e, _f;
    const d = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
    const wantsMvr = (_b = d.wantsMvr) !== null && _b !== void 0 ? _b : false;
    const token = (0, tokenService_1.generateToken)({ phone, task: "caregiver_membership" });
    let checkoutUrl = `${APP_URL}/done?task=caregiver_membership&t=${token}`;
    try {
        const membershipPriceId = (_d = (_c = process.env.STRIPE_CAREGIVER_ANNUAL_PRICE_ID) !== null && _c !== void 0 ? _c : process.env.VITE_STRIPE_CAREGIVER_ANNUAL) !== null && _d !== void 0 ? _d : "";
        const mvrPriceId = ((_e = process.env.STRIPE_MVR_PRICE_ID) !== null && _e !== void 0 ? _e : "").trim();
        if (membershipPriceId) {
            const lineItems = [
                { price: membershipPriceId, quantity: 1 },
            ];
            if (wantsMvr && mvrPriceId && !mvrPriceId.startsWith("FILL_IN")) {
                lineItems.push({ price: mvrPriceId, quantity: 1 });
            }
            const stripeSession = await getStripe().checkout.sessions.create({
                mode: "payment",
                payment_method_types: ["card"],
                line_items: lineItems,
                success_url: `${APP_URL}/done?task=caregiver_membership&t=${token}`,
                cancel_url: `${APP_URL}/start`,
                metadata: { phone, task: "caregiver_membership", includeMVR: wantsMvr ? "true" : "false" },
            });
            checkoutUrl = (_f = stripeSession.url) !== null && _f !== void 0 ? _f : checkoutUrl;
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
    await (0, client_1.sendMessage)(chatId, "Almost there! There's a $24.95/year platform fee that gives you access to the job board, " +
        `bookings, and Cara's scheduling tools.${mvrLine}\n\nTap to pay and activate your account:`);
    await (0, client_1.sendMessage)(chatId, { parts: [{ type: "link", url: checkoutUrl, value: "💳 Pay Now →" }] });
}
async function handleCaregiverResendMembership(phone, chatId, session) {
    const url = session.membershipCheckoutUrl;
    if (url) {
        await (0, client_1.sendMessage)(chatId, "Tap the link below to complete your membership payment:");
        await (0, client_1.sendMessage)(chatId, { parts: [{ type: "link", url, value: "💳 Pay $24.95/year →" }] });
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
    await (0, client_1.sendMessage)(chatId, { parts: [{ type: "link", url: photoUrl, value: "📷 Upload Photo →" }] });
}
async function handleCaregiverSendDocuments(phone, chatId, session) {
    const token = (0, tokenService_1.generateToken)({ phone, task: "doc_upload" });
    const docUrl = `${APP_URL}/upload/document?t=${token}`;
    await updateSession(phone, { onboardingStep: "caregiver_awaiting_documents" });
    await (0, client_1.sendMessage)(chatId, "Do you have certifications to upload? (CNA license, CPR card, etc.)\n\nTap to upload, or reply SKIP:");
    await (0, client_1.sendMessage)(chatId, { parts: [{ type: "link", url: docUrl, value: "📄 Upload Documents →" }] });
}
async function handleCaregiverSendBgcheck(phone, chatId, session) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
    let inviteUrl = `${APP_URL}/done?task=background_check`;
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
    await (0, client_1.sendMessage)(chatId, { parts: [{ type: "link", url: inviteUrl, value: "✅ Start Background Check →" }] });
    await (0, client_1.sendMessage)(chatId, "I'll text you when results come in (usually 1–3 days).");
}
async function handleCaregiverSendStripeConnect(phone, chatId, session) {
    var _a, _b, _c;
    const token = (0, tokenService_1.generateToken)({ phone, task: "stripe_connect" });
    let connectUrl = `${APP_URL}/done?task=stripe_connect&t=${token}`;
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
    await (0, client_1.sendMessage)(chatId, { parts: [{ type: "link", url: connectUrl, value: "💰 Set Up Payouts →" }] });
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
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1;
    const snap = await db.collection("agent_sessions").doc(phone).get();
    if (!snap.exists)
        return;
    const session = snap.data();
    const chatId = session.chatId;
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
                catch (_2) {
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
                await db.collection("users").doc(uid).set({
                    membershipStatus: "active",
                    subscriptionActive: true,
                    phone,
                    firstName: ((_d = d.firstName) !== null && _d !== void 0 ? _d : ""),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    onboardingProgress: {
                        identityVerified: true,
                        membershipActive: true,
                    },
                }, { merge: true });
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
            // Advance to job posting flow instead of going straight to permissions
            await updateSession(phone, { onboardingStep: "job_ask_start" });
            await handleJobAskStart(phone, chatId, "", session);
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
                    catch (_3) {
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
                await updateSession(phone, { onboardingStep: "client_ask_plan" });
                await handleClientAskPlan(phone, chatId);
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
            // Silently create Firebase Auth account so web dashboard login works later
            await createFirebaseAuthAccount(phone, ((_y = d.name) !== null && _y !== void 0 ? _y : ""));
            // Notify admin
            (0, notifications_1.notifyAdminNewCaregiverSignup)({
                caregiverId,
                name: ((_z = d.name) !== null && _z !== void 0 ? _z : ""),
                phone,
                city: ((_0 = d.city) !== null && _0 !== void 0 ? _0 : ""),
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
                    user_name: ((_1 = d.name) !== null && _1 !== void 0 ? _1 : ""),
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
            const { sendCaregiverPermissionsFlow } = await Promise.resolve().then(() => __importStar(require("./permissionsConversation")));
            await sendCaregiverPermissionsFlow(phone, chatId, session, d.name);
            break;
        }
    }
}
// ── JOB POSTING FLOW ──────────────────────────────────────────────────────────
// Triggered after client pays membership. Mirrors the 6-step PostJobFlow web
// form and writes to the same Firestore collections so the web dashboard syncs.
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
    var _a, _b, _c, _d;
    const d = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
    const response = await getClaude().messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 100,
        system: "You are Cara, an AI care assistant. " +
            "A user is in the middle of signing up and has a question. " +
            `Context: they are ${session.userType === "caregiver" ? "a caregiver looking for work" : "a family member looking for care"}. ` +
            `Name: ${((_c = (_b = d.name) !== null && _b !== void 0 ? _b : d.firstName) !== null && _c !== void 0 ? _c : "")}. ` +
            "Answer briefly (1–2 sentences). Be warm and helpful.",
        messages: [{ role: "user", content: text }],
    });
    return ((_d = response.content[0].text) !== null && _d !== void 0 ? _d : "").trim();
}
//# sourceMappingURL=onboardingConversation.js.map