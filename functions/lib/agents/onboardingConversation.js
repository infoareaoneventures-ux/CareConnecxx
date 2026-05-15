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
        "Valid fields: firstName, seniorName, city, zipCode, hourlyRate, yearsExperience. " +
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
        await (0, client_1.sendMessage)(chatId, "No problem — let's start fresh! 😊\n\n" +
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
        && !step.endsWith("_send_stripe_connect") && !step.endsWith("_awaiting_stripe")) {
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
                caregiver_ask_rate: "What's your hourly rate?",
            };
            const repeat = (_b = stepMessages[step]) !== null && _b !== void 0 ? _b : "Could you continue where we left off?";
            await (0, client_1.sendMessage)(chatId, `Got it, updated! ✅\n\n${repeat}`);
            return;
        }
    }
    // Route to the appropriate step handler
    switch (step) {
        case "ask_role": return handleAskRole(phone, chatId, text);
        case "client_ask_name": return handleClientAskName(phone, chatId, text);
        case "client_ask_senior": return handleClientAskSenior(phone, chatId, text, session);
        case "client_ask_needs": return handleClientAskNeeds(phone, chatId, text, session);
        case "client_ask_location": return handleClientAskLocation(phone, chatId, text, session);
        case "client_ask_schedule": return handleClientAskSchedule(phone, chatId, text, session);
        case "client_ask_plan": return handleClientPlanReply(phone, chatId, text, session);
        case "client_send_payment": return handleClientSendPayment(phone, chatId, session);
        case "client_awaiting_identity":
            await (0, client_1.sendMessage)(chatId, "Still verifying — I'll send your caregiver options as soon as it's confirmed! 💙");
            return;
        case "client_awaiting_payment":
            await (0, client_1.sendMessage)(chatId, "I'm still waiting for your payment setup to complete. Tap the link I sent to finish up — it only takes 30 seconds! 💳");
            return;
        case "caregiver_ask_name": return handleCaregiverAskName(phone, chatId, text);
        case "caregiver_ask_location": return handleCaregiverAskLocation(phone, chatId, text, session);
        case "caregiver_ask_experience": return handleCaregiverAskExperience(phone, chatId, text, session);
        case "caregiver_ask_specialties": return handleCaregiverAskSpecialties(phone, chatId, text, session);
        case "caregiver_ask_availability": return handleCaregiverAskAvailability(phone, chatId, text, session);
        case "caregiver_ask_rate": return handleCaregiverAskRate(phone, chatId, text, session);
        case "caregiver_send_photo": return handleCaregiverSendPhoto(phone, chatId, session);
        case "caregiver_awaiting_photo":
            await (0, client_1.sendMessage)(chatId, "Still waiting for your photo! Tap the upload link I sent 📷");
            return;
        case "caregiver_send_documents": return handleCaregiverSendDocuments(phone, chatId, session);
        case "caregiver_awaiting_documents":
            if (norm === "SKIP") {
                await updateSession(phone, { onboardingStep: "caregiver_send_bgcheck" });
                return handleCaregiverSendBgcheck(phone, chatId, session);
            }
            await (0, client_1.sendMessage)(chatId, "Tap the link I sent to upload your certifications, or reply SKIP to continue without them.");
            return;
        case "caregiver_send_bgcheck": return handleCaregiverSendBgcheck(phone, chatId, session);
        case "caregiver_awaiting_bgcheck":
            await (0, client_1.sendMessage)(chatId, "Your background check is still processing — usually 1–3 days. I'll text you the moment results are in! 🕐");
            return;
        case "caregiver_send_stripe_connect": return handleCaregiverSendStripeConnect(phone, chatId, session);
        case "caregiver_awaiting_stripe":
            await (0, client_1.sendMessage)(chatId, "Tap the link I sent to set up your payout account so you can get paid after each visit 💰");
            return;
        default:
            await (0, client_1.sendMessage)(chatId, "I think something went sideways 😅 Reply START OVER to begin fresh.");
    }
}
// ── ask_role ──────────────────────────────────────────────────────────────────
async function handleAskRole(phone, chatId, text) {
    const norm = text.trim();
    if (norm === "1" || /need.*care|looking.*care|family|mom|dad|parent/i.test(norm)) {
        await updateSession(phone, { onboardingStep: "client_ask_name", userType: "client" });
        await (0, client_1.sendMessage)(chatId, "I'd love to help 💙 What's your name?");
        return;
    }
    if (norm === "2" || /caregiver|cna|hha|nurse|work|job/i.test(norm)) {
        await updateSession(phone, { onboardingStep: "caregiver_ask_name", userType: "caregiver" });
        await (0, client_1.sendMessage)(chatId, "Wonderful! What's your name?");
        return;
    }
    await (0, client_1.sendMessage)(chatId, "I want to make sure I help you with the right thing!\n\n" +
        "Reply 1 if you need care for a loved one, or 2 if you're a caregiver looking for work.");
}
// ── CLIENT FLOW ───────────────────────────────────────────────────────────────
async function handleClientAskName(phone, chatId, text) {
    const firstName = await parseWithClaude("Extract only the first name from this message. Reply with just the first name, nothing else.", text);
    await mergeOnboardingData(phone, { firstName });
    await updateSession(phone, { onboardingStep: "client_ask_senior" });
    await (0, client_1.sendMessage)(chatId, `Hi ${firstName}! 👋\n\n` +
        `Who are you looking for care for? Tell me their name and your relationship — for example, "my mom Dorothy" or "my dad Bill".`);
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
    await (0, client_1.sendMessage)(chatId, `How old is ${seniorName}, and what kind of help do they need?\n\n` +
        `Just describe it in your own words — bathing, meals, companionship, medication reminders, anything.`);
}
async function handleClientAskNeeds(phone, chatId, text, session) {
    var _a, _b, _c, _d, _e;
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
    catch ( /* keep defaults */_f) { /* keep defaults */ }
    await mergeOnboardingData(phone, { age, careNeeds, conditions });
    await updateSession(phone, { onboardingStep: "client_ask_location" });
    await (0, client_1.sendMessage)(chatId, "What city and zip code does your loved one live in?");
}
async function handleClientAskLocation(phone, chatId, text, session) {
    var _a, _b, _c, _d;
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
    await (0, client_1.sendMessage)(chatId, `How many days a week does ${(_d = d.seniorName) !== null && _d !== void 0 ? _d : "your loved one"} need care, and roughly what hours?\n\n` +
        `For example: "3 days a week, mornings" or "every day, 8am to 4pm".`);
}
async function handleClientAskSchedule(phone, chatId, text, session) {
    var _a, _b, _c;
    const raw = await parseWithClaude('Extract daysPerWeek (number), timeOfDay (morning/afternoon/evening/all-day), and hoursPerDay (number) from this message. Reply in JSON: {"daysPerWeek":0,"timeOfDay":"","hoursPerDay":0}', text);
    if (raw === "__parse_error__") {
        await (0, client_1.sendMessage)(chatId, "Hmm, I didn't catch that. What days and hours do you need care? (e.g. \"Mon–Fri, 9am to 3pm\" or \"3 days a week, mornings\")");
        return;
    }
    let daysPerWeek = 3, timeOfDay = "mornings", hoursPerDay = 4;
    try {
        const parsed = JSON.parse(raw);
        daysPerWeek = (_a = parsed.daysPerWeek) !== null && _a !== void 0 ? _a : daysPerWeek;
        timeOfDay = (_b = parsed.timeOfDay) !== null && _b !== void 0 ? _b : timeOfDay;
        hoursPerDay = (_c = parsed.hoursPerDay) !== null && _c !== void 0 ? _c : hoursPerDay;
    }
    catch ( /* keep defaults */_d) { /* keep defaults */ }
    await mergeOnboardingData(phone, { daysPerWeek, timeOfDay, hoursPerDay });
    // Refresh session so handleClientShowCaregivers has the full onboardingData
    const refreshed = await db.collection("agent_sessions").doc(phone).get();
    await handleClientShowCaregivers(phone, chatId, refreshed.data());
}
async function createClientIdentitySession(phone) {
    const session = await getStripe().identity.verificationSessions.create({
        type: "document",
        metadata: { phone },
        return_url: `${APP_URL}/identity/done`,
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
    const norm = text.trim();
    const plans = {
        "1": { name: "Basic", priceId: (_a = process.env.STRIPE_PLAN_BASIC_PRICE_ID) !== null && _a !== void 0 ? _a : "" },
        "2": { name: "Family", priceId: (_b = process.env.STRIPE_PLAN_FAMILY_PRICE_ID) !== null && _b !== void 0 ? _b : "" },
        "3": { name: "Premium", priceId: (_c = process.env.STRIPE_PLAN_PREMIUM_PRICE_ID) !== null && _c !== void 0 ? _c : "" },
    };
    const plan = plans[norm];
    if (!plan) {
        await (0, client_1.sendMessage)(chatId, "Just reply 1, 2, or 3 to choose your plan! 😊");
        return;
    }
    await mergeOnboardingData(phone, { selectedPlan: plan.name, selectedPlanPriceId: plan.priceId });
    await updateSession(phone, { onboardingStep: "client_send_payment" });
    await handleClientSendPayment(phone, chatId, session);
}
async function handleClientSendPayment(phone, chatId, session) {
    var _a, _b, _c;
    const d = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
    const token = (0, tokenService_1.generateToken)({ phone, task: "payment" });
    let checkoutUrl = `${APP_URL}/done?task=payment&t=${token}`;
    try {
        const stripeSession = await getStripe().checkout.sessions.create({
            mode: "setup",
            payment_method_types: ["card"],
            success_url: `${APP_URL}/done?task=payment&t=${token}`,
            cancel_url: `${APP_URL}/start`,
            metadata: { phone, task: "client_payment_setup" },
        });
        checkoutUrl = (_b = stripeSession.url) !== null && _b !== void 0 ? _b : checkoutUrl;
    }
    catch (err) {
        console.error("handleClientSendPayment stripe error:", err);
    }
    await updateSession(phone, { onboardingStep: "client_awaiting_payment" });
    await (0, client_1.sendMessage)(chatId, `Perfect — I have everything I need to start finding caregivers for ${(_c = d.seniorName) !== null && _c !== void 0 ? _c : "your loved one"}! 🎉\n\n` +
        `One last step: add a payment method so caregivers know you're ready to book.\n` +
        `Takes about 30 seconds:`);
    await (0, client_1.sendMessage)(chatId, { parts: [{ type: "link", url: checkoutUrl, value: "💳 Add Payment Method →" }] });
    await (0, client_1.sendMessage)(chatId, "I'll start searching while you set that up 🔍");
}
// ── CAREGIVER FLOW ────────────────────────────────────────────────────────────
async function handleCaregiverAskName(phone, chatId, text) {
    const name = await parseWithClaude("Extract the full name from this message. Reply with just the name, nothing else.", text);
    await mergeOnboardingData(phone, { name });
    await updateSession(phone, { onboardingStep: "caregiver_ask_location" });
    await (0, client_1.sendMessage)(chatId, `Hi ${name}! 👋 What city and zip code do you work in?`);
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
    await updateSession(phone, { onboardingStep: "caregiver_ask_rate" });
    await (0, client_1.sendMessage)(chatId, "What's your hourly rate?\n\n" +
        "(Most caregivers charge $18–28/hr)");
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
    await updateSession(phone, { onboardingStep: "caregiver_send_photo" });
    await handleCaregiverSendPhoto(phone, chatId, session);
}
async function handleCaregiverSendPhoto(phone, chatId, session) {
    var _a, _b;
    const token = (0, tokenService_1.generateToken)({ phone, task: "photo_upload" });
    const photoUrl = `${APP_URL}/upload/photo?t=${token}`;
    await updateSession(phone, { onboardingStep: "caregiver_awaiting_photo" });
    const d = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
    await (0, client_1.sendMessage)(chatId, `Almost there, ${(_b = d.name) !== null && _b !== void 0 ? _b : ""}! 🎉 One more thing — families want to see who they're trusting.\n\n` +
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
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
    let inviteUrl = `${APP_URL}/done?task=background_check`;
    try {
        const d = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
        const nameParts = ((_b = d.name) !== null && _b !== void 0 ? _b : "").split(" ");
        const resp = await axios_1.default.post("https://api.checkr.com/v1/invitations", {
            package: "tasker_standard",
            first_name: (_c = nameParts[0]) !== null && _c !== void 0 ? _c : "",
            last_name: (_d = nameParts.slice(1).join(" ")) !== null && _d !== void 0 ? _d : "",
        }, { auth: { username: (_e = process.env.CHECKR_API_KEY) !== null && _e !== void 0 ? _e : "", password: "" } });
        inviteUrl = (_g = (_f = resp.data) === null || _f === void 0 ? void 0 : _f.invitation_url) !== null && _g !== void 0 ? _g : inviteUrl;
        // Pre-create the caregivers doc so the Checkr webhook can find this caregiver
        // by checkrCandidateId when the report comes back.
        const candidateId = ((_j = (_h = resp.data) === null || _h === void 0 ? void 0 : _h.candidate_id) !== null && _j !== void 0 ? _j : (_k = resp.data) === null || _k === void 0 ? void 0 : _k.id);
        if (candidateId && !session.caregiverId) {
            const caregiverRef = await db.collection("caregivers").add({
                phone,
                status: "pending_review",
                createdAt: new Date().toISOString(),
                backgroundCheckData: {
                    checkrCandidateId: candidateId,
                    status: "pending",
                    submittedAt: new Date().toISOString(),
                },
            });
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
    await (0, client_1.sendMessage)(chatId, "I'll text you when results come in (usually 1–3 days). 🕐");
}
async function handleCaregiverSendStripeConnect(phone, chatId, session) {
    var _a, _b;
    const token = (0, tokenService_1.generateToken)({ phone, task: "stripe_connect" });
    let connectUrl = `${APP_URL}/done?task=stripe_connect&t=${token}`;
    try {
        const d = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
        const account = await getStripe().accounts.create({
            type: "express",
            country: "US",
            metadata: { phone, caregiverName: ((_b = d.name) !== null && _b !== void 0 ? _b : "") },
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
// ── Webhook-triggered step advancement ───────────────────────────────────────
// Called from stripe.ts and checkr.ts when webhooks fire
async function advanceOnboardingStep(phone, task, taskData) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s;
    const snap = await db.collection("agent_sessions").doc(phone).get();
    if (!snap.exists)
        return;
    const session = snap.data();
    const chatId = session.chatId;
    switch (task) {
        case "payment": {
            // Client paid → move to permissions
            await updateSession(phone, { onboardingStep: "client_ask_permissions" });
            // Write intake to Firestore
            const d = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
            await db.collection("clientIntakes").add({
                phone,
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
                clientId: (_b = session.userId) !== null && _b !== void 0 ? _b : phone,
                firstName: ((_c = d.firstName) !== null && _c !== void 0 ? _c : ""),
                seniorName: ((_d = d.seniorName) !== null && _d !== void 0 ? _d : ""),
                phone,
                city: ((_e = d.city) !== null && _e !== void 0 ? _e : ""),
            }).catch((err) => console.error("notifyAdminNewClientSignup error:", err));
            // Silently create Firebase Auth account so web dashboard login works later
            await createFirebaseAuthAccount(phone, ((_f = d.firstName) !== null && _f !== void 0 ? _f : ""));
            // Initialize memory files with onboarding data
            (0, memoryFiles_1.initializeMemoryFiles)((_g = session.userId) !== null && _g !== void 0 ? _g : phone, {
                seniorName: d.seniorName,
                seniorAge: d.age,
                conditions: d.conditions,
                careNeeds: d.careNeeds,
                city: d.city,
                clientName: d.firstName,
                relationship: d.relationship,
            }).catch((err) => console.error("initializeMemoryFiles error:", err));
            // Initialize empty memory files not covered by initializeMemoryFiles
            Promise.all([
                (0, memoryFiles_1.writeMemoryFile)((_h = session.userId) !== null && _h !== void 0 ? _h : phone, "recent_episodes", `# Recent Episodes\n`),
                (0, memoryFiles_1.writeMemoryFile)((_j = session.userId) !== null && _j !== void 0 ? _j : phone, "procedural", `# Procedural Notes\n`),
            ]).catch((err) => console.error("initializeExtraMemoryFiles error:", err));
            // Push structured onboarding data to Zep — thread already exists from first contact,
            // this enriches the knowledge graph with senior profile and care details
            (0, zepClient_1.pushOnboardingDataToZep)({
                phone,
                firstName: ((_k = d.firstName) !== null && _k !== void 0 ? _k : ""),
                seniorName: ((_l = d.seniorName) !== null && _l !== void 0 ? _l : ""),
                seniorAge: d.age ? Number(d.age) : undefined,
                conditions: Array.isArray(d.conditions) ? d.conditions : undefined,
                careNeeds: Array.isArray(d.careNeeds) ? d.careNeeds : undefined,
                city: d.city,
                relationship: d.relationship,
                daysPerWeek: d.daysPerWeek ? Number(d.daysPerWeek) : undefined,
                timeOfDay: d.timeOfDay,
            }).catch((err) => console.error("pushOnboardingDataToZep error:", err));
            // Import and start permissions conversation
            const { sendClientPermissionsFlow } = await Promise.resolve().then(() => __importStar(require("./permissionsConversation")));
            await sendClientPermissionsFlow(phone, chatId, session);
            break;
        }
        case "photo_upload": {
            await updateSession(phone, { onboardingStep: "caregiver_send_documents" });
            await handleCaregiverSendDocuments(phone, chatId, session);
            break;
        }
        case "doc_upload": {
            await updateSession(phone, { onboardingStep: "caregiver_send_bgcheck" });
            await handleCaregiverSendBgcheck(phone, chatId, session);
            break;
        }
        case "background_check": {
            // Checkr came back clear → advance to Stripe Connect
            await updateSession(phone, { onboardingStep: "caregiver_send_stripe_connect" });
            await (0, client_1.sendMessage)(chatId, "Great news — your background check came back clear! 🎉\n\n" +
                "One last step: set up your payout account so you can get paid after every visit.");
            await handleCaregiverSendStripeConnect(phone, chatId, session);
            break;
        }
        case "identity": {
            const step = (_m = session.onboardingStep) !== null && _m !== void 0 ? _m : "";
            if (step === "client_awaiting_identity") {
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
            // Caregiver Stripe Connect complete → finalize caregiver doc
            const d = (_o = session.onboardingData) !== null && _o !== void 0 ? _o : {};
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
            await createFirebaseAuthAccount(phone, ((_p = d.name) !== null && _p !== void 0 ? _p : ""));
            // Notify admin
            (0, notifications_1.notifyAdminNewCaregiverSignup)({
                caregiverId,
                name: ((_q = d.name) !== null && _q !== void 0 ? _q : ""),
                phone,
                city: ((_r = d.city) !== null && _r !== void 0 ? _r : ""),
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
                    user_name: ((_s = d.name) !== null && _s !== void 0 ? _s : ""),
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