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
exports.startModifyScheduleFlow = startModifyScheduleFlow;
exports.handleModifyScheduleStep = handleModifyScheduleStep;
const admin = __importStar(require("firebase-admin"));
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const client_1 = require("../linq/client");
const db = admin.firestore();
let _claude = null;
function getClaude() {
    if (!_claude)
        _claude = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    return _claude;
}
async function parseWithClaude(prompt, userText) {
    var _a;
    try {
        const res = await getClaude().messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 200,
            system: prompt,
            messages: [{ role: "user", content: userText }],
        });
        return ((_a = res.content[0].text) !== null && _a !== void 0 ? _a : "").trim();
    }
    catch (_b) {
        return "__parse_error__";
    }
}
async function isQuestionOrOther(text) {
    const result = await parseWithClaude("Reply YES if this is a general question or off-topic comment unrelated to answering the current question. Reply NO if it is a direct answer. Only reply YES or NO.", text);
    return result.toUpperCase().startsWith("Y");
}
async function getScheduleData(phone) {
    var _a, _b;
    const snap = await db.collection("agent_sessions").doc(phone).get();
    return ((_b = (_a = snap.data()) === null || _a === void 0 ? void 0 : _a.modifyScheduleData) !== null && _b !== void 0 ? _b : {});
}
async function mergeScheduleData(phone, data) {
    var _a, _b;
    const snap = await db.collection("agent_sessions").doc(phone).get();
    const existing = ((_b = (_a = snap.data()) === null || _a === void 0 ? void 0 : _a.modifyScheduleData) !== null && _b !== void 0 ? _b : {});
    await db.collection("agent_sessions").doc(phone).update({
        modifyScheduleData: Object.assign(Object.assign({}, existing), data),
    });
}
async function updateStep(phone, step) {
    await db.collection("agent_sessions").doc(phone).update({ modifyScheduleStep: step });
}
// ── Entry point ───────────────────────────────────────────────────────────────
async function startModifyScheduleFlow(phone, chatId, session) {
    var _a, _b, _c, _d;
    const clientId = (_a = session.userId) !== null && _a !== void 0 ? _a : phone;
    // Find active recurring schedule
    const schedSnap = await db.collection("recurring_schedules")
        .where("clientId", "==", clientId)
        .where("status", "==", "active")
        .limit(1)
        .get();
    if (schedSnap.empty) {
        await (0, client_1.sendMessage)(chatId, "I don't see an active recurring care schedule. You can set one up after booking a caregiver — just let me know if you'd like help.");
        return;
    }
    const sched = schedSnap.docs[0].data();
    const schedId = schedSnap.docs[0].id;
    const daysLabel = sched.days.join(", ");
    const timeLabel = `${(_b = sched.startTime) !== null && _b !== void 0 ? _b : ""}–${(_c = sched.endTime) !== null && _c !== void 0 ? _c : ""}`;
    const cgName = (_d = sched.caregiverName) !== null && _d !== void 0 ? _d : "your caregiver";
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    await db.collection("agent_sessions").doc(phone).update({
        modifyScheduleStep: "ms_ask_what",
        modifyScheduleData: { scheduleId: schedId, currentDays: sched.days, currentStart: sched.startTime, currentEnd: sched.endTime, caregiverName: cgName },
        stateExpiresAt: expiresAt,
    });
    await (0, client_1.sendMessage)(chatId, `Your current recurring schedule with ${cgName} is: ${daysLabel}, ${timeLabel}.\n\n` +
        `What would you like to change?\n\n` +
        `1️⃣  Change the days\n` +
        `2️⃣  Change the times\n` +
        `3️⃣  Change both days and times`);
}
async function handleModifyScheduleStep(phone, chatId, text, session) {
    var _a;
    const step = (_a = session.modifyScheduleStep) !== null && _a !== void 0 ? _a : "";
    switch (step) {
        case "ms_ask_what": return handleMsAskWhat(phone, chatId, text, session);
        case "ms_ask_days": return handleMsAskDays(phone, chatId, text, session);
        case "ms_ask_times": return handleMsAskTimes(phone, chatId, text, session);
        case "ms_confirm": return handleMsConfirm(phone, chatId, text, session);
        default:
            await startModifyScheduleFlow(phone, chatId, session);
    }
}
// ── Step handlers ─────────────────────────────────────────────────────────────
async function handleMsAskWhat(phone, chatId, text, session) {
    var _a;
    if (await isQuestionOrOther(text)) {
        const data = await getScheduleData(phone);
        const cgName = (_a = data.caregiverName) !== null && _a !== void 0 ? _a : "your caregiver";
        await (0, client_1.sendMessage)(chatId, `No problem! What would you like to change about your recurring schedule with ${cgName}?\n\n1️⃣  Days\n2️⃣  Times\n3️⃣  Both`);
        return;
    }
    const raw = await parseWithClaude('"1", days, day = days_only. "2", times, time, hours = times_only. "3", both, everything = both. ' +
        'Reply with exactly one of: days_only, times_only, both', text);
    const changeWhat = ["days_only", "times_only", "both"].includes(raw) ? raw : "both";
    await mergeScheduleData(phone, { changeWhat });
    if (changeWhat === "times_only") {
        await updateStep(phone, "ms_ask_times");
        const data = await getScheduleData(phone);
        await (0, client_1.sendMessage)(chatId, `What time would you like care to start and end?\n\n` +
            `(e.g. "9am to 3pm", "10:00 to 16:00")`);
    }
    else {
        await updateStep(phone, "ms_ask_days");
        await (0, client_1.sendMessage)(chatId, `Which days would you like going forward?\n\n` +
            `(e.g. "Tuesday and Thursday", "weekdays", "every Monday")`);
    }
}
async function handleMsAskDays(phone, chatId, text, _session) {
    if (await isQuestionOrOther(text)) {
        await (0, client_1.sendMessage)(chatId, "Which days would you like going forward? (e.g. \"Tuesday and Thursday\")");
        return;
    }
    const raw = await parseWithClaude('Extract days of the week as a JSON array using full names (Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday). ' +
        '"weekdays" or "mon-fri" = ["Monday","Tuesday","Wednesday","Thursday","Friday"]. ' +
        '"weekends" = ["Saturday","Sunday"]. ' +
        '"every day" or "daily" = all 7 days. ' +
        'Return only a JSON array, nothing else.', text);
    let newDays = [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0)
            newDays = parsed;
    }
    catch ( /**/_a) { /**/ }
    if (newDays.length === 0) {
        await (0, client_1.sendMessage)(chatId, "I couldn't pick out the days from that. Try something like 'Tuesday and Thursday' or 'every Monday'.");
        return;
    }
    await mergeScheduleData(phone, { newDays });
    const data = await getScheduleData(phone);
    if (data.changeWhat === "days_only") {
        await updateStep(phone, "ms_confirm");
        await sendConfirmMessage(phone, chatId);
    }
    else {
        // both days + times
        await updateStep(phone, "ms_ask_times");
        await (0, client_1.sendMessage)(chatId, `Got it — ${newDays.join(", ")}! Now what time would you like care to start and end?\n\n` +
            `(e.g. "9am to 3pm", "10:00 to 16:00")`);
    }
}
async function handleMsAskTimes(phone, chatId, text, _session) {
    if (await isQuestionOrOther(text)) {
        await (0, client_1.sendMessage)(chatId, "What time would you like care to start and end? (e.g. \"9am to 3pm\")");
        return;
    }
    const rawStart = await parseWithClaude('Extract the START time from this message. Return HH:MM in 24-hour format. Examples: "9am" → "09:00", "2pm" → "14:00". Return only the time string.', text);
    const rawEnd = await parseWithClaude('Extract the END time from this message. Return HH:MM in 24-hour format. Examples: "3pm" → "15:00", "6pm" → "18:00". Return only the time string.', text);
    const timePattern = /^\d{2}:\d{2}$/;
    if (!timePattern.test(rawStart) || !timePattern.test(rawEnd)) {
        await (0, client_1.sendMessage)(chatId, "I couldn't parse those times. Please reply with something like '9am to 3pm' or '10:00 to 15:00'.");
        return;
    }
    // Validate end is after start
    const [sh, sm] = rawStart.split(":").map(Number);
    const [eh, em] = rawEnd.split(":").map(Number);
    if (eh * 60 + em <= sh * 60 + sm) {
        await (0, client_1.sendMessage)(chatId, "End time needs to be after start time. What times work for you?");
        return;
    }
    const durationHours = ((eh * 60 + em) - (sh * 60 + sm)) / 60;
    await mergeScheduleData(phone, { newStartTime: rawStart, newEndTime: rawEnd, newDurationHours: durationHours });
    await updateStep(phone, "ms_confirm");
    await sendConfirmMessage(phone, chatId);
}
async function sendConfirmMessage(phone, chatId) {
    var _a;
    const data = await getScheduleData(phone);
    const cgName = (_a = data.caregiverName) !== null && _a !== void 0 ? _a : "your caregiver";
    const parts = [];
    if (data.newDays) {
        parts.push(`Days: ${data.newDays.join(", ")}`);
    }
    if (data.newStartTime && data.newEndTime) {
        const dh = data.newDurationHours ? ` (${data.newDurationHours}h)` : "";
        parts.push(`Time: ${data.newStartTime}–${data.newEndTime}${dh}`);
    }
    await (0, client_1.sendMessage)(chatId, `Here's the updated recurring schedule with ${cgName}:\n\n` +
        `${parts.join("\n")}\n\n` +
        `Future visits will be regenerated with this new schedule.\n\n` +
        `Reply YES to confirm, or NO to cancel.`);
}
async function handleMsConfirm(phone, chatId, text, session) {
    var _a, _b, _c, _d, _e, _f;
    const norm = await parseWithClaude('"yes", "yep", "confirm", "go ahead", "do it", "sounds good", "perfect" = YES. ' +
        '"no", "cancel", "never mind", "stop", "nope" = NO. ' +
        'Reply with exactly YES or NO.', text);
    if (norm.toUpperCase() === "NO") {
        await db.collection("agent_sessions").doc(phone).update({
            modifyScheduleStep: admin.firestore.FieldValue.delete(),
            modifyScheduleData: admin.firestore.FieldValue.delete(),
            stateExpiresAt: admin.firestore.FieldValue.delete(),
        });
        await (0, client_1.sendMessage)(chatId, "No problem — your schedule stays the same. Let me know if you want to make any other changes.");
        return;
    }
    if (!norm.toUpperCase().startsWith("Y")) {
        await sendConfirmMessage(phone, chatId);
        return;
    }
    // Apply the changes
    const data = await getScheduleData(phone);
    const scheduleId = data.scheduleId;
    const clientId = (_a = session.userId) !== null && _a !== void 0 ? _a : phone;
    const schedSnap = await db.collection("recurring_schedules").doc(scheduleId).get();
    if (!schedSnap.exists) {
        await (0, client_1.sendMessage)(chatId, "I couldn't find that schedule. It may have already been cancelled.");
        await db.collection("agent_sessions").doc(phone).update({
            modifyScheduleStep: admin.firestore.FieldValue.delete(),
            modifyScheduleData: admin.firestore.FieldValue.delete(),
            stateExpiresAt: admin.firestore.FieldValue.delete(),
        });
        return;
    }
    const sched = schedSnap.data();
    const newDays = (_b = data.newDays) !== null && _b !== void 0 ? _b : sched.days;
    const newStart = (_c = data.newStartTime) !== null && _c !== void 0 ? _c : sched.startTime;
    const newEnd = (_d = data.newEndTime) !== null && _d !== void 0 ? _d : sched.endTime;
    const [sh2, sm2] = newStart.split(":").map(Number);
    const [eh2, em2] = newEnd.split(":").map(Number);
    const newDuration = ((eh2 * 60 + em2) - (sh2 * 60 + sm2)) / 60;
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();
    // Cancel all future confirmed appointments from the old schedule
    const futureSnap = await db.collection("appointments")
        .where("recurringScheduleId", "==", scheduleId)
        .where("date", ">", today)
        .where("status", "in", ["confirmed"])
        .get();
    const { generateRecurringDates } = await Promise.resolve().then(() => __importStar(require("../scheduled/recurringScheduler")));
    const newDates = generateRecurringDates(today, newDays, 4);
    const batch = db.batch();
    // Cancel old future visits
    for (const doc of futureSnap.docs) {
        batch.update(doc.ref, { status: "cancelled_modified", cancelledAt: now, cancelReason: "schedule_modified" });
    }
    // Update the schedule doc
    batch.update(schedSnap.ref, {
        days: newDays,
        startTime: newStart,
        endTime: newEnd,
        durationHours: newDuration,
        modifiedAt: now,
        lastExtendedAt: now,
        weeksBookedAhead: 4,
    });
    // Create new future visits
    for (const { date } of newDates) {
        const apptRef = db.collection("appointments").doc();
        batch.set(apptRef, {
            clientId: clientId,
            caregiverId: sched.caregiverId,
            caregiverName: sched.caregiverName,
            date,
            startTime: newStart,
            endTime: newEnd,
            durationHours: newDuration,
            hourlyRate: sched.hourlyRate,
            status: "confirmed",
            recurringScheduleId: scheduleId,
            humanApproved: true,
            createdByAgent: true,
            createdAt: now,
        });
    }
    await batch.commit();
    // Notify caregiver
    const cgSnap = await db.collection("caregivers").doc(sched.caregiverId).get();
    const cgPhone = (_e = cgSnap.data()) === null || _e === void 0 ? void 0 : _e.phone;
    if (cgPhone) {
        const { sendToPhone } = await Promise.resolve().then(() => __importStar(require("../linq/client")));
        const daysStr = newDays.join(", ");
        await sendToPhone(cgPhone, `Your recurring schedule with this family has been updated. New schedule: ${daysStr}, ${newStart}–${newEnd}. ` +
            `Old upcoming visits have been replaced with new ones. Please check your schedule.`).catch(() => { });
    }
    // Clear state
    await db.collection("agent_sessions").doc(phone).update({
        modifyScheduleStep: admin.firestore.FieldValue.delete(),
        modifyScheduleData: admin.firestore.FieldValue.delete(),
        stateExpiresAt: admin.firestore.FieldValue.delete(),
    });
    const daysLabel = newDays.join(", ");
    const timeLabel = `${newStart}–${newEnd}`;
    const cgName = (_f = data.caregiverName) !== null && _f !== void 0 ? _f : "your caregiver";
    await (0, client_1.sendMessage)(chatId, `Done! ${cgName}'s schedule is now ${daysLabel}, ${timeLabel}. ` +
        `${newDates.length} new visit${newDates.length !== 1 ? "s" : ""} booked over the next 4 weeks.\n\n` +
        `To pause or cancel anytime, just text me PAUSE SCHEDULE or CANCEL SCHEDULE.`);
}
//# sourceMappingURL=modifyScheduleFlow.js.map