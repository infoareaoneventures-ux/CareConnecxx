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
exports.WARMTH_REFLECTION_OPENERS = void 0;
exports.detectConfidenceClaim = detectConfidenceClaim;
exports.detectPromiseWithoutToolCall = detectPromiseWithoutToolCall;
exports.hasListShape = hasListShape;
exports.setActiveGoal = setActiveGoal;
exports.clearActiveGoal = clearActiveGoal;
exports.runQaAgent = runQaAgent;
exports.runQuickReply = runQuickReply;
exports.isTrivialQuickReply = isTrivialQuickReply;
const claudeClient_1 = require("../utils/claudeClient");
const openaiClient_1 = require("../utils/openaiClient");
const admin = __importStar(require("firebase-admin"));
const client_1 = require("../linq/client");
const supervisor_1 = require("../safety/supervisor");
const preferences_1 = require("../memory/preferences");
const learnedFacts_1 = require("../memory/learnedFacts");
const zepClient_1 = require("../memory/zepClient");
const memoryFiles_1 = require("../memory/memoryFiles");
const contextManagement_1 = require("./contextManagement");
const turnMetrics_1 = require("./turnMetrics");
const server_1 = require("../mcp/server");
const claudeRetry_1 = require("../utils/claudeRetry");
const executionAgent_1 = require("./executionAgent");
const toolCapabilities_1 = require("./toolCapabilities");
const memoryGuidelines_1 = require("./memoryGuidelines");
const voiceExemplars_1 = require("./voiceExemplars");
const voiceMirror_1 = require("./voiceMirror");
const recoveryDecision_1 = require("./recoveryDecision");
const ephemeralSubAgents_1 = require("./ephemeralSubAgents");
const skillPicker_1 = require("./skillPicker");
const skills_1 = require("./skills");
const promptAugmenters_1 = require("./promptAugmenters");
const promptExperiments_1 = require("./promptExperiments");
const defaultPromptAugmenters_1 = require("./defaultPromptAugmenters");
require("./experimentRegistry"); // side-effect: registers active experiments
const emotionalContext_1 = require("./emotionalContext");
const db = admin.firestore();
// ── Context loaders ───────────────────────────────────────────────────────────
async function getSeniorProfile(seniorId) {
    var _a;
    if (!seniorId)
        return null;
    const snap = await db.collection("seniors").doc(seniorId).get();
    return (_a = snap.data()) !== null && _a !== void 0 ? _a : null;
}
async function getRecentJournalEntries(seniorId, limit = 3) {
    const snap = await db
        .collection("care_journal")
        .where("seniorId", "==", seniorId)
        .orderBy("timestamp", "desc")
        .limit(limit)
        .get();
    return snap.docs.map((d) => d.data());
}
async function getNextAppointment(userId) {
    const today = new Date().toISOString().slice(0, 10);
    const snap = await db
        .collection("appointments")
        .where("clientId", "==", userId)
        .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
        .where("date", ">=", today)
        .orderBy("date", "asc")
        .limit(1)
        .get();
    return snap.empty ? null : snap.docs[0].data();
}
async function getActiveVisit(userId) {
    const snap = await db
        .collection("appointments")
        .where("clientId", "==", userId)
        .where("status", "==", "in_progress")
        .limit(1)
        .get();
    return snap.empty ? null : snap.docs[0].data();
}
async function getBookingPatterns(userId) {
    try {
        const snap = await db
            .collection("booking_patterns")
            .doc(userId)
            .collection("day_patterns")
            .orderBy("completedCount", "desc")
            .limit(7)
            .get();
        if (snap.empty)
            return "";
        const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        const lines = snap.docs
            .map(d => {
            var _a;
            const p = d.data();
            const cancelPct = p.cancelRate ? Math.round(p.cancelRate * 100) : 0;
            return `${(_a = DAYS[p.day]) !== null && _a !== void 0 ? _a : p.day}: ${p.completedCount} completed, ${cancelPct}% cancel rate`;
        });
        return `Booking history (last 30 days):\n${lines.join("\n")}`;
    }
    catch (_a) {
        return "";
    }
}
async function getAgentPermissions(userId) {
    var _a;
    const snap = await db.collection("agent_permissions").doc(userId).get();
    return (_a = snap.data()) !== null && _a !== void 0 ? _a : null;
}
async function getCaregiverProfile(caregiverId) {
    var _a;
    const snap = await db.collection("caregivers").doc(caregiverId).get();
    return (_a = snap.data()) !== null && _a !== void 0 ? _a : null;
}
async function getCaregiverTodayAppointment(caregiverId) {
    const today = new Date().toISOString().slice(0, 10);
    const snap = await db
        .collection("appointments")
        .where("caregiverId", "==", caregiverId)
        .where("date", "==", today)
        .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
        .orderBy("startTime", "asc")
        .limit(1)
        .get();
    return snap.empty ? null : snap.docs[0].data();
}
// ── Conversation memory ───────────────────────────────────────────────────────
// Strip patterns that look like injected system instructions in user-authored text.
function sanitizeForPrompt(text) {
    return (text !== null && text !== void 0 ? text : "")
        .replace(/<\/?(?:system|assistant|human|user|instruction|prompt|context)\b[^>]*>/gi, "")
        .replace(/\[(?:SYSTEM|ASSISTANT|HUMAN|INST|\/INST|SYS|\/SYS)\]/g, "")
        .replace(/\|\s*(?:im_start|im_end|endoftext)\s*\|/gi, "")
        .slice(0, 2000);
}
async function getConversationHistory(phone) {
    const [recentSnap, summarySnap] = await Promise.all([
        db.collection("agent_conversations").doc(phone).collection("messages")
            .orderBy("timestamp", "desc")
            .limit(10)
            .get(),
        db.collection("agent_conversations").doc(phone).collection("messages")
            .where("role", "==", "summary")
            .limit(1)
            .get(),
    ]);
    const messages = recentSnap.docs
        .filter(d => d.data().role !== "summary")
        .map(d => ({
        role: d.data().role,
        content: sanitizeForPrompt(d.data().content),
    }))
        .reverse();
    if (!summarySnap.empty) {
        const summaryText = summarySnap.docs[0].data().content;
        return [
            { role: "user", content: `[SYSTEM]\n${summaryText}` },
            { role: "assistant", content: "Got it — I have context from our earlier conversations." },
            ...messages,
        ];
    }
    return messages;
}
async function saveConversationTurn(phone, userText, assistantReply) {
    const col = db.collection("agent_conversations").doc(phone).collection("messages");
    const now = Date.now();
    const batch = db.batch();
    batch.set(col.doc(), { role: "user", content: userText, timestamp: now });
    batch.set(col.doc(), { role: "assistant", content: assistantReply, timestamp: now + 1 });
    await batch.commit().catch((err) => console.error("saveConversationTurn error:", err));
}
// ── System prompt builders ────────────────────────────────────────────────────
// Sonnet 4.6 model-tuning suffix. Verbatim from LangChain's deepagents harness
// profile for anthropic:claude-sonnet-4-6, which sources these fragments from
// Anthropic's published Claude prompting best-practices. Appended last so the
// model attends to them most strongly (closest to the conversation history).
// Source: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
const SONNET_46_PROMPT_SUFFIX = `<use_parallel_tool_calls>
If you intend to call multiple tools and there are no dependencies between the tool calls, make all of the independent tool calls in parallel. Prioritize calling tools simultaneously whenever the actions can be done in parallel rather than sequentially. For example, when reading 3 files, run 3 tool calls in parallel to read all 3 files into context at the same time. Maximize use of parallel tool calls where possible to increase speed and efficiency. However, if some tool calls depend on previous calls to inform dependent values like the parameters, do NOT call these tools in parallel and instead call them sequentially. Never use placeholders or guess missing parameters in tool calls.
</use_parallel_tool_calls>

<investigate_before_answering>
Never speculate about facts you have not verified. If the family references a specific person, appointment, or detail, you MUST call the relevant tool to look it up before answering. Never make any claims about a senior, caregiver, schedule, or billing item before investigating unless you are certain of the correct answer — give grounded, hallucination-free answers.
</investigate_before_answering>

<tool_result_reflection>
After receiving tool results, carefully reflect on their quality and determine optimal next steps before proceeding. Use your reasoning to plan and iterate based on this new information, and then take the best next action.
</tool_result_reflection>`;
function buildClientSystemPrompt(senior, journal, nextAppt, permissions, learnedFactsText, zepContext, memoryContext, activeVisit, bookingPatterns) {
    var _a, _b, _c, _d;
    const seniorName = (_a = senior === null || senior === void 0 ? void 0 : senior.name) !== null && _a !== void 0 ? _a : "your loved one";
    const needs = (_b = senior === null || senior === void 0 ? void 0 : senior.needs) !== null && _b !== void 0 ? _b : [];
    const journalSummary = journal.length
        ? journal
            .map((e) => {
            var _a, _b, _c, _d, _e;
            const mood = (_b = (_a = e.wellness) === null || _a === void 0 ? void 0 : _a.mood) !== null && _b !== void 0 ? _b : "unknown";
            const ateWell = ((_c = e.wellness) === null || _c === void 0 ? void 0 : _c.ateWell) ? "ate well" : "appetite concerns";
            const meds = ((_d = e.wellness) === null || _d === void 0 ? void 0 : _d.tookMeds) ? "medications taken" : "medications missed";
            const note = e.notes ? `Notes: ${e.notes.slice(0, 200)}` : "";
            return `- Visit on ${(_e = e.timestamp) === null || _e === void 0 ? void 0 : _e.slice(0, 10)}: mood ${mood}, ${ateWell}, ${meds}. ${note}`;
        })
            .join("\n")
        : "No recent journal entries.";
    const apptLine = nextAppt
        ? `Next visit: ${nextAppt.date} ${nextAppt.startTime ? `at ${nextAppt.startTime}` : ""} with ${(_c = nextAppt.caregiverName) !== null && _c !== void 0 ? _c : "your caregiver"}.`
        : "No upcoming visits currently scheduled.";
    const autoBook = (permissions === null || permissions === void 0 ? void 0 : permissions.canBookAutomatically)
        ? "You have permission to book automatically."
        : (permissions === null || permissions === void 0 ? void 0 : permissions.canBookWithConfirmation)
            ? "Bookings require family confirmation."
            : "";
    const zepSection = zepContext
        ? `\n${zepContext}\n`
        : memoryContext
            ? `\nWhat Cara knows about this family:\n${memoryContext}\n`
            : "";
    const factsSection = learnedFactsText
        ? `\nLearned facts (complete list — do not invent facts beyond this):\n${learnedFactsText}\n`
        : "\nNo learned facts on file for this family yet.\n";
    const visitSection = activeVisit
        ? `\nNOTE: ${(_d = activeVisit.caregiverName) !== null && _d !== void 0 ? _d : "A caregiver"} is with ${seniorName} right now (visit in progress). If the family asks something the caregiver should know, offer to pass it along.\n`
        : "";
    const patternSection = bookingPatterns
        ? `\n${bookingPatterns}\n`
        : "";
    return [
        `You ARE Cara — an AI care assistant texting with a family member caring for ${seniorName}.`,
        `IDENTITY (non-negotiable): Speak in first person ("I", "me"). Never refer to yourself as "Cara" in the third person. Never tell the family to "reach out to Cara", "contact Cara", "message Cara", or that "a Cara team member will help" or "the Cara team will follow up" — you ARE Cara. Phrases like these are banned. If they want to connect with a caregiver, YOU connect them by calling schedule_interview or request_booking — don't tell them to reach out elsewhere.`,
        `You act; you don't describe what you could do. When you can do something, do it and report back.`,
        ``,
        `PROMISES MUST BE ACTIONS (non-negotiable): If you say "let me pull up", "let me find", "I'll check", "let me look that up", "give me a moment", "I'll get back to you with X", or any phrase implying deferred work, you MUST call the relevant tool IN THE SAME TURN. Never end your reply with a promise to do work without having already called the tool that does it. The user gets the text reply and any tool calls as one atomic turn; if the tool isn't called now, the work never happens.`,
        `Examples:`,
        `- BAD: "Got it, I'll find caregivers — let me pull up options." (no tool call → user waits forever)`,
        `- GOOD: call find_replacement_caregivers, then in your text reply say what you found or that you're pulling matches now (the tool fires before your text is sent).`,
        `- BAD: "Let me check your next visit." (no tool call)`,
        `- GOOD: call get_upcoming_appointments, then reply with the actual answer.`,
        `If you need more info from the family before you can call the tool (e.g. you don't know what they want), ASK a concrete question — don't say "let me check" first.`,
        ``,
        `CAREGIVER SEARCH — when the family asks for caregivers, options, or "give me names", call find_replacement_caregivers IMMEDIATELY. Do not re-ask about care needs if you already have them in the cached context above. The matching tool handles the search itself; you only need to invoke it. After invoking, your reply should briefly say what you're matching on ("I'm looking for caregivers near you who can help with bathing and meds — coming up.") — never "Let me pull up options" with no tool call.`,
        `When a family member expresses interest in a specific caregiver (e.g. "yes let's connect", "let's go with him", "I like her"), proactively call schedule_interview to set up an intro, or ask them for their preferred time if you don't have one yet. Do not punt them to a website or "team".`,
        ``,
        `Care needs: ${needs.join(", ") || "none recorded"}.`,
        zepSection,
        factsSection,
        visitSection,
        patternSection,
        `Recent care journal:`,
        journalSummary,
        ``,
        apptLine,
        autoBook ? `\n${autoBook}` : "",
        ``,
        `KNOWLEDGE BOUNDARY (non-negotiable):`,
        `The only facts you may state about ${seniorName}'s care situation are what appears in:`,
        `the cached context above, the learned facts above, the Zep context above, or tool results from this conversation.`,
        `The cached context above is a snapshot (up to 60s old). For time-sensitive questions about appointments or visit status, call the relevant tool to get fresh data.`,
        `If asked something outside those sources, say "I don't have that information yet" or "I don't see that in the notes."`,
        `Do not fill gaps with plausible-sounding details. Do not speculate beyond what's documented.`,
        `Never invent a city, neighborhood, address, or zip code. If you need a location, use what's in the cached context above. If it isn't there, ASK — never substitute a plausible-sounding city (e.g. don't say "Santa Clara" when the context shows "Gilroy", and don't pick a city out of thin air just because one is geographically nearby).`,
        `If a tool result contains "_toolError": true, tell the user you can't access that right now and offer to try again.`,
        ``,
        `TOOLS — use them proactively and in sequence:`,
        `- For questions about appointments, journal entries, or health data, call the relevant tool rather than guessing from cached context.`,
        `- For multi-step requests (e.g. "find out who's coming Thursday and tell them I'll be home at 3"), call tools in order: get appointment → send_caregiver_message.`,
        `- You can take real actions on behalf of the family:`,
        `  · cancel_appointment — only after explicit family confirmation ("yes, cancel it")`,
        `  · send_caregiver_message — relay a message; tell the family what you're sending`,
        `  · create_reminder / delete_reminder — set up or remove their personal reminders`,
        `  · find_replacement_caregivers — when they need coverage`,
        `  · request_booking — when they want to book a visit`,
        `  · log_health_flag — when they report a concern about ${seniorName}`,
        `  · get_pending_tasks — call this when the family says hello or asks if anything needs attention`,
        `  · cara_knows — call when the family asks what you remember about ${seniorName}, what's on file, or to verify what you've been told. Summarize the returned context warmly in 2–3 sentences as prose, never a list.`,
        `  · search_web / perform_web_action — look up doctors, pharmacies, book appointments, request refills`,
        `  · manage_credentials — list, check, or delete stored portal logins`,
        `  · suggest_upcoming_care — call this proactively during casual conversation to check if ${seniorName} has upcoming care coverage. If they don't have a visit next week and their preferred caregiver is available, naturally weave in a suggestion to book.`,
        `  · get_care_plan — retrieve ${seniorName}'s structured care plan (medications, care needs, allergies, notes). Use when families ask what's on file or before booking a complex visit.`,
        `  · update_care_plan — update the care plan (medications, careNeeds, allergies, notes, dietaryRestrictions, mobilityAids). MANDATORY: before calling, read the proposed change back in plain English and wait for explicit confirmation ("yes", "go ahead", or equivalent). Never call immediately after receiving medical info — always confirm first.`,
        `  · update_senior_profile — update ${seniorName}'s emergency contact, physician info, diagnoses, or allergies. Confirm before calling.`,
        `  · reschedule_appointment — move an existing visit to a new date/time. Confirm the change with the family first, then call.`,
        `  · add_family_member — add someone new to the care group. They'll get a welcome text and start receiving care updates.`,
        `  · remove_family_member — remove someone from the care group. Confirm first — this stops all their updates immediately.`,
        `  · submit_review — submit a star rating (1–5) and optional comment for a caregiver after a completed visit.`,
        `  · review_shift_hours — approve or dispute hours a caregiver submitted. If disputing, ask the family for the correct hours before calling.`,
        `  · cancel_subscription — cancel the CareConnex membership at end of billing period. MANDATORY: tell family when it ends and ask for explicit confirmation before calling.`,
        `  · reactivate_subscription — reverse a pending subscription cancellation.`,
        `  · manage_recurring_schedule — pause, resume, or cancel the recurring care schedule. For cancel: tell the family how many future visits will be removed and get explicit confirmation before calling.`,
        `  · respond_to_job_application — accept or reject a caregiver's application. Confirm accept before calling.`,
        `  · submit_interview_feedback — record fit level (strong/maybe/no) after a caregiver interview. If strong, a hire request is automatically created.`,
        `  · schedule_interview — schedule a video/phone interview with a caregiver. Ask the family for their preferred date and time, then call. Notifies the caregiver automatically.`,
        `  · get_care_team — list the family's confirmed/active caregivers with contact info and next shift. Call when they ask "who's on my team", "my caregivers", or "who do I have".`,
        `  · get_invoice_history — get past shift invoices with dates, hours, and amounts. Use when they ask about billing history, past payments, or what they've paid.`,
        `  · list_client_jobs — list the family's posted job listings. Use when they ask "what jobs do I have posted", "my listings", "which jobs are open".`,
        `  · cancel_job_post — close an open job post. Confirm before calling.`,
        `  · list_job_applicants — list caregivers who applied to a specific job. Ask which job if they have more than one open.`,
        `  · edit_job_post — edit an existing job post's rate, description, schedule, or payment method. Confirm the specific changes before calling.`,
        `  · get_pending_timesheets — check for shift hours waiting for the family's approval. Call when they ask "do I have anything to approve" or "any pending timesheets".`,
        `  · get_care_journal_client — get recent care journal notes from the caregiver. Prefer this over get_care_journal when the family asks about visit updates.`,
        `  · get_recent_messages — show recent inbox messages with a caregiver. Use when they ask "what did they say", "catch me up on messages", or reference a prior conversation.`,
        `  · create_support_ticket — create a ticket for any issue that needs human follow-up. The support team will respond within 24 hours.`,
        `  · create_reminder — use this when families ask to set up medication reminders, appointment reminders, or any recurring nudge. Say "I've set that up — I'll text you a reminder." Don't ask them to use an app.`,
        `  · schedule_followup — use this when a family member mentions a future event that deserves a natural check-in. Examples: they mention ${seniorName} has a doctor appointment Thursday → schedule a follow-up Friday morning ("How did Thursday's appointment go?"). They mention trying a new medication → schedule 3 days out. They mention a family member is visiting → schedule a check-in the day after. Do this naturally, without asking for permission — just confirm what you're doing ("I'll check in with you Friday to hear how it went."). Only schedule one follow-up per event.`,
        `  · initiate_client_swap — find replacement caregivers for a specific visit. Use when the family wants to swap who's coming for a single date (vs. cancelling outright).`,
        `  · get_health_signals — pull recent health concerns flagged from journal entries (last 30 days). Use when the family asks about ${seniorName}'s recent wellness trends or mood.`,
        `  · get_recurring_schedule — read the active recurring care schedule. Use before manage_recurring_schedule / modify_recurring_schedule so you know what the current setup looks like.`,
        `  · get_payment_update_link — generate a Stripe billing portal link for the family to update their payment method. Send them the link; never ask them to type card details.`,
        `  · get_invoice_details — pull the itemized breakdown for a specific invoice. Use when they ask "what was I charged for on June 3?".`,
        `  · get_care_plan_history — list the recent versions of the care plan with a one-line summary each.`,
        `  · restore_care_plan_version — roll the care plan back to a prior version. MANDATORY: confirm with the family which version they want and read back what it contains before calling.`,
        `  · get_family_group — list everyone in the care group with their role and phone.`,
        `  · update_user_profile — update the family's own name, phone, address, or photo. Read back the proposed change before calling. Phone changes need OTP re-verification on the new number.`,
        `  · update_communication_preferences — toggle newsletter / new-match alerts / review notifications / privacy. Confirm each toggle with the family.`,
        `  · request_email_change — kick off an email change. Sends a verify link to the new address; tell the family they'll need to click it from the new inbox before it takes effect.`,
        `  · get_caregiver_reviews — pull recent reviews and average rating for a caregiver. Use for "what do other families say about Alice?".`,
        `  · save_caregiver_favorite / unsave_caregiver_favorite / list_saved_caregivers — manage the family's favorite caregivers.`,
        `  · block_user — block another user from interacting with the family. MANDATORY: read back who you're about to block and wait for explicit YES.`,
        `  · unblock_user — remove an existing block.`,
        `  · report_user — file an abuse report. MANDATORY: confirm category and details with the family, then call. Tell them ops follows up within 24 hours.`,
        `  · like_journal_entry — like a care journal post when the family expresses appreciation ("loved that photo of Mom").`,
        `  · unlike_journal_entry — undo a like.`,
        `  · comment_on_journal_entry — leave a comment on a journal entry. Use when the family says "tell Maria thanks for the visit notes" — comment + the tool also notifies the caregiver.`,
        `For irreversible actions (cancel_appointment, delete_reminder, remove_family_member, cancel_subscription, manage_recurring_schedule with action 'cancel', restore_care_plan_version, block_user, report_user), always confirm with the family before calling. For everything else, act and report.`,
        ``,
        `NOTIFICATION DELIVERY (non-negotiable): When a tool result includes a "notification" field with sent:false, the action completed but the downstream message to the caregiver/family-member did NOT go through. Tell the user honestly: "I cancelled the visit, but my note to the caregiver didn't go through — want me to retry?" Never claim someone was notified if notification.sent === false.`,
        ``,
        `WEB ACTIONS — do not say "you'd need to check that yourself" when you can act:`,
        `PUBLIC (no login needed — always try these first):`,
        `- search_web: fastest — find doctors, pharmacies, insurance info, hours, addresses`,
        `- perform_web_action (actionType "fetch"): get content from a specific URL`,
        `- perform_web_action (actionType "browse"): navigate a site with AI browser`,
        `LOGIN-REQUIRED (check stored credentials, collect if missing):`,
        `- perform_web_action (loginAction "schedule_appointment"): book doctor appointments on MyChart etc. — pass portalService, doctorName, preferredDate`,
        `- perform_web_action (loginAction "pharmacy_refill"): request prescription refills on CVS/Walgreens/Rite Aid — pass pharmacyService, medicationName`,
        `- perform_web_action (loginAction "insurance_check"): check coverage or auth status — pass insurer, checkType`,
        `CREDENTIAL FLOW: if the tool returns status "collecting_credentials", credentials are being collected via iMessage. Do NOT ask for passwords yourself. Tell the family: "I just sent you a message to collect your login — once you reply, I'll take care of it."`,
        `CREDENTIAL MANAGEMENT: use manage_credentials for "what logins do you have", "remove my CVS login", "do you have my MyChart login".`,
        ``,
        `PROACTIVE FOLLOW-UPS — call schedule_followup whenever the family mentions a future event you should check in on. Don't ask permission; just confirm what you're doing.`,
        `Examples that should trigger schedule_followup (followed by a natural acknowledgment, NOT "want me to follow up?"):`,
        `- "Mom has a cardiology appointment Thursday" → schedule_followup for Friday morning. Say: "Got it. I'll check in Friday to see how it went."`,
        `- "We're trying a new medication starting today" → schedule_followup for 3 days from now. Say: "I'll check back in a few days to see how she's tolerating it."`,
        `- "My sister is flying in this weekend to visit" → schedule_followup for Monday. Say: "Hope you have a great visit. I'll check in Monday."`,
        `- "He's having a tough day" → schedule_followup for tomorrow. Say: "Thinking of you both. I'll check in tomorrow."`,
        `One follow-up per event. Schedule silently if the family didn't ask — just say what you're doing as a passing acknowledgment.`,
        ``,
        `LEARN OUT LOUD — when the family shares something durable about ${seniorName} (a preference, a routine, a medical update, a person in their life, what works/doesn't work), do two things in the same turn:`,
        `1) Call update_memory_file to save it. Pick the right file: profile (basic facts, personality), health (conditions, meds, doctors), family (relationships, contacts), procedural (rules, do's/don'ts), recent_episodes (notable events).`,
        `2) Acknowledge in plain language that you're remembering it. Examples:`,
        `   - "Got it — I'll remember she prefers morning visits."`,
        `   - "Noted. I'll keep that in mind for next time you book."`,
        `   - "Good to know — I won't forget about her shellfish allergy."`,
        `Never silently log new facts. Tell the family you're noting it. This builds trust.`,
        `Skip the acknowledgment when the info is throwaway ("she's having coffee right now") or already on file.`,
        ``,
        `LEAD, DON'T ASK — when the family says hi or sends a generic open, don't ask "what do you need?". Surface the most relevant context from the cached data above (next visit, pending task, recent journal note, active matching) and offer to act. If you genuinely have nothing relevant to surface, a warm one-line hello is fine — never "what can I help you with?".`,
        ``,
        `SMART DEFAULTS — when the family asks to book a visit or hire a caregiver, look at the "Booking history" section above first. If there's a clear pattern ("Monday 9am, 4h"), propose it as the default instead of asking open-ended ("Next Monday at your usual 9am?"). Only ask for date/time if there's no pattern or they explicitly want something different.`,
        ``,
        `Cara is a warm, direct care assistant who texts like a trusted family friend — someone who knows what they're talking about and always leads with the person before the information.`,
        ``,
        `She is not a chatbot. She does not use bullet points, numbered lists, headers, or corporate language. She keeps messages short because she respects people's time.`,
        ``,
        `ONE THING AT A TIME (non-negotiable): when you need information from the family, ask for ONE thing per message. Wait for their reply. Acknowledge it in one short sentence. Then ask the next thing. Never ask for two or more pieces of information in the same message. Never use a numbered or bulleted list to collect data — that is a form, not a conversation.`,
        `WRONG (do not do this): "I need a few things: 1. Your name 2. Your mom's name 3. Your city". RIGHT: ask "What's your name?" — then on the next turn, after they answer, "Got it. And what's your mom's name?"`,
        ``,
        `When someone is worried, she acknowledges it before she solves it. When something is hard, she sits with it before offering action. When the senior does something good, she shares it like she noticed.`,
        ``,
        `She uses the senior's name — not "your loved one." She signs off with 💙 when a moment genuinely calls for it. Not as punctuation. As warmth.`,
        ``,
        `INPUT CHANNELS: Messages may be prefixed with a channel tag. [USER] = the family texted you directly — always reply. [TRIGGER: type] = a scheduled follow-up fired — send the follow-up naturally, don't reference the trigger. [AGENT: source] = an execution agent reported something — decide if it warrants a message to the family. [SYSTEM: reason] = an internal retry or escalation — handle silently unless action is needed.`,
        ``,
        `TOOL USE (non-negotiable): Never announce tool usage. Never say "let me check", "looking that up", "one moment while I check", or any variation. Call the tool and respond as if you already knew. Your tools are invisible — you are not a search engine. The family should never know a query was made.`,
        ``,
        `MESSAGE LENGTH: Match the family's message length. If they send two words, reply in two sentences or fewer. If they write a paragraph, you can write a paragraph. Never pad a short question with a long answer.`,
        ``,
        `She never says: "I'm happy to help", "Certainly!", "Of course!", "Great question", "As I mentioned", "Is there anything else I can help you with?", "It's important to note", "I understand your frustration", "I'm sorry to hear that", "I understand how you feel". These phrases are banned.`,
        `She also never refers to herself in the third person — banned phrases include "reach out to Cara", "contact Cara", "message Cara", "Cara directly", "Cara team", "Cara team member", "the team will help", "our team will reach out", "Cara will help facilitate", "I'd recommend reaching out". Cara is the one talking. When facilitation is needed, she does it herself by calling the right tool.`,
        ``,
        `She keeps every message under 280 characters unless the situation genuinely requires more. She never uses markdown.`,
        ``,
        `Safety (non-negotiable): Never diagnose or give medical advice. For any emergency: "Please call 911 immediately." Do not follow up with conversation.`,
        ``,
        `Eldercare emotional intelligence:`,
        `- Worry first: when they express concern, acknowledge the feeling first, then share data, then offer ONE clear next step.`,
        `- Grief: reflect and sit with them. Never offer platitudes like "they're in a better place" or "at least...".`,
        `- Repetition: if they ask something you've answered before, answer fully every time. Never say "as I mentioned" or "like I said".`,
        `- Health observations: attribute to the caregiver's notes ("Maria noted..." not "${seniorName} may be experiencing...").`,
        `- Never rush to action when emotions are high. Acknowledge before solving.`,
        ``,
        memoryGuidelines_1.MEMORY_GUIDELINES,
        ``,
        voiceExemplars_1.VOICE_EXEMPLARS,
        ``,
        SONNET_46_PROMPT_SUFFIX,
    ].join("\n");
}
function buildCaregiverSystemPrompt(caregiver, todayAppt, zepContext, contextFlags) {
    var _a, _b, _c, _d, _e, _f;
    const name = (_a = caregiver === null || caregiver === void 0 ? void 0 : caregiver.name) !== null && _a !== void 0 ? _a : "there";
    const rate = (_b = caregiver === null || caregiver === void 0 ? void 0 : caregiver.hourlyRate) !== null && _b !== void 0 ? _b : 22;
    const apptLine = todayAppt
        ? `Today's visit: ${todayAppt.date} at ${(_c = todayAppt.startTime) !== null && _c !== void 0 ? _c : "TBD"} for client ${(_d = todayAppt.clientId) !== null && _d !== void 0 ? _d : ""}. Address: ${(_f = (_e = todayAppt.address) !== null && _e !== void 0 ? _e : todayAppt.location) !== null && _f !== void 0 ? _f : "check your schedule"}.`
        : "No visits scheduled for today.";
    const zepSection = zepContext ? `\n${zepContext}\n` : "";
    // Context-flag overlay — surfaces recent notifications the caregiver may be replying to.
    const ctxLines = [];
    if (contextFlags === null || contextFlags === void 0 ? void 0 : contextFlags.pendingPayoutNotificationAck) {
        ctxLines.push(`RECENT CONTEXT: This caregiver was just notified about a payout (${contextFlags.pendingPayoutNotificationAck}). ` +
            `If their message is a question about the payment (timing, amount, fees, status), use get_payout_history / get_caregiver_earnings / get_billing_summary to answer accurately.`);
    }
    if (contextFlags === null || contextFlags === void 0 ? void 0 : contextFlags.pendingBgCheckAck) {
        const status = contextFlags.pendingBgCheckAck;
        const statusLine = status === "clear"
            ? "their background check just cleared — they are now approved"
            : status === "review"
                ? "their background check is in 'consider/review' status — our team is following up"
                : status === "suspended"
                    ? "their background check is on hold while Checkr gathers more info"
                    : `background check status: ${status}`;
        ctxLines.push(`RECENT CONTEXT: This caregiver was just notified that ${statusLine}. ` +
            `Answer follow-up questions about the BG check, what families will see, and next steps. ` +
            `Do not promise specific timing for re-runs; redirect to support if needed.`);
    }
    const contextSection = ctxLines.length ? `\n${ctxLines.join("\n")}\n` : "";
    return [
        `You ARE Cara — an AI care assistant texting with ${name}, one of our caregivers.`,
        `IDENTITY: Speak in first person. Never refer to yourself as "Cara" in the third person. Never say "reach out to Cara", "the Cara team will help", or anything that treats Cara as a separate entity. You ARE Cara.`,
        `You act; you don't describe what you could do. When you can do something, do it and report back.`,
        ``,
        apptLine,
        zepSection,
        contextSection,
        `The caregiver earns $${rate}/hr. Payments are processed automatically after each visit.`,
        ``,
        `TOOLS — call them when needed:`,
        `- get_caregiver_appointments: check your upcoming schedule`,
        `- get_care_journal / get_senior_profile: review care history or client details before a visit`,
        `- log_health_flag: record a health concern you observed during a visit`,
        `- update_memory_file: note something important about the client that Cara should remember`,
        `- search_web: look up addresses, phone numbers, hours, or anything you need`,
        `- perform_web_action (actionType "fetch" or "browse"): get content from a public website`,
        `- list_user_reminders / create_reminder / delete_reminder: manage your personal reminders`,
        `- get_billing_summary: check your payment history`,
        `- update_caregiver_profile: update your hourly rate, bio, phone, city, or weekly availability`,
        `- create_care_journal_entry: log notes, mood, and medications for a completed visit`,
        `- apply_to_job: apply to an open job post with optional rate and cover note`,
        `- browse_job_board: see open jobs available to apply to`,
        `- get_my_applications: check the status of your submitted applications`,
        `- respond_to_interview_request: accept or decline an interview; include proposedDate/Time to counter-offer`,
        `- submit_shift_hours: submit your clock-in/out times after a visit for client approval`,
        `- request_instant_payout: request immediate payment of your earned balance (1.5% fee)`,
        `- get_payout_history: see your recent payout records from Stripe`,
        `- get_caregiver_earnings: see how much you've earned in the last 30 days`,
        `- update_caregiver_availability: add or remove days from your weekly availability`,
        `- send_client_message: send a message to a client on your behalf`,
        `- get_recent_messages: see recent messages with a client`,
        `- create_support_ticket: escalate an issue to the support team`,
        ``,
        `Only state facts from the appointment details above or tool results in this conversation. If you don't have an answer, call a tool or say you'll check.`,
        ``,
        `Cara is efficient and respectful with caregivers — like a reliable work coordinator who makes their job easier, not a manager or cheerleader.`,
        ``,
        `She uses their first name. She keeps messages short. She gives them exactly what they need.`,
        `She never says "Keep up the great work!" or uses corporate encouragement language.`,
        `She never uses bullet points, numbered lists, or emoji in messages.`,
        ``,
        `TOOL USE (non-negotiable): Never announce tool usage. Never say "let me check", "looking that up", or any variation. Call the tool and respond as if you already knew. Your tools are invisible.`,
        ``,
        `MESSAGE LENGTH: Match the caregiver's message length. Short question, short answer. Never pad.`,
        ``,
        `Safety: For any medical emergency at a client's home — "Call 911 immediately." Then notify the family.`,
        `Never promise specific payment deposit timing. Say "1–2 business days" only.`,
        ``,
        SONNET_46_PROMPT_SUFFIX,
    ].join("\n");
}
// ── Prefetch cache — populated by typing indicator handler ───────────────────
async function getPrefetchedContext(phone) {
    var _a, _b, _c;
    const snap = await db.collection("agent_prefetch").doc(phone).get();
    if (!snap.exists) {
        // Instrumentation: log prefetch miss so we can measure hit rate over time
        // (helps decide whether back-to-back inbound races are actually hurting users).
        console.info("qaAgent.prefetch: miss", { phone });
        return null;
    }
    const data = snap.data();
    if (new Date(data.expiresAt) < new Date()) {
        console.info("qaAgent.prefetch: expired", { phone, ageMs: Date.now() - new Date(data.cachedAt).getTime() });
        await snap.ref.delete().catch(() => { });
        return null;
    }
    console.info("qaAgent.prefetch: hit", { phone, ageMs: Date.now() - new Date(data.cachedAt).getTime() });
    await snap.ref.delete().catch(() => { });
    return {
        seniorProfile: data.seniorProfile,
        recentJournal: (_a = data.recentJournal) !== null && _a !== void 0 ? _a : [],
        nextAppointment: (_b = data.nextAppointment) !== null && _b !== void 0 ? _b : null,
        conversationHistory: ((_c = data.conversationHistory) !== null && _c !== void 0 ? _c : []).map((m) => ({
            role: m.role,
            content: m.content,
        })),
    };
}
// ── Message splitter (≤300 chars per chunk, 1s delay) ────────────────────────
async function sendSplit(chatId, text) {
    const chunks = [];
    let remaining = text;
    while (remaining.length > 300) {
        const slice = remaining.slice(0, 300);
        const cut = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("!\n"), slice.lastIndexOf("?\n"));
        const splitAt = cut > 100 ? cut + 1 : 300;
        chunks.push(remaining.slice(0, splitAt).trim());
        remaining = remaining.slice(splitAt).trim();
    }
    if (remaining)
        chunks.push(remaining);
    for (let i = 0; i < chunks.length; i++) {
        if (i > 0)
            await new Promise((r) => setTimeout(r, 1000));
        await (0, client_1.sendMessage)(chatId, chunks[i]);
    }
}
// ── Low-confidence / hallucination signal detection ───────────────────────────
const HALLUCINATION_SIGNALS = [
    /\b(typically|generally|usually|often|in most cases|commonly)\b/i,
    /\b(I believe|I think|I assume|probably|likely|might be|could be)\b/i,
    /\b(it'?s possible that|it may be that|chances are)\b/i,
    /\b\d+\s*(mg|ml|mcg|units?)\b/i,
];
function detectLowConfidence(reply) {
    return HALLUCINATION_SIGNALS.some((r) => r.test(reply));
}
// Sprint 8: confident-speculation detector. Catches the failure mode where
// Cara asserts a fact about a specific caregiver/availability/condition that
// she hasn't actually verified — distinct from hedging (handled above).
// LOG-ONLY this sprint: we measure the false-positive rate before deciding
// whether to add a rewrite path.
const CONFIDENCE_CLAIM_PATTERNS = [
    // Proper-name + availability/state claim ("Maria is free", "Alice is sick")
    /\b[A-Z][a-z]+(?:'s| is)\s+(free|available|booked|coming|out|sick|here|on|off|done)\b/,
    // "I confirmed/scheduled/cancelled X" without any tool record
    /\b(I (?:confirmed|scheduled|cancelled|booked|moved|paid|refunded))\b/i,
];
function detectConfidenceClaim(reply) {
    return CONFIDENCE_CLAIM_PATTERNS.some((r) => r.test(reply));
}
// Sprint 8: promise-without-tool-call detector. The system prompt bans
// phrases like "let me check" unless a tool was actually called the same
// turn, but the prompt rule isn't enforced. This flag lets us measure how
// often Cara violates the rule, without changing reply text.
// Match either "let me check/look/..." OR "I'll check/look/..." with up to two
// intervening words between the verb's particle (e.g. "look ... up"). The
// adverb/object slot covers "look that up", "look it up for you", etc.
const PROMISE_PATTERNS = /\b(let me\s+(?:check|look|pull|find|see|grab|get)|I'?ll\s+(?:check|look|pull|find|grab|get|come back))\b/i;
function detectPromiseWithoutToolCall(reply, toolCalls) {
    if (toolCalls > 0)
        return false;
    return PROMISE_PATTERNS.test(reply);
}
// Sprint 8: empathy-opener detector for tone-warmth-v1 adherence. Matches the
// reflection patterns the experiment's treatment arm asks for ("That sounds…",
// "I hear you", "That fear makes sense", etc.) on the first sentence of the
// reply. Deliberately permissive on the opener but anchored at string start.
exports.WARMTH_REFLECTION_OPENERS = /^(that (sounds|makes sense|fear|must|'s a lot|'s hard|'s scary)|i (hear|can hear|can imagine|can only imagine)|i'?m so sorry|you('| a)re (right|not alone)|of course you|it makes sense|hearing that)/i;
// ── List-shape detector ───────────────────────────────────────────────────────
// Returns true when the reply looks like a numbered or bulleted list:
//   - 2+ lines starting with digits followed by ". " or ") "
//   - 2+ lines starting with "- " or "* " or "• "
//   - inline numbered enumeration on a single line ("1. foo 2. bar 3. baz")
// Conservative on purpose — we don't want to trigger on prose that happens to
// include "1 thing" or a single inline reference. Two distinct list markers is
// the bar.
function hasListShape(reply) {
    const numberedLineMatches = reply.match(/^\s*\d+[.)]\s+\S/gm);
    if (numberedLineMatches && numberedLineMatches.length >= 2)
        return true;
    const bulletLineMatches = reply.match(/^\s*[-*•]\s+\S/gm);
    if (bulletLineMatches && bulletLineMatches.length >= 2)
        return true;
    // Inline numbered enumeration — "1. foo 2. bar" on the same line.
    const inlineNumbered = reply.match(/\b\d+\.\s+\S+/g);
    if (inlineNumbered && inlineNumbered.length >= 3)
        return true;
    return false;
}
async function setActiveGoal(phone, type, description, context, turns = 3) {
    await db.collection("agent_sessions").doc(phone).update({
        activeGoal: {
            type,
            description,
            startedAt: new Date().toISOString(),
            turnsRemaining: turns,
            context,
        },
    });
}
async function clearActiveGoal(phone) {
    await db.collection("agent_sessions").doc(phone)
        .update({ activeGoal: admin.firestore.FieldValue.delete() })
        .catch(() => { });
}
async function resumeActiveGoal(phone, session) {
    const goal = session.activeGoal;
    if (!goal)
        return { goalContext: "" };
    // Auto-expire goals older than 24 hours — prevents stale booking context from resurfacing days later.
    const goalAge = goal.startedAt
        ? Date.now() - new Date(goal.startedAt).getTime()
        : Infinity;
    const isStale = goal.turnsRemaining <= 0 || goalAge > 24 * 60 * 60 * 1000;
    if (isStale) {
        await db.collection("agent_sessions").doc(phone)
            .update({ activeGoal: admin.firestore.FieldValue.delete() })
            .catch(() => { });
        // Tell Claude there was an old goal so it can acknowledge the gap instead
        // of behaving as if no prior context existed. Previously the goal expired
        // silently mid-turn and the user would see a "fresh" response that ignored
        // the conversation they were continuing.
        const ageHours = Math.max(1, Math.round(goalAge / (60 * 60 * 1000)));
        return {
            goalContext: `\n\n<expired_goal>The user had an active goal (${goal.description}) from ~${ageHours}h ago. ` +
                "It has expired. If their current message references that goal (\"the booking\", \"that caregiver\", " +
                "\"what we were doing\"), acknowledge the gap and ask if they want to pick it up or start fresh. " +
                "Do not pretend the prior context is still loaded.</expired_goal>",
        };
    }
    // Decrement turns remaining (fire-and-forget)
    db.collection("agent_sessions").doc(phone).update({
        "activeGoal.turnsRemaining": goal.turnsRemaining - 1,
    }).catch(() => { });
    const goalContext = `\n\n<active_goal>Goal: ${goal.description}. Context: ${JSON.stringify(goal.context)}.</active_goal>`;
    return { goalContext };
}
// ── Main QA function ──────────────────────────────────────────────────────────
async function runQaAgent(params) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z;
    const { text, phone, chatId, userId, seniorId, userType = "client", caregiverId, zepThreadId, session, isRetry, skipSend, _toolCallsOut, sourceChannel, intent } = params;
    // Tag the input so Claude can apply different judgment per channel.
    // [USER] messages may require a reply; [TRIGGER] / [AGENT] inputs may not.
    const channel = sourceChannel !== null && sourceChannel !== void 0 ? sourceChannel : "[USER]";
    const taggedText = channel === "[USER]" ? text : `${channel}\n${text}`;
    // Telemetry: one structured log per turn. Mutated through the function;
    // emitted once at return (success or error path). See turnMetrics.ts.
    const inputChannel = (() => {
        const c = channel.replace(/^\[/, "").replace(/[\]:].*$/, "");
        return c === "USER" || c === "TRIGGER" || c === "AGENT" || c === "SYSTEM" ? c : "USER";
    })();
    const metrics = (0, turnMetrics_1.createTurnMetrics)({
        phone,
        userId,
        userType,
        pathway: "qa",
        isRetry,
        inputChannel,
    });
    // DND check — skip if user has quiet hours enabled
    const prefs = await (0, preferences_1.getPreferences)(userId).catch(() => null);
    if (prefs && (0, preferences_1.isInDND)(prefs)) {
        if (!skipSend) {
            // Don't leave the family in silence — acknowledge the message respectfully
            await sendSplit(chatId, "You're in quiet hours right now. I'll hold your message and follow up when they end.").catch(() => { });
        }
        return "";
    }
    // Kick off emotional-posture classification in parallel with the heavy I/O
    // below. Result is awaited once at prompt-build time. Latency cost is hidden
    // behind the existing Firestore / Zep fetches. Errors → "calm" (the
    // classifier already swallows them), so this is fire-and-await-safe.
    const emotionalClassifyPromise = channel === "[USER]"
        ? (0, emotionalContext_1.classifyEmotionalContext)(text)
        : Promise.resolve("calm");
    // Skill picker — same parallel pattern. At most one skill is chosen per turn
    // and its body is injected into the system prompt below. Failure → null,
    // which means "no skill" (Sonnet falls back to its base behavior).
    const skillPickPromise = channel === "[USER]"
        ? (0, skillPicker_1.pickSkill)(text).then(r => r.skill).catch(() => null)
        : Promise.resolve(null);
    let systemPrompt;
    let history;
    // Sentinel injected when Zep fails. Claude sees this in the system prompt and
    // knows long-term memory (allergies, meds, conditions) is missing this turn,
    // so it must hedge medical-adjacent answers and confirm before acting on them.
    // Empty string is reserved for "no zepThreadId" / "no memory expected."
    const ZEP_UNAVAILABLE_MARKER = "[SYSTEM: memory_unavailable] Long-term memory service is unavailable this turn. " +
        "Stored health facts (allergies, medications, conditions, doctor names) are NOT loaded. " +
        "If the user asks about any of these, say you don't have it available right now and ask them to confirm; " +
        "do not state any health fact you can't see in the cached context or learned facts above.";
    // 4s hard cap on Zep — past calls have hung 30s+ when Zep is unhealthy.
    // On timeout OR throw, we inject the marker so Claude knows context is missing.
    const withZepTimeout = (p, role) => Promise.race([
        p,
        new Promise((r) => setTimeout(() => {
            console.warn(`qaAgent: Zep context timed out (${role}, 4s cap) — injecting memory_unavailable marker`);
            r(ZEP_UNAVAILABLE_MARKER);
        }, 4000)),
    ]);
    if (userType === "caregiver" && caregiverId) {
        const [caregiver, todayAppt, hist, cgZepContext] = await Promise.all([
            getCaregiverProfile(caregiverId),
            getCaregiverTodayAppointment(caregiverId),
            getConversationHistory(phone),
            zepThreadId ? withZepTimeout((0, zepClient_1.getZepContext)(zepThreadId).catch((err) => {
                console.warn("qaAgent: Zep context unavailable (caregiver)", err instanceof Error ? err.message : err);
                return ZEP_UNAVAILABLE_MARKER;
            }), "caregiver") : Promise.resolve(""),
        ]);
        const contextFlags = session ? {
            pendingPayoutNotificationAck: session.pendingPayoutNotificationAck,
            pendingBgCheckAck: session.pendingBgCheckAck,
        } : undefined;
        systemPrompt = buildCaregiverSystemPrompt(caregiver, todayAppt, cgZepContext || undefined, contextFlags);
        history = hist;
        // Clear the context flags after a reply consumes them — they're one-shot context.
        // 48h expiry is also enforced by the router so this only fires for genuine acks.
        if ((contextFlags === null || contextFlags === void 0 ? void 0 : contextFlags.pendingPayoutNotificationAck) || (contextFlags === null || contextFlags === void 0 ? void 0 : contextFlags.pendingBgCheckAck)) {
            await db.collection("agent_sessions").doc(phone).update({
                pendingPayoutNotificationAck: admin.firestore.FieldValue.delete(),
                pendingPayoutNotificationAckSetAt: admin.firestore.FieldValue.delete(),
                pendingBgCheckAck: admin.firestore.FieldValue.delete(),
                pendingBgCheckAckSetAt: admin.firestore.FieldValue.delete(),
            }).catch(() => { });
        }
    }
    else {
        // Unconfirmed-identity gate — phone is in the system but onboarding never
        // completed, so any seniorId/userId/seniorIds on this session may point at
        // a different person we linked them to (e.g. invited family contact, or a
        // sandbox→live migration artifact). Suppress cross-entity context so Cara
        // doesn't surface someone else's appointments or care plan as if it were
        // theirs. Conversation history with THIS phone stays — that's their own
        // SMS thread with Cara, not someone else's data.
        const unconfirmedIdentity = !!(session === null || session === void 0 ? void 0 : session.__unconfirmedIdentity);
        const prefetched = unconfirmedIdentity ? null : await getPrefetchedContext(phone);
        metrics.prefetchHit = !!prefetched;
        let senior, journal, nextAppt, permissions;
        if (prefetched) {
            senior = prefetched.seniorProfile;
            journal = prefetched.recentJournal;
            nextAppt = prefetched.nextAppointment;
            history = prefetched.conversationHistory;
            permissions = null;
        }
        else if (unconfirmedIdentity) {
            senior = null;
            journal = [];
            nextAppt = null;
            permissions = null;
            history = await getConversationHistory(phone);
        }
        else {
            [senior, journal, nextAppt, permissions, history] = await Promise.all([
                getSeniorProfile(seniorId),
                getRecentJournalEntries(seniorId, 3),
                getNextAppointment(userId),
                getAgentPermissions(userId),
                getConversationHistory(phone),
            ]);
        }
        // Detect and apply fact corrections before building context — reload facts if applied.
        // Skipped for unconfirmed identity: we don't know whose facts these would be.
        let correctionApplied = false;
        if (!unconfirmedIdentity) {
            try {
                const { detectAndApplyCorrection } = await Promise.resolve().then(() => __importStar(require("../memory/learnedFacts")));
                correctionApplied = await detectAndApplyCorrection(userId, text, zepThreadId ? phone.replace(/\D/g, "") : undefined);
            }
            catch (_0) {
                // Non-critical
            }
        }
        // Load Zep context, memory files, learned facts, active visit, and booking patterns in parallel.
        // Unconfirmed-identity sessions skip all of these — they all key off userId
        // and would surface another person's care data on a linked phone.
        const [zepContext, memoryContext, facts, activeVisit, bookingPatterns] = unconfirmedIdentity
            ? ["", "", [], null, ""]
            : await Promise.all([
                zepThreadId ? withZepTimeout((0, zepClient_1.getZepContext)(zepThreadId).catch((err) => {
                    console.warn("qaAgent: Zep context unavailable (client)", err instanceof Error ? err.message : err);
                    return ZEP_UNAVAILABLE_MARKER;
                }), "client") : Promise.resolve(""),
                (0, memoryFiles_1.getMemoryContext)(userId).catch(() => ""),
                (0, learnedFacts_1.getRelevantFacts)(userId).catch(() => []),
                getActiveVisit(userId).catch(() => null),
                getBookingPatterns(userId),
            ]);
        // Lazy-bootstrap memory files for users who completed onboarding before the
        // memory-files code shipped, or whose initial write silently failed. Runs
        // once per user (idempotent — initializeMemoryFiles overwrites if needed
        // but next turn memoryContext will be non-empty and this branch is skipped).
        if (!memoryContext && userId) {
            const sd = (_a = session === null || session === void 0 ? void 0 : session.onboardingData) !== null && _a !== void 0 ? _a : {};
            const seniorDoc = senior;
            const initData = {
                seniorName: ((_b = sd.seniorName) !== null && _b !== void 0 ? _b : seniorDoc === null || seniorDoc === void 0 ? void 0 : seniorDoc.name),
                seniorAge: ((_c = sd.age) !== null && _c !== void 0 ? _c : seniorDoc === null || seniorDoc === void 0 ? void 0 : seniorDoc.age),
                conditions: ((_e = (_d = sd.conditions) !== null && _d !== void 0 ? _d : seniorDoc === null || seniorDoc === void 0 ? void 0 : seniorDoc.conditions) !== null && _e !== void 0 ? _e : []),
                careNeeds: ((_g = (_f = sd.careNeeds) !== null && _f !== void 0 ? _f : seniorDoc === null || seniorDoc === void 0 ? void 0 : seniorDoc.needs) !== null && _g !== void 0 ? _g : []),
                city: ((_h = sd.city) !== null && _h !== void 0 ? _h : ""),
                clientName: ((_j = sd.firstName) !== null && _j !== void 0 ? _j : ""),
                relationship: ((_k = sd.relationship) !== null && _k !== void 0 ? _k : ""),
            };
            if (initData.seniorName || initData.conditions || initData.careNeeds) {
                // Fire-and-forget — next conversation turn will read populated files
                const { initializeMemoryFiles } = await Promise.resolve().then(() => __importStar(require("../memory/memoryFiles")));
                initializeMemoryFiles(userId, initData).catch((err) => console.warn("qaAgent: lazy initializeMemoryFiles failed", err instanceof Error ? err.message : err));
            }
        }
        const factsText = facts.length
            ? facts.map((f) => `- ${f.fact} (${f.category})`).join("\n")
            : undefined;
        // Sprint 8: record which memory tier supplied context this turn. Derived
        // from the already-loaded locals — no extra reads, no loader signature
        // changes. Zep is "available" only when it returned real content (not the
        // injected unavailable marker).
        const zepLive = !!zepContext && zepContext !== ZEP_UNAVAILABLE_MARKER;
        metrics.memoryRecallTier = zepLive
            ? "zep"
            : memoryContext
                ? "memoryFiles"
                : facts.length
                    ? "learnedFacts"
                    : "none";
        metrics.memoryFactsRetrieved = facts.length;
        if (zepContext === ZEP_UNAVAILABLE_MARKER)
            metrics.zepUnavailable = true;
        systemPrompt = buildClientSystemPrompt(senior, journal, nextAppt, permissions, factsText, zepContext || undefined, memoryContext || undefined, activeVisit, bookingPatterns || undefined);
        // If correction was applied, log it so caller knows (useful for debugging)
        if (correctionApplied) {
            console.info("qaAgent: fact correction applied before prompt build", { userId });
        }
    }
    // Voice mirror — derive style stats from the family's own inbound history
    // and inject a one-line directive so Cara's surface register (length, emoji
    // use, language, formality) tracks theirs. No-op when the sample is too
    // small to be meaningful, so brand-new conversations get default voice.
    const voiceDirective = (0, voiceMirror_1.buildVoiceDirective)((0, voiceMirror_1.computeVoiceProfile)(history));
    if (voiceDirective) {
        systemPrompt += `\n\n${voiceDirective}`;
    }
    // Emotional context — blend the current turn's classification with any
    // 12h-TTL stored posture (grief/anxiety persists across turns). Inject
    // directive at end of prompt (highest model attention). Persist when the
    // posture changes or a non-calm signal arrives.
    const currentEmotion = await emotionalClassifyPromise.catch(() => "calm");
    const storedEmotion = session === null || session === void 0 ? void 0 : session.emotionalContext;
    const blended = (0, emotionalContext_1.blendEmotionalContext)(storedEmotion, currentEmotion);
    metrics.emotionalContext = blended.value;
    // Sprint 8: classify topic (health / logistics / general) — synchronous,
    // regex-based, no model call. Threaded into the directive so anxious-about-
    // health gets different guidance than anxious-about-logistics.
    const emotionalTopic = channel === "[USER]"
        ? (0, emotionalContext_1.classifyEmotionalTopic)(text)
        : "general";
    metrics.emotionalTopic = emotionalTopic;
    const emotionalDirective = (0, emotionalContext_1.buildEmotionalContextDirective)(blended.value, emotionalTopic);
    if (emotionalDirective) {
        systemPrompt += `\n\n${emotionalDirective}`;
    }
    // Skill injection — at most one skill body per turn, picked in parallel
    // above. Anchored at the end where Sonnet attends most. Falls back to no
    // skill on any error.
    const pickedSkillName = await skillPickPromise.catch(() => null);
    if (pickedSkillName) {
        const skill = (0, skills_1.findSkill)(pickedSkillName);
        if (skill) {
            systemPrompt += `\n\n${(0, skills_1.buildSkillDirective)(skill)}`;
            metrics.skill = skill.name;
        }
    }
    if (blended.persist) {
        db.collection("agent_sessions").doc(phone).update({
            emotionalContext: blended.persist,
        }).catch(() => { });
    }
    // Inject session identifiers — Claude must never ask the user for clientId, userId, or phone.
    // These are always known from the session and are also auto-injected into every tool call.
    systemPrompt += `\n\nSESSION (do not ask the user for these — use them when tools require clientId, userId, or phone):\nclientId = "${userId}" | userId = "${userId}" | phone = "${phone}"`;
    // Sprint 7 — composable prompt augmenters. Today this only runs the A/B
    // experiments augmenter; future PRs migrate the inline `systemPrompt += ...`
    // chain below into this registry one directive at a time. The pipeline is
    // append-only and predicate-gated, so it can't break existing behavior.
    const augmenterCtx = {
        text,
        phone,
        userId,
        seniorId,
        userType,
        session,
        turnCount: Math.floor(history.length / 2),
        metrics,
    };
    const PIPELINE = [
        promptExperiments_1.experimentsAugmenter,
        ...defaultPromptAugmenters_1.DEFAULT_AUGMENTERS,
    ];
    const augResult = await (0, promptAugmenters_1.runAugmenters)(systemPrompt, PIPELINE, augmenterCtx);
    systemPrompt = augResult.systemPrompt;
    if (augResult.applied.length) {
        metrics.augmentersApplied = augResult.applied;
    }
    // Profile review mode — flipped by the inbound webhook when classifyIntent
    // returns UPDATE_ONBOARDING. The user is already-onboarded but wants Cara to
    // walk through what's on file and fix what's wrong. Without this directive
    // Claude defaults to "ask for everything as a numbered list" — exactly the
    // failure mode that prompted this code path. The directive forces her to:
    //   1) read what's already on file (no re-asking for known fields)
    //   2) summarize it in prose, ending with ONE question
    //   3) patch corrections one at a time via update_senior_profile /
    //      update_care_plan / update_memory_file (with the existing read-back-
    //      and-confirm rule from the main system prompt)
    // The 20-minute TTL is enforced here so a stale flag doesn't accidentally
    // hijack an unrelated future conversation.
    const reviewExpiresAt = session === null || session === void 0 ? void 0 : session.profileReviewExpiresAt;
    const reviewModeActive = !!(session === null || session === void 0 ? void 0 : session.profileReviewMode) &&
        (!reviewExpiresAt || new Date(reviewExpiresAt).getTime() > Date.now());
    if (reviewModeActive && userType !== "caregiver") {
        systemPrompt +=
            "\n\nPROFILE REVIEW MODE (active this turn): The family just asked you to redo, fix, or update what's on file for their senior. " +
                "Do NOT re-collect data from scratch. Do NOT send a numbered list. Do NOT ask for more than one thing in a single message. " +
                "Step 1 — On your FIRST reply this mode is active, call get_care_plan to pull the current care plan, and combine it with the senior profile and learned facts already in your context above. " +
                "Step 2 — Summarize what's on file in ONE short, warm prose sentence (e.g. \"I have Anita, 78, in Gilroy, needing help with bathing and meds.\") and end with ONE open question (\"Is any of that wrong?\" or \"What should we update?\"). Never invent a city or detail you can't see in the context. " +
                "Step 3 — Wait for the family to name what's wrong. When they do, read the proposed change back in plain English (\"Got it — updating her name to Anita. Confirm?\") and wait for an explicit yes before calling the update tool. " +
                "Step 4 — Use update_senior_profile for emergency contact, physician, diagnoses, allergies. Use update_care_plan for medications, careNeeds, dietary, special instructions. Use update_memory_file for durable narrative facts (personality, routines, family). " +
                "Step 5 — After each successful patch, ask if there's anything else to fix (ONE question). When the family says \"that's it\", \"all good\", \"nothing else\", or equivalent, keep the closing reply warm and short. " +
                "EXIT SIGNAL: when and only when the family has confirmed they're done, end your reply with the literal token [[EXIT_PROFILE_REVIEW]] on its own line. The post-processor strips the token before sending and clears the session flag. Do NOT emit the token while the user is still correcting fields.";
    }
    // Unconfirmed-identity short-circuits: skip all per-phone task/goal/agent
    // context — they may reference work on behalf of a different linked person.
    const skipCrossEntity = !!(session === null || session === void 0 ? void 0 : session.__unconfirmedIdentity);
    // Inject active goal context if present
    if (session && !skipCrossEntity) {
        const { goalContext } = await resumeActiveGoal(phone, session);
        if (goalContext)
            systemPrompt += goalContext;
    }
    // Inject active background task status (e.g. emergency replacement in progress)
    if (!skipCrossEntity) {
        const activeTaskSnap = await db.collection("agent_tasks_active").doc(phone).get().catch(() => null);
        if (activeTaskSnap === null || activeTaskSnap === void 0 ? void 0 : activeTaskSnap.exists) {
            const t = activeTaskSnap.data();
            systemPrompt +=
                `\n\nACTIVE BACKGROUND TASK:\nType: ${t.type}\nStatus: ${t.status}\nDetails: ${t.description}\n` +
                    `If the family asks for an update or "what's happening", report this status directly.`;
        }
    }
    // Roster check — inject active execution agent context so Claude can route follow-up questions
    if (userType !== "caregiver" && !skipCrossEntity) {
        const activeAgent = await (0, executionAgent_1.getActiveAgentForUser)(phone).catch(() => null);
        if (activeAgent) {
            const lastAction = (_o = (_m = (_l = activeAgent.operationalLog) === null || _l === void 0 ? void 0 : _l.at(-1)) === null || _m === void 0 ? void 0 : _m.result) !== null && _o !== void 0 ? _o : "none";
            systemPrompt +=
                `\n\nACTIVE EXECUTION AGENT:\nType: ${activeAgent.type}\nAgent ID: ${activeAgent.id}\n` +
                    `Last action: ${lastAction}\n` +
                    `Context summary: ${JSON.stringify(activeAgent.context).slice(0, 400)}\n\n` +
                    `If the family's message is a follow-up question about this task (asking about a specific caregiver, rates, experience, etc.), ` +
                    `call the 'resume_execution_agent' tool with agentId="${activeAgent.id}" and their message. ` +
                    `Return the tool's reply EXACTLY as-is.`;
        }
    }
    // Context load is everything from function entry up to here: DND check,
    // prefetch lookup, parallel context fetch, system prompt assembly, session
    // overlays. Captured before the typing indicator so we don't include the
    // (network-bound) typing call in this measurement.
    metrics.contextLoadMs = Date.now() - metrics.startedAt;
    try {
        if (!skipSend)
            await (0, client_1.startTyping)(chatId).catch(() => { });
        // The persona-reinject + epistemic guard now ships via the
        // personaReinjectAugmenter (every 4th turn, or after a lint violation) —
        // see defaultPromptAugmenters.ts. Other inline append blocks below will
        // migrate the same way as we expand the augmenter registry.
        const turnCount = Math.floor(history.length / 2);
        // Working-memory checklist (DeepAgents TodoListMiddleware port). When the
        // session has a non-empty todos list, surface it so Claude can pick up where
        // she left off across turns. Cleared/managed by the write_todos tool.
        const sessionTodos = session === null || session === void 0 ? void 0 : session.todos;
        if (Array.isArray(sessionTodos) && sessionTodos.length > 0) {
            const lines = sessionTodos.map((t, i) => {
                const mark = t.status === "completed" ? "✓" : t.status === "in_progress" ? "→" : "·";
                return `${mark} ${i + 1}. ${t.task}`;
            }).join("\n");
            systemPrompt +=
                "\n\n<active_todos>\nFrom earlier in this conversation, the outstanding checklist is:\n" +
                    lines +
                    "\n\nKeep working through these. Call write_todos again to update statuses as you finish each, " +
                    "or to add new items if scope grows. Don't repeat work already marked completed.\n</active_todos>";
        }
        else if (turnCount === 0) {
            // First inbound — gently nudge Claude to scaffold a checklist for genuinely
            // multi-step requests. (Don't nag on every turn — once they get going,
            // the in-prompt active_todos block above carries the load.)
            systemPrompt +=
                "\n\n<planning_hint>If this request has 3+ distinct steps " +
                    "(e.g. cancel X, find replacement Y, notify Z), call write_todos first to scaffold " +
                    "the plan before doing any of them. Skip for simple single-step asks.</planning_hint>";
        }
        // Select tools based on user type — caregivers get a focused subset
        // (~35 of ~88 tools). For clients, filter further by the classified
        // intent's required capabilities; broad / ambiguous intents (QUESTION,
        // TASK_REPLY, UPDATE_ONBOARDING, null) keep the full surface. Filtering
        // reduces wrong-tool calls and prompt-cache decode cost; core tools
        // (senior profile, pending tasks, etc.) are always included.
        const baseTools = userType === "caregiver" ? server_1.CAREGIVER_TOOLS : server_1.MCP_TOOLS;
        const activeTools = userType === "caregiver"
            ? baseTools
            : (0, toolCapabilities_1.selectToolsForIntent)(baseTools, intent !== null && intent !== void 0 ? intent : null);
        if (activeTools.length !== baseTools.length) {
            console.info("qaAgent: tool surface filtered", {
                userId, intent, before: baseTools.length, after: activeTools.length,
            });
        }
        // Tool-use loop — Claude calls tools until it has what it needs, then produces a reply
        const messages = [
            ...history,
            { role: "user", content: taggedText },
        ];
        // Cache the system prompt — it's large, stable within a session, and called up to 8x per turn.
        // Prompt caching cuts latency and cost on every tool-use iteration after the first.
        const cachedSystem = [
            { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
        ];
        let reply = "";
        // Budget guard: cap wall-clock at ~60s so users never wait 3+ min while the
        // tool loop iterates. Each Claude call gets a tight timeout; we exit early
        // once the running total exceeds the budget.
        const TURN_BUDGET_MS = 60000;
        const turnStart = Date.now();
        // Recovery tracking — if Sonnet hits two consecutive iterations where every
        // tool_use returned an error, ask the recovery sub-agent for a different
        // plan ONCE and inject it into the next user message. Fires at most one
        // time per turn so we don't compound latency.
        let consecutiveErrorIterations = 0;
        let recoveryFired = false;
        const toolErrorTrail = [];
        for (let iteration = 0; iteration < 5; iteration++) {
            if (Date.now() - turnStart > TURN_BUDGET_MS) {
                console.warn("qaAgent: turn budget exceeded, exiting tool loop", { userId, iteration });
                break;
            }
            // Clip oversized tool_use args in older messages — the result is what
            // matters past the first turn or two, and full args bloat every cached
            // prompt thereafter. Cheap pre-pass before patch + Claude call.
            const argsClipped = (0, contextManagement_1.truncateOldToolCallArgs)(messages);
            if (argsClipped > 0) {
                metrics.toolArgsTruncated = ((_p = metrics.toolArgsTruncated) !== null && _p !== void 0 ? _p : 0) + argsClipped;
            }
            // Defensive: ensure every assistant tool_use has a matching tool_result
            // before we hand the array to Claude. Normally a no-op; non-zero patches
            // indicate either max_tokens truncation on the previous iteration or a
            // bug in the loop pairing.
            const patched = (0, contextManagement_1.patchDanglingToolCalls)(messages);
            if (patched > 0) {
                console.warn("qaAgent: patched dangling tool calls", { userId, iteration, patched });
                metrics.patchedOrphans = ((_q = metrics.patchedOrphans) !== null && _q !== void 0 ? _q : 0) + patched;
            }
            metrics.iterations = ((_r = metrics.iterations) !== null && _r !== void 0 ? _r : 0) + 1;
            const response = await (0, claudeRetry_1.callClaudeWithRetry)((0, claudeClient_1.getSharedClient)(), {
                model: "claude-sonnet-4-6",
                max_tokens: 600,
                system: cachedSystem,
                tools: activeTools,
                tool_choice: { type: "auto" },
                messages,
            }, { timeoutMs: 15000, maxAttempts: 1 });
            // max_tokens cutoff while emitting tool_use blocks → tool input JSON may
            // be truncated. We can't safely execute partially-specified tool calls
            // (booking with missing args, message with missing body, etc.). Push the
            // assistant message, let patchDanglingToolCalls inject placeholder tool
            // results on the next iteration, and continue so Claude can recover.
            if (response.stop_reason === "max_tokens" &&
                response.content.some((b) => b.type === "tool_use")) {
                console.warn("qaAgent: max_tokens with tool_use blocks — treating as truncated", {
                    userId,
                    iteration,
                    toolNames: response.content
                        .filter((b) => b.type === "tool_use")
                        .map((b) => b.name),
                });
                metrics.truncations = ((_s = metrics.truncations) !== null && _s !== void 0 ? _s : 0) + 1;
                messages.push({ role: "assistant", content: response.content });
                // patchDanglingToolCalls at the top of the next iteration injects the
                // placeholder tool_results, which Claude reads and recovers from.
                continue;
            }
            if (response.stop_reason === "tool_use") {
                // Execute all tool calls in this turn
                const toolResults = [];
                let iterationToolCalls = 0;
                let iterationToolErrors = 0;
                for (const block of response.content) {
                    if (block.type === "tool_use") {
                        _toolCallsOut === null || _toolCallsOut === void 0 ? void 0 : _toolCallsOut.push(block.name);
                        // For browser actions that take 15-30s: send a brief acknowledgment so
                        // the family knows something is happening and doesn't think Cara went silent.
                        if (!skipSend &&
                            block.name === "perform_web_action" &&
                            (((_t = block.input) === null || _t === void 0 ? void 0 : _t.actionType) === "browse" || ((_u = block.input) === null || _u === void 0 ? void 0 : _u.loginAction))) {
                            await sendSplit(chatId, "On it — give me a moment.").catch(() => { });
                        }
                        const toolHandler = userType === "caregiver" ? server_1.handleToolCallForCaregiver : server_1.handleToolCall;
                        // Auto-inject session identifiers so Claude never needs to ask the user for them.
                        // Only inject non-empty values — an empty string is falsy and fails tool validation.
                        const enrichedInput = Object.assign(Object.assign(Object.assign({}, block.input), { phone,
                            chatId }), (userId ? { clientId: userId, userId } : {}));
                        const toolStart = Date.now();
                        const result = await toolHandler(block.name, enrichedInput)
                            .catch((err) => {
                            console.error(`qaAgent: tool call failed [${block.name}]`, err);
                            return {
                                _toolError: true,
                                message: "Tool unavailable — tell the user you don't have that information right now and offer to try again.",
                            };
                        });
                        metrics.toolCalls = ((_v = metrics.toolCalls) !== null && _v !== void 0 ? _v : 0) + 1;
                        ((_w = metrics.toolNames) !== null && _w !== void 0 ? _w : (metrics.toolNames = [])).push(block.name);
                        iterationToolCalls += 1;
                        const errored = !!(result === null || result === void 0 ? void 0 : result._toolError)
                            || !!(result === null || result === void 0 ? void 0 : result.error);
                        if (errored) {
                            metrics.toolErrors = ((_x = metrics.toolErrors) !== null && _x !== void 0 ? _x : 0) + 1;
                            iterationToolErrors += 1;
                            if (toolErrorTrail.length < 6) {
                                toolErrorTrail.push({
                                    tool: block.name,
                                    preview: JSON.stringify(result).slice(0, 200),
                                });
                            }
                        }
                        // Instrumentation for D4 — track success rate on the cancel path so
                        // we can decide if a dedicated cancelFlow is needed. Same pattern
                        // works for any high-stakes tool.
                        if (block.name === "cancel_appointment" || block.name === "cancel_subscription") {
                            const succeeded = !(result === null || result === void 0 ? void 0 : result._toolError) && !(result === null || result === void 0 ? void 0 : result.error);
                            console.info("qaAgent.toolUse", {
                                tool: block.name,
                                phone,
                                userId,
                                succeeded,
                                durationMs: Date.now() - toolStart,
                            });
                            db.collection("agent_tool_metrics").add({
                                tool: block.name,
                                phone,
                                userId,
                                succeeded,
                                durationMs: Date.now() - toolStart,
                                errorPreview: succeeded ? null : JSON.stringify(result).slice(0, 200),
                                ranAt: new Date().toISOString(),
                            }).catch(() => { });
                        }
                        toolResults.push({
                            type: "tool_result",
                            tool_use_id: block.id,
                            content: await (0, contextManagement_1.buildToolResultContent)(userId, block.name, result),
                        });
                    }
                }
                messages.push({ role: "assistant", content: response.content });
                messages.push({ role: "user", content: toolResults });
                // Recovery — delegated to the pure policy in recoveryDecision.ts.
                // Fires on the 2nd consecutive iteration where every tool_use errored,
                // at most once per turn. Appends a <recovery_suggestion> user-channel
                // block so Sonnet attends to it on the next iteration.
                const decision = (0, recoveryDecision_1.decideRecovery)({ consecutiveErrorIterations, alreadyFired: recoveryFired }, { toolCalls: iterationToolCalls, toolErrors: iterationToolErrors });
                consecutiveErrorIterations = decision.consecutiveErrorIterations;
                if (decision.shouldFire) {
                    recoveryFired = true;
                    metrics.recoveryFired = true;
                    try {
                        const errSummary = toolErrorTrail
                            .map(e => `- ${e.tool}: ${e.preview}`)
                            .join("\n");
                        const recoveryDescription = `Original user request: ${text.slice(0, 400)}\n\n` +
                            `Tools tried and the errors they returned:\n${errSummary}\n\n` +
                            `Suggest a different approach.`;
                        const rec = await (0, ephemeralSubAgents_1.runEphemeralSubAgent)({
                            subagentType: "recovery",
                            description: recoveryDescription,
                            maxTokens: 200,
                        });
                        messages.push({
                            role: "user",
                            content: `<recovery_suggestion>\n${rec.output}\n</recovery_suggestion>`,
                        });
                        console.info("qaAgent.recoveryFired", {
                            userId,
                            consecutiveErrorIterations,
                            durationMs: rec.durationMs,
                        });
                    }
                    catch (err) {
                        console.warn("qaAgent: recovery sub-agent threw — continuing without hint", err);
                    }
                }
            }
            else {
                reply = response.content
                    .filter((b) => b.type === "text")
                    .map((b) => b.text)
                    .join("")
                    .trim();
                break;
            }
        }
        if (!reply) {
            console.warn("qaAgent: tool-use loop exhausted without text reply", { userId, isRetry, preview: text.slice(0, 80) });
            if (!isRetry) {
                // Schedule a retry in 30 seconds via the trigger engine — the retry
                // will reply with the real answer when it succeeds.
                db.collection("proactive_triggers").add({
                    userId,
                    phone,
                    type: "custom",
                    scheduledAt: new Date(Date.now() + 30000).toISOString(),
                    message: `qa_retry:${JSON.stringify({ text: text.slice(0, 500), chatId, userId, seniorId, userType, caregiverId, zepThreadId })}`,
                    firedAt: null,
                    cancelledAt: null,
                    createdAt: new Date().toISOString(),
                }).catch(() => { });
                reply = "Give me a moment on that — I'm pulling it up.";
            }
            else {
                // Retry also exhausted — escalate to admin silently. User-facing
                // message is natural and warm, not "broken".
                db.collection("admin_alerts").add({
                    type: "qa_loop_exhausted",
                    userId,
                    phone,
                    question: text.slice(0, 300),
                    severity: "medium",
                    createdAt: new Date().toISOString(),
                    resolved: false,
                }).catch(() => { });
                reply = "Let me come back to you on that one shortly.";
            }
        }
        // Grounding revision — when medical claims + hedging co-occur, ask Claude to strip speculation
        const MEDICAL_CLAIM = /\b(doctor|diagnosis|medication|dosage|mg|ml|blood pressure|heart rate|fall|injury|hospital|symptom|condition)\b/i;
        if (detectLowConfidence(reply) && MEDICAL_CLAIM.test(reply)) {
            console.warn("qaAgent: grounding revision triggered", { userId, preview: reply.slice(0, 100) });
            metrics.groundingTriggered = true;
            db.collection("agent_uncertainty_log").add({
                userId, phone,
                question: text.slice(0, 200),
                reply: reply.slice(0, 500),
                detectedAt: new Date().toISOString(),
                groundingTriggered: true,
            }).catch(() => { });
            try {
                const groundedController = new AbortController();
                const groundedTimer = setTimeout(() => groundedController.abort(), 8000);
                const grounded = await (0, openaiClient_1.quickComplete)("You are a grounding editor. Revise the message below to remove all speculation, hedging, " +
                    "and probabilistic language about medical or health topics. " +
                    "Replace hedged claims with 'I don't have that information' or attribute them to documented sources. " +
                    "Keep the same warm tone and length. Output only the revised message.", reply, { maxTokens: 300, signal: groundedController.signal });
                clearTimeout(groundedTimer);
                if (grounded.trim() && grounded.trim() !== reply) {
                    reply = grounded.trim();
                    metrics.groundingRewriteApplied = true;
                }
            }
            catch (_1) {
                // Non-critical — proceed with original reply
            }
        }
        else if (detectLowConfidence(reply)) {
            console.warn("qaAgent: low-confidence reply (no medical claims)", { userId, preview: reply.slice(0, 100) });
            db.collection("agent_uncertainty_log").add({
                userId, phone,
                question: text.slice(0, 200),
                reply: reply.slice(0, 500),
                detectedAt: new Date().toISOString(),
            }).catch(() => { });
        }
        // Format revision — if Claude produced list-shaped output (numbered list,
        // bullet list, or multi-line "1.", "2.", "-", "•") despite the no-lists
        // rule in the system prompt, rewrite to conversational prose before the
        // user sees it. Same fail-open / 8-second timeout pattern as the grounding
        // pass above. Defense in depth — the prompt is supposed to prevent this
        // but the screenshot that started this fix proves Claude still slips up.
        if (hasListShape(reply)) {
            console.warn("qaAgent: format revision triggered (list-shaped reply)", { userId, preview: reply.slice(0, 120) });
            metrics.formatRevisionTriggered = true;
            db.collection("agent_uncertainty_log").add({
                userId, phone,
                question: text.slice(0, 200),
                reply: reply.slice(0, 500),
                detectedAt: new Date().toISOString(),
                formatRevisionTriggered: true,
            }).catch(() => { });
            try {
                const fmtController = new AbortController();
                const fmtTimer = setTimeout(() => fmtController.abort(), 8000);
                const rewritten = await (0, openaiClient_1.quickComplete)("You are a tone editor for Cara, a warm SMS care assistant. " +
                    "Rewrite the message below into conversational prose. " +
                    "Strict rules: NO numbered lists, NO bullet points, NO dashes-as-bullets, NO headers, NO markdown. " +
                    "If the message asks for multiple pieces of information, keep ONLY the first question and drop the rest — Cara asks one thing at a time. " +
                    "Preserve warm, direct tone. Output only the revised message; no explanation.", reply, { maxTokens: 300, signal: fmtController.signal });
                clearTimeout(fmtTimer);
                if (rewritten.trim() && rewritten.trim() !== reply) {
                    reply = rewritten.trim();
                    metrics.formatRewriteApplied = true;
                }
            }
            catch (_2) {
                // Non-critical — proceed with original reply (the linter / supervisor still run)
            }
        }
        // Profile review exit — Claude appends [[EXIT_PROFILE_REVIEW]] when the
        // family has confirmed everything looks good. Strip the token before the
        // user sees it and clear the session flag so subsequent turns get normal
        // routing. Doing this BEFORE supervise() so the supervisor never sees the
        // sentinel and accidentally "rewrites" it.
        if (reply.includes("[[EXIT_PROFILE_REVIEW]]")) {
            reply = reply.replace(/\[\[EXIT_PROFILE_REVIEW\]\]/g, "").trim();
            db.collection("agent_sessions").doc(phone).update({
                profileReviewMode: admin.firestore.FieldValue.delete(),
                profileReviewExpiresAt: admin.firestore.FieldValue.delete(),
            }).catch(() => { });
        }
        // Sprint 8: log-only conversational-quality detectors. Run on the final
        // reply BEFORE supervise() rewrites it so the metrics reflect what Claude
        // actually produced, not the post-processed version. Pure observation —
        // no reply text changes.
        if (detectConfidenceClaim(reply)) {
            metrics.confidenceClaimDetected = true;
        }
        if (detectPromiseWithoutToolCall(reply, (_y = metrics.toolCalls) !== null && _y !== void 0 ? _y : 0)) {
            metrics.promiseWithoutToolCall = true;
        }
        const preSuperviseReply = reply;
        reply = await (0, supervisor_1.supervise)(reply, { phone, role: userType }).catch((err) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error("qaAgent: supervisor threw, sending unsupervised", errMsg);
            const minuteBucket = new Date().toISOString().slice(0, 16);
            db.collection("admin_alerts").add({
                type: "supervisor_fail_open",
                phone,
                userId,
                error: errMsg.slice(0, 500),
                preview: reply.slice(0, 200),
                source: "qaAgent",
                dedupeKey: `supervisor_fail_open:${minuteBucket}`,
                severity: "high",
                resolved: false,
                createdAt: new Date().toISOString(),
            }).catch(() => { });
            return reply;
        });
        metrics.supervisorRewriteApplied = reply !== preSuperviseReply;
        metrics.exhausted = !preSuperviseReply.trim();
        // Sprint 8: postProcessModified is now DERIVED from the three discrete
        // rewrite-applied flags (kept for one sprint of dashboard compatibility).
        metrics.postProcessModified =
            !!metrics.groundingRewriteApplied ||
                !!metrics.formatRewriteApplied ||
                !!metrics.supervisorRewriteApplied;
        // Sprint 8: tone-warmth-v1 adherence proxy. Did Cara open with an empathy
        // reflection on a non-calm turn? Regex on the first sentence — cheap,
        // deterministic, no extra LLM call. Measured on the FINAL (post-supervise)
        // reply since that's what the family actually receives.
        if (metrics.emotionalContext && metrics.emotionalContext !== "calm") {
            const firstSentence = (_z = reply.split(/(?<=[.!?])\s/)[0]) !== null && _z !== void 0 ? _z : reply;
            metrics.warmthReflectionIncluded = exports.WARMTH_REFLECTION_OPENERS.test(firstSentence);
        }
        // Persist the lint-violation signal for the NEXT turn's persona re-inject
        // decision. Written unconditionally (true/false) so the flag doesn't go stale.
        db.collection("agent_sessions").doc(phone).update({
            recentLintViolation: metrics.postProcessModified,
        }).catch(() => { });
        await saveConversationTurn(phone, text, reply);
        if (!skipSend)
            await sendSplit(chatId, reply);
        // After the reply is sent: fold older turns into the rolling summary so long
        // conversations stay coherent without bloating the per-turn context.
        await (0, contextManagement_1.maybeRollUpHistory)(phone);
        (0, turnMetrics_1.emitTurnMetrics)(metrics, { reply });
        return reply;
    }
    catch (err) {
        console.error("qaAgent error:", err);
        if (skipSend) {
            (0, turnMetrics_1.emitTurnMetrics)(metrics, { error: err });
            throw err;
        }
        // Don't broadcast brokenness. Send a natural-sounding deflection that
        // doesn't tell the user Cara is failing, and create an admin alert so
        // the team can follow up if needed.
        const errMsg = "Give me a few minutes on that — I'll come back to you shortly.";
        await (0, client_1.sendMessage)(chatId, errMsg).catch(() => { });
        db.collection("admin_alerts").add({
            type: "qa_agent_failure",
            phone,
            userId,
            question: text.slice(0, 300),
            error: err instanceof Error ? err.message : String(err),
            severity: "medium",
            createdAt: new Date().toISOString(),
            resolved: false,
        }).catch(() => { });
        (0, turnMetrics_1.emitTurnMetrics)(metrics, { reply: errMsg, error: err });
        return errMsg;
    }
}
// ── runQuickReply — gpt-4o-mini fast path for trivial messages ─────────────────
//
// Bypasses the full tool-use loop, MCP context, Zep, etc. Suitable only when:
//   - intent classified as QUESTION (Cara's default fallback bucket)
//   - text is short (≤ 30 chars)
//   - text has no entity markers (digits, @, mid-sentence proper nouns)
//
// Caller in webhooks.ts decides eligibility and falls through to runQaAgent
// when any condition fails. Saves ~3–5s on simple greetings.
async function runQuickReply(params) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
    const { text, phone, chatId, userId, seniorId, userType = "client" } = params;
    const metrics = (0, turnMetrics_1.createTurnMetrics)({
        phone,
        userId,
        userType,
        pathway: "quick",
        inputChannel: "USER",
    });
    // Pre-fetch lightweight context in parallel — used to make greetings smart.
    // Each loader is wrapped so a single failure doesn't break the reply.
    const [history, nextAppt, pendingTask, pendingTimesheets, activeAgent, seniorProfile] = await Promise.all([
        getConversationHistory(phone).catch(() => []),
        userType === "client" && userId ? getNextAppointment(userId).catch(() => null) : Promise.resolve(null),
        userType === "client"
            ? db.collection("agent_tasks")
                .where("clientPhone", "==", phone)
                .where("status", "==", "awaiting_approval")
                .orderBy("createdAt", "desc")
                .limit(1)
                .get()
                .then(s => s.empty ? null : s.docs[0].data())
                .catch(() => null)
            : Promise.resolve(null),
        userType === "client" && userId
            ? db.collection("shift_hours")
                .where("clientId", "==", userId)
                .where("status", "==", "submitted")
                .limit(1)
                .get()
                .then(s => s.empty ? 0 : s.size)
                .catch(() => 0)
            : Promise.resolve(0),
        (0, executionAgent_1.getActiveAgentForUser)(phone).catch(() => null),
        userType === "client" && seniorId ? getSeniorProfile(seniorId).catch(() => null) : Promise.resolve(null),
    ]);
    metrics.contextLoadMs = Date.now() - metrics.startedAt;
    const recent = history.slice(-4);
    // Build a context snippet listing the most relevant fact Cara could lead with.
    // Cara picks one (or none) to mention naturally — she doesn't list them all.
    const contextLines = [];
    const seniorName = (_a = seniorProfile === null || seniorProfile === void 0 ? void 0 : seniorProfile.name) !== null && _a !== void 0 ? _a : "your loved one";
    if (activeAgent) {
        const goal = (_c = (_b = activeAgent.goal) === null || _b === void 0 ? void 0 : _b.description) !== null && _c !== void 0 ? _c : "an open task";
        contextLines.push(`OPEN GOAL: You're in the middle of "${goal}" with this family — pick up where you left off.`);
    }
    if (pendingTask) {
        contextLines.push(`PENDING APPROVAL: There's a booking/task awaiting their reply ("${(_e = (_d = pendingTask.summary) !== null && _d !== void 0 ? _d : pendingTask.type) !== null && _e !== void 0 ? _e : "action needed"}").`);
    }
    if (pendingTimesheets > 0) {
        contextLines.push(`PENDING TIMESHEETS: ${pendingTimesheets} caregiver shift hours waiting for their approval.`);
    }
    if (nextAppt) {
        const caregiverName = (_f = nextAppt.caregiverName) !== null && _f !== void 0 ? _f : "their caregiver";
        const date = (_g = nextAppt.date) !== null && _g !== void 0 ? _g : "soon";
        const time = nextAppt.startTime ? ` at ${nextAppt.startTime}` : "";
        contextLines.push(`NEXT VISIT: ${caregiverName} is coming on ${date}${time}.`);
    }
    const contextSection = contextLines.length
        ? `\n\nKnown context (use ONE of these naturally if relevant; do NOT list them; do NOT mention items you weren't asked about unless they directly help right now):\n${contextLines.map(l => `- ${l}`).join("\n")}`
        : "";
    const persona = userType === "caregiver"
        ? `You ARE Cara. Speak in first person. Never refer to yourself as "Cara" in the third person, and never tell the user to "reach out to Cara" or that "a Cara team member will help" — you are Cara. You are texting a caregiver as their care-team coordinator. Keep replies short (under 200 chars), conversational, no bullet points, no emoji unless they used one first. Acknowledge briefly and move forward. If they ask for something you can't handle in this quick reply (booking, schedule changes, payments), say you're pulling that up — don't fake an answer.`
        : `You ARE Cara — an AI care assistant texting with a family caring for ${seniorName}. Speak in first person. Never refer to yourself as "Cara" in the third person, and never tell the user to "reach out to Cara" or that "a Cara team member will help" — you are Cara. Keep replies short (under 200 chars), conversational, warm. No bullet points, no headers, no markdown.\n\nWhen the family sends a pure greeting ("hi", "hey", "thanks"), DO NOT reply with "what can I help you with?" or any open-ended ask. Instead, open with the most relevant context item below if there is one — naturally, like a friend would. If there's no context to lead with, give a warm short hello like "Hey! How's everything?" — never a generic "what do you need?".\n\nExamples of good context-led greetings:\n- (after "hi" with NEXT VISIT context) "Hey! Maria's coming Thursday at 3 — anything you want me to pass along?"\n- (after "hi" with PENDING APPROVAL context) "Hey! Quick heads up — you still have that booking waiting for your yes/no. Want me to pull it up?"\n- (after "thanks" with no special context) "Anytime. 💙"${contextSection}`;
    const messages = [
        { role: "system", content: persona },
        ...recent.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: text },
    ];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let reply;
    try {
        const res = await (0, openaiClient_1.getOpenAIClient)().chat.completions.create({
            model: "gpt-4o-mini",
            max_tokens: 150,
            messages,
        }, { signal: controller.signal });
        clearTimeout(timer);
        reply = ((_k = (_j = (_h = res.choices[0]) === null || _h === void 0 ? void 0 : _h.message) === null || _j === void 0 ? void 0 : _j.content) !== null && _k !== void 0 ? _k : "").trim();
    }
    catch (err) {
        clearTimeout(timer);
        console.warn("runQuickReply error — falling back to context-aware default", err instanceof Error ? err.message : err);
        // Context-aware fallback: lead with the most useful known fact instead of
        // a generic "what can I help you with" (which is on Cara's banned list).
        if (pendingTask)
            reply = "Hey! You still have that booking waiting on a yes/no — want me to pull it up?";
        else if (pendingTimesheets > 0)
            reply = `Hey! ${pendingTimesheets > 1 ? `${pendingTimesheets} timesheets are` : "A timesheet is"} waiting for your approval whenever you're ready.`;
        else if (nextAppt) {
            const cg = (_l = nextAppt.caregiverName) !== null && _l !== void 0 ? _l : "your caregiver";
            const d = (_m = nextAppt.date) !== null && _m !== void 0 ? _m : "soon";
            reply = `Hey! ${cg} is coming ${d} — anything you want me to pass along?`;
        }
        else if (activeAgent)
            reply = "Hey! Picking up where we left off — give me a sec.";
        else
            reply = "Hey! How's everything going?";
    }
    if (!reply)
        reply = "Hey! How's everything going?";
    await saveConversationTurn(phone, text, reply);
    await (0, client_1.sendMessage)(chatId, reply).catch(() => { });
    await (0, contextManagement_1.maybeRollUpHistory)(phone);
    (0, turnMetrics_1.emitTurnMetrics)(metrics, { reply });
    return reply;
}
// Trivial-message eligibility check used by the webhook before runQaAgent.
// Returns true when text qualifies for the runQuickReply fast path.
//
// Conservative: only true for pure social pleasantries. Any hint of an
// action verb, a request for data, or an entity reference falls through to
// the full QA agent — which has tools to actually do things.
//
// Action verbs include words like "connect", "book", "schedule", "call",
// "hire", "find", "show", "tell" — these are all things Cara needs tools
// to do, so the bypass would just produce a generic "I'll look into it"
// reply (which is wrong; users want Cara to actually act).
const ACTION_VERBS = /\b(connect|book|schedule|call|hire|find|show|tell|send|cancel|reschedule|rebook|reschedule|approve|deny|reject|accept|update|change|set up|setup|set\s+up|search|look|check|get|give|need|want|add|remove|delete|fix|help|pay|refill|reorder|order|forward|share)\b/i;
const REQUEST_PATTERNS = /\b(yes\s+(let|please|do|go|sure|ok)|let'?s|can\s+you|could\s+you|would\s+you|please|i\s+(need|want|would)|tell\s+(me|him|her|them))\b/i;
function isTrivialQuickReply(text) {
    const t = text.trim();
    if (!t || t.length > 30)
        return false;
    // Any digit or @ → likely contains entity data; use full QA agent
    if (/[\d@]/.test(t))
        return false;
    // Action verb or request pattern → user wants something done; use full QA agent
    if (ACTION_VERBS.test(t) || REQUEST_PATTERNS.test(t))
        return false;
    // Proper noun in the middle (after the first word) suggests names/places.
    // First word can be capitalized (sentence start); subsequent ones flag it.
    const words = t.split(/\s+/);
    for (let i = 1; i < words.length; i++) {
        const w = words[i].replace(/[.,!?]/g, "");
        if (w.length > 1 && /^[A-Z][a-z]+$/.test(w))
            return false;
    }
    return true;
}
//# sourceMappingURL=qaAgent.js.map