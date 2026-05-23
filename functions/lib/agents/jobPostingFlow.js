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
exports.startJobPostingFlow = startJobPostingFlow;
exports.handleJobPostingStep = handleJobPostingStep;
const admin = __importStar(require("firebase-admin"));
const claudeClient_1 = require("../utils/claudeClient");
const client_1 = require("../linq/client");
const buildJobPost_1 = require("./buildJobPost");
const db = admin.firestore();
// ── Helpers ───────────────────────────────────────────────────────────────────
async function parseWithClaude(prompt, userText) {
    var _a;
    try {
        const response = await (0, claudeClient_1.getSharedClient)().messages.create({
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
    const result = await parseWithClaude("Reply YES if this is a general question or off-topic comment unrelated to answering the current question. Reply NO if it is a direct answer. Only reply YES or NO.", text);
    return result.toUpperCase().startsWith("Y");
}
async function answerQuestionMidFlow(text, session) {
    var _a, _b, _c;
    const d = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
    const response = await (0, claudeClient_1.getSharedClient)().messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 100,
        system: "You are Cara, an AI care assistant helping a client post a care job. " +
            `They are setting up a job for ${(_b = d.seniorName) !== null && _b !== void 0 ? _b : "their loved one"}. ` +
            "Answer briefly (1–2 sentences). Be warm and helpful.",
        messages: [{ role: "user", content: text }],
    });
    return ((_c = response.content[0].text) !== null && _c !== void 0 ? _c : "").trim();
}
async function getJobData(phone) {
    var _a, _b;
    const snap = await db.collection("agent_sessions").doc(phone).get();
    return ((_b = (_a = snap.data()) === null || _a === void 0 ? void 0 : _a.jobPostingData) !== null && _b !== void 0 ? _b : {});
}
async function mergeJobData(phone, data) {
    var _a, _b;
    const snap = await db.collection("agent_sessions").doc(phone).get();
    const existing = ((_b = (_a = snap.data()) === null || _a === void 0 ? void 0 : _a.jobPostingData) !== null && _b !== void 0 ? _b : {});
    await db.collection("agent_sessions").doc(phone).update({
        jobPostingData: Object.assign(Object.assign({}, existing), data),
    });
}
async function updateJobStep(phone, step) {
    await db.collection("agent_sessions").doc(phone).update({ jobPostingStep: step });
}
function seniorFirstName(session) {
    var _a, _b;
    const d = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
    const full = (_b = d.seniorName) !== null && _b !== void 0 ? _b : "";
    return full.split(" ")[0] || "your loved one";
}
// ── Entry points ──────────────────────────────────────────────────────────────
async function startJobPostingFlow(phone, chatId, session) {
    const name = seniorFirstName(session);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await db.collection("agent_sessions").doc(phone).update({
        jobPostingStep: "jp_ask_start",
        jobPostingData: {},
        stateExpiresAt: expiresAt,
    });
    await (0, client_1.sendMessage)(chatId, `Let's post a new care job for ${name}! 🎉\n\nWhen would you like care to start? (e.g. "next Monday", "ASAP", "June 1")`);
}
async function handleJobPostingStep(phone, chatId, text, session) {
    var _a;
    const step = (_a = session.jobPostingStep) !== null && _a !== void 0 ? _a : "";
    switch (step) {
        case "jp_ask_start": return handleJpAskStart(phone, chatId, text, session);
        case "jp_ask_frequency": return handleJpAskFrequency(phone, chatId, text, session);
        case "jp_ask_days": return handleJpAskDays(phone, chatId, text, session);
        case "jp_ask_time": return handleJpAskTime(phone, chatId, text, session);
        case "jp_ask_care_needs": return handleJpAskCareNeeds(phone, chatId, text, session);
        case "jp_ask_care_level": return handleJpAskCareLevel(phone, chatId, text, session);
        case "jp_ask_environment": return handleJpAskEnvironment(phone, chatId, text, session);
        case "jp_ask_rate": return handleJpAskRate(phone, chatId, text, session);
        case "jp_ask_pay_method": return handleJpAskPayMethod(phone, chatId, text, session);
        case "jp_ask_description": return handleJpAskDescription(phone, chatId, text, session);
        case "jp_confirm_post": return handleJpConfirmPost(phone, chatId, text, session);
        default:
            await startJobPostingFlow(phone, chatId, session);
    }
}
// ── Step handlers ─────────────────────────────────────────────────────────────
async function handleJpAskStart(phone, chatId, text, session) {
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, `When would you like care to start? (e.g. "next Monday", "ASAP", "June 1")`);
        return;
    }
    const startDate = await parseWithClaude("Extract a start date from this message. If the user says 'ASAP', 'immediately', or 'now', return 'ASAP'. " +
        "Otherwise return the date in YYYY-MM-DD format if possible, or a plain description. Reply with just the date value.", text);
    const stored = startDate !== "__parse_error__" ? startDate : text.trim();
    await mergeJobData(phone, { jobStartDate: stored });
    await updateJobStep(phone, "jp_ask_frequency");
    await (0, client_1.sendMessage)(chatId, `Got it — starting ${stored}! How often do you need help?\n\n` +
        "1️⃣  Occasional (1–2 days/week)\n" +
        "2️⃣  Part-time (3–4 days/week)\n" +
        "3️⃣  Full-time (5+ days/week)");
}
async function handleJpAskFrequency(phone, chatId, text, session) {
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
    const raw = await parseWithClaude('"1", occasional, 1-2 days = occasional. ' +
        '"2", part-time, part time, 3-4 days = part_time. ' +
        '"3", full-time, full time, every day, 5+ days = full_time. ' +
        'Reply with exactly one of: occasional, part_time, full_time', text);
    const frequency = ["occasional", "part_time", "full_time"].includes(raw) ? raw : "occasional";
    const label = { occasional: "Occasional", part_time: "Part-time", full_time: "Full-time" };
    await mergeJobData(phone, { jobFrequency: frequency });
    await updateJobStep(phone, "jp_ask_days");
    await (0, client_1.sendMessage)(chatId, `${(_a = label[frequency]) !== null && _a !== void 0 ? _a : "Got it"}! Which days work best?\n\n(e.g. "Mon, Wed, Fri" or "weekdays" or "every day")`);
}
async function handleJpAskDays(phone, chatId, text, session) {
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
    await mergeJobData(phone, { jobDays: days });
    await updateJobStep(phone, "jp_ask_time");
    await (0, client_1.sendMessage)(chatId, `${days.length === 7 ? "Every day" : days.join(", ")} — perfect! What time of day works best?\n\n` +
        "Reply with one or more:\n\n" +
        "1️⃣  Morning (6am–noon)\n" +
        "2️⃣  Afternoon (noon–6pm)\n" +
        "3️⃣  Evening (6pm–10pm)\n" +
        "4️⃣  Overnight");
}
async function handleJpAskTime(phone, chatId, text, session) {
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, "What time of day works best?\n\n" +
            "1️⃣  Morning (6am–noon)\n" +
            "2️⃣  Afternoon (noon–6pm)\n" +
            "3️⃣  Evening (6pm–10pm)\n" +
            "4️⃣  Overnight");
        return;
    }
    const raw = await parseWithClaude('Extract time-of-day preferences as a JSON array. ' +
        '"1" or morning or am or 6am → "morning". ' +
        '"2" or afternoon or pm or noon → "afternoon". ' +
        '"3" or evening or night → "evening". ' +
        '"4" or overnight or graveyard → "overnight". ' +
        'Return a JSON array with one or more of: morning, afternoon, evening, overnight. ' +
        'Return only the JSON array.', text);
    let times = [];
    try {
        const parsed = JSON.parse(raw);
        const valid = ["morning", "afternoon", "evening", "overnight"];
        if (Array.isArray(parsed))
            times = parsed.filter((t) => valid.includes(t));
    }
    catch ( /**/_a) { /**/ }
    if (times.length === 0)
        times = ["morning"];
    const timeLabel = times.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(" & ");
    await mergeJobData(phone, { jobTimeOfDay: times });
    await updateJobStep(phone, "jp_ask_care_needs");
    const name = seniorFirstName(session);
    await (0, client_1.sendMessage)(chatId, `${timeLabel} — noted!\n\n` +
        `What kind of care does ${name} need? Reply with any that apply:\n\n` +
        "• Personal care (bathing, grooming)\n" +
        "• Mobility assistance\n" +
        "• Memory care\n" +
        "• Medication reminders\n" +
        "• Meal preparation\n" +
        "• Transportation\n" +
        "• Companionship\n" +
        "• Light housekeeping");
}
async function handleJpAskCareNeeds(phone, chatId, text, session) {
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        const name = seniorFirstName(session);
        await (0, client_1.sendMessage)(chatId, `What kind of care does ${name} need? (e.g. personal care, meals, companionship, mobility)`);
        return;
    }
    const raw = await parseWithClaude('Extract care needs as a JSON array of strings. Map to these standard values: ' +
        '"Personal Care" (bathing, grooming, hygiene, dressing), ' +
        '"Mobility Assistance" (walking, transfers, fall prevention), ' +
        '"Memory Care" (dementia, Alzheimer\'s, cognitive support), ' +
        '"Medication Reminders" (meds, pills, prescriptions), ' +
        '"Meal Preparation" (cooking, meals, food, nutrition), ' +
        '"Transportation" (driving, errands, appointments), ' +
        '"Companionship" (social, activities, conversation), ' +
        '"Light Housekeeping" (cleaning, laundry, tidying). ' +
        'Return a JSON array of matching standard values, or an empty array. Only return the JSON array.', text);
    let careNeeds = [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0)
            careNeeds = parsed;
    }
    catch ( /**/_a) { /**/ }
    if (careNeeds.length === 0)
        careNeeds = ["Companionship"];
    const needsLabel = careNeeds.slice(0, 3).join(", ") + (careNeeds.length > 3 ? ` +${careNeeds.length - 3} more` : "");
    await mergeJobData(phone, { jobCareNeeds: careNeeds });
    await updateJobStep(phone, "jp_ask_care_level");
    await (0, client_1.sendMessage)(chatId, `${needsLabel} — great choices! How intensive is the care?\n\n` +
        "1️⃣  Light — minimal assistance, mostly companionship\n" +
        "2️⃣  Moderate — daily help with several tasks\n" +
        "3️⃣  Full care — hands-on help most of the day");
}
async function handleJpAskCareLevel(phone, chatId, text, session) {
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, "How intensive is the care?\n\n" +
            "1️⃣  Light\n2️⃣  Moderate\n3️⃣  Full care");
        return;
    }
    const raw = await parseWithClaude('"1", light, minimal, easy, independent = light. ' +
        '"2", moderate, medium, some help = moderate. ' +
        '"3", full, intensive, heavy, lots of help = intensive. ' +
        'Reply with exactly one of: light, moderate, intensive', text);
    const careLevel = ["light", "moderate", "intensive"].includes(raw) ? raw : "moderate";
    const levelLabel = { light: "Light", moderate: "Moderate", intensive: "Full care" };
    await mergeJobData(phone, { jobCareLevel: careLevel });
    await updateJobStep(phone, "jp_ask_environment");
    await (0, client_1.sendMessage)(chatId, `${levelLabel[careLevel]} — got it! A couple quick home questions:\n\n` +
        "Are there any pets in the home? And does anyone smoke in the home?\n\n" +
        "(e.g. \"yes dog, no smoking\" or \"no pets, no smoke\" or \"cat yes, smoke no\")");
}
async function handleJpAskEnvironment(phone, chatId, text, session) {
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, "Are there pets in the home? Does anyone smoke in the home?");
        return;
    }
    const rawPets = await parseWithClaude('Does the message indicate there are pets in the home? ' +
        'Reply YES if pets are mentioned positively or if the user says yes to pets. ' +
        'Reply NO if no pets or user says no. Only reply YES or NO.', text);
    const rawSmoke = await parseWithClaude('Does the message indicate there is smoking in the home? ' +
        'Reply YES if smoking is mentioned positively or the user says yes to smoking. ' +
        'Reply NO if no smoking or the user says no. Only reply YES or NO.', text);
    const petsInHome = rawPets.toUpperCase().startsWith("Y");
    const smokingHousehold = rawSmoke.toUpperCase().startsWith("Y");
    const petStr = petsInHome ? "pets ✓" : "no pets";
    const smokeStr = smokingHousehold ? "smoking ✓" : "no smoking";
    await mergeJobData(phone, { petsInHome, smokingHousehold });
    await updateJobStep(phone, "jp_ask_rate");
    await (0, client_1.sendMessage)(chatId, `Got it — ${petStr}, ${smokeStr}.\n\nWhat hourly rate are you offering? (e.g. "$20", "18 an hour", "flexible")`);
}
async function handleJpAskRate(phone, chatId, text, session) {
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, "What hourly rate are you offering? (e.g. \"$20\", \"18 an hour\", \"flexible\")");
        return;
    }
    const raw = await parseWithClaude('Extract the hourly rate as a number. ' +
        'If the user says "flexible", "open", or "negotiable", return 0. ' +
        'Otherwise extract the dollar amount and return only the number (e.g. 20, 18.50). ' +
        'Return only the number or 0.', text);
    const rate = parseFloat(raw);
    const jobHourlyRate = isNaN(rate) ? 0 : rate;
    const rateLabel = jobHourlyRate > 0 ? `$${jobHourlyRate}/hr` : "flexible rate";
    await mergeJobData(phone, { jobHourlyRate });
    await updateJobStep(phone, "jp_ask_pay_method");
    await (0, client_1.sendMessage)(chatId, `${rateLabel} — sounds good! How would you prefer to pay?\n\n` +
        "1️⃣  Card (processed through CareConnex)\n" +
        "2️⃣  Cash");
}
async function handleJpAskPayMethod(phone, chatId, text, session) {
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        await (0, client_1.sendMessage)(chatId, "How would you prefer to pay?\n\n1️⃣  Card\n2️⃣  Cash");
        return;
    }
    const raw = await parseWithClaude('"1", card, credit, debit, online, CareConnex = card. "2", cash, in person = cash. ' +
        'Reply with exactly one of: card, cash', text);
    const payMethod = ["card", "cash"].includes(raw) ? raw : "card";
    const methodLabel = payMethod === "cash" ? "Cash" : "Card";
    await mergeJobData(phone, { jobPaymentMethod: payMethod });
    await updateJobStep(phone, "jp_ask_description");
    const name = seniorFirstName(session);
    await (0, client_1.sendMessage)(chatId, `${methodLabel} — perfect! Last question: can you briefly describe a typical care day for ${name}?\n\n` +
        "(A sentence or two is great — this helps caregivers understand the role)");
}
async function handleJpAskDescription(phone, chatId, text, session) {
    if (await isQuestionOrOther(text)) {
        const answer = await answerQuestionMidFlow(text, session);
        await (0, client_1.sendMessage)(chatId, answer);
        const name = seniorFirstName(session);
        await (0, client_1.sendMessage)(chatId, `Can you describe a typical care day for ${name}? A sentence or two is great.`);
        return;
    }
    const description = text.trim().slice(0, 500);
    await mergeJobData(phone, { jobDescription: description });
    await updateJobStep(phone, "jp_confirm_post");
    const jobData = await getJobData(phone);
    const summary = buildJobSummary(jobData, session);
    await (0, client_1.sendMessage)(chatId, `Here's your job post:\n\n${summary}\n\nReply YES to post it for caregivers to see, or NO to start over.`);
}
async function handleJpConfirmPost(phone, chatId, text, session) {
    var _a;
    const norm = await parseWithClaude('The user is confirming or declining to post a job. ' +
        '"yes", "yep", "post it", "go ahead", "do it", "confirm", "looks good", "perfect" = YES. ' +
        '"no", "start over", "restart", "redo", "nope", "cancel" = NO. ' +
        'Reply with exactly YES or NO.', text);
    if (norm.toUpperCase() === "NO") {
        await db.collection("agent_sessions").doc(phone).update({
            jobPostingStep: admin.firestore.FieldValue.delete(),
            jobPostingData: admin.firestore.FieldValue.delete(),
            stateExpiresAt: admin.firestore.FieldValue.delete(),
        });
        await (0, client_1.sendMessage)(chatId, "No problem! Text me anytime when you're ready to post a new job.");
        return;
    }
    if (!norm.toUpperCase().startsWith("Y")) {
        const jobData = await getJobData(phone);
        const summary = buildJobSummary(jobData, session);
        await (0, client_1.sendMessage)(chatId, `Just to confirm — here's your job post:\n\n${summary}\n\nReply YES to post it or NO to cancel.`);
        return;
    }
    // YES — post the job
    const uid = session.userId;
    if (!uid) {
        await (0, client_1.sendMessage)(chatId, "I couldn't find your account. Please try again or visit the app to post.");
        return;
    }
    try {
        const onboardingData = (_a = session.onboardingData) !== null && _a !== void 0 ? _a : {};
        const jobData = await getJobData(phone);
        const jobId = await (0, buildJobPost_1.buildAndSaveJobPost)({ uid, phone, onboardingData, jobData });
        await db.collection("agent_sessions").doc(phone).update({
            jobPostingStep: admin.firestore.FieldValue.delete(),
            jobPostingData: admin.firestore.FieldValue.delete(),
            stateExpiresAt: admin.firestore.FieldValue.delete(),
        });
        await (0, client_1.sendMessage)(chatId, `Your care request is live! Caregivers in your area are being notified.\n\n` +
            `I'll let you know when applications come in. You can also view your post at any time by texting me "show my jobs".\n\n` +
            `Job ID: ${jobId}`);
    }
    catch (err) {
        console.error("[jobPostingFlow] buildAndSaveJobPost error:", err);
        await (0, client_1.sendMessage)(chatId, "Sorry, I ran into a problem posting your job. Please try again or visit the app directly.");
    }
}
// ── Summary builder ───────────────────────────────────────────────────────────
function buildJobSummary(jobData, session) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
    const name = seniorFirstName(session);
    const startDate = (_a = jobData.jobStartDate) !== null && _a !== void 0 ? _a : "TBD";
    const frequency = (_b = jobData.jobFrequency) !== null && _b !== void 0 ? _b : "occasional";
    const days = (_c = jobData.jobDays) !== null && _c !== void 0 ? _c : [];
    const times = (_d = jobData.jobTimeOfDay) !== null && _d !== void 0 ? _d : [];
    const careNeeds = (_e = jobData.jobCareNeeds) !== null && _e !== void 0 ? _e : [];
    const careLevel = (_f = jobData.jobCareLevel) !== null && _f !== void 0 ? _f : "moderate";
    const rate = (_g = jobData.jobHourlyRate) !== null && _g !== void 0 ? _g : 0;
    const payMethod = (_h = jobData.jobPaymentMethod) !== null && _h !== void 0 ? _h : "card";
    const pets = jobData.petsInHome ? "yes" : "no";
    const smoking = jobData.smokingHousehold ? "yes" : "no";
    const desc = (_j = jobData.jobDescription) !== null && _j !== void 0 ? _j : "";
    const freqLabel = { occasional: "Occasional", part_time: "Part-time", full_time: "Full-time" };
    const rateLabel = rate > 0 ? `$${rate}/hr` : "Flexible";
    const daysLabel = days.length > 0 ? days.join(", ") : "TBD";
    const timesLabel = times.length > 0
        ? times.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(" & ")
        : "TBD";
    const needsLabel = careNeeds.length > 0 ? careNeeds.join(", ") : "General care";
    return [
        `👤 For: ${name}`,
        `📅 Start: ${startDate}`,
        `🔄 Frequency: ${(_k = freqLabel[frequency]) !== null && _k !== void 0 ? _k : frequency}`,
        `📆 Days: ${daysLabel}`,
        `⏰ Time: ${timesLabel}`,
        `🩺 Care needs: ${needsLabel}`,
        `💪 Care level: ${careLevel.charAt(0).toUpperCase() + careLevel.slice(1)}`,
        `💵 Rate: ${rateLabel} (${payMethod})`,
        `🐾 Pets: ${pets} | 🚬 Smoking: ${smoking}`,
        desc ? `📝 "${desc}"` : "",
    ].filter(Boolean).join("\n");
}
//# sourceMappingURL=jobPostingFlow.js.map