"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleScheduleRequest = handleScheduleRequest;
exports.handleTriggerManagement = handleTriggerManagement;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const claudeRetry_1 = require("../utils/claudeRetry");
const caraAgent_1 = require("./caraAgent");
const userTriggerManager_1 = require("../triggers/userTriggerManager");
let _client = null;
function getClient() {
    if (!_client) {
        _client = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    return _client;
}
async function parseScheduleRequest(userMessage) {
    var _a;
    const today = new Date().toISOString().slice(0, 10);
    const response = await (0, claudeRetry_1.callClaudeWithRetry)(getClient(), {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 120,
        system: `Today is ${today}. ` +
            "Extract a reminder schedule from the user's message. Reply with a JSON object only:\n" +
            '{"recurrence":"daily"|"weekly"|"monthly"|"once","dayOfWeek":0-6|null,"hour":0-23,"minute":0-59,"label":"short name","message":"full reminder text"}\n' +
            "dayOfWeek: 0=Sunday, 1=Monday ... 6=Saturday. Null for non-weekly. " +
            "hour/minute: 24h format. " +
            "label: short user-facing name (e.g. 'mom medications'). " +
            "message: the full text Cara will send as the reminder. " +
            "If you cannot parse a schedule, reply with null.",
        messages: [{ role: "user", content: userMessage }],
    }, { timeoutMs: 8000, maxAttempts: 2 });
    const raw = ((_a = response.content[0].text) !== null && _a !== void 0 ? _a : "").trim();
    if (raw === "null" || raw === "")
        return null;
    try {
        return JSON.parse(raw);
    }
    catch (_b) {
        return null;
    }
}
async function handleScheduleRequest(phone, userMessage, session) {
    var _a, _b;
    const userId = ((_a = session.userId) !== null && _a !== void 0 ? _a : phone);
    const chatId = session.chatId;
    const parsed = await parseScheduleRequest(userMessage);
    if (!parsed) {
        await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
            content: "I didn't quite catch that schedule. Could you be more specific? " +
                "For example: 'Remind me every Monday at 9am about mom's medications.'",
            urgency: "standard",
            sourceAgent: "scheduling_handler",
            canDrop: false,
        });
        return;
    }
    await (0, userTriggerManager_1.createUserTrigger)(phone, userId, {
        label: parsed.label,
        recurrence: parsed.recurrence,
        dayOfWeek: (_b = parsed.dayOfWeek) !== null && _b !== void 0 ? _b : undefined,
        hour: parsed.hour,
        minute: parsed.minute,
        message: parsed.message,
    });
    const recurrenceText = formatRecurrenceConfirmation(parsed);
    await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
        content: `Done — I'll remind you ${recurrenceText} about ${parsed.label}. Reply "show reminders" anytime to manage them.`,
        urgency: "standard",
        sourceAgent: "scheduling_handler",
        canDrop: false,
    });
}
async function handleTriggerManagement(phone, userMessage, session) {
    const norm = userMessage.trim().toLowerCase();
    // "show my reminders" / "list reminders"
    if (norm.includes("show") || norm.includes("list") || norm.includes("what reminders")) {
        const triggers = await (0, userTriggerManager_1.listUserTriggers)(phone);
        if (triggers.length === 0) {
            await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
                content: "You don't have any active reminders set up. Text me something like 'Remind me every Monday at 9am about mom's medications' to add one.",
                urgency: "standard",
                sourceAgent: "scheduling_handler",
                canDrop: false,
            });
            return;
        }
        const lines = triggers.map((t, i) => `${i + 1}. ${t.label} — ${formatRecurrenceConfirmation(t)}`).join("\n");
        await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
            content: `Your active reminders:\n\n${lines}\n\nTo cancel one, reply "cancel [name]".`,
            urgency: "standard",
            sourceAgent: "scheduling_handler",
            canDrop: false,
        });
        return;
    }
    // "cancel my [label] reminder"
    if (norm.includes("cancel") || norm.includes("delete") || norm.includes("remove")) {
        const triggers = await (0, userTriggerManager_1.listUserTriggers)(phone);
        if (triggers.length === 0) {
            await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
                content: "You don't have any active reminders to cancel.",
                urgency: "standard",
                sourceAgent: "scheduling_handler",
                canDrop: false,
            });
            return;
        }
        // Find the best matching trigger by label
        const match = triggers.find(t => norm.includes(t.label.toLowerCase()));
        if (!match) {
            const labels = triggers.map(t => t.label).join(", ");
            await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
                content: `I didn't find a matching reminder. Your active reminders: ${labels}. Which one would you like to cancel?`,
                urgency: "standard",
                sourceAgent: "scheduling_handler",
                canDrop: false,
            });
            return;
        }
        await (0, userTriggerManager_1.deleteUserTrigger)(phone, match.id);
        await (0, caraAgent_1.sendViaInteractionAgent)(phone, {
            content: `Cancelled — I'll stop sending the "${match.label}" reminder.`,
            urgency: "standard",
            sourceAgent: "scheduling_handler",
            canDrop: false,
        });
        return;
    }
    // Default: treat as a new schedule request
    await handleScheduleRequest(phone, userMessage, session);
}
function formatRecurrenceConfirmation(t) {
    var _a;
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const h = t.hour;
    const m = t.minute;
    const ampm = h >= 12 ? "pm" : "am";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    const mStr = m === 0 ? "" : `:${String(m).padStart(2, "0")}`;
    const time = `${h12}${mStr}${ampm}`;
    switch (t.recurrence) {
        case "daily": return `every day at ${time}`;
        case "weekly": return `every ${days[(_a = t.dayOfWeek) !== null && _a !== void 0 ? _a : 1]} at ${time}`;
        case "monthly": return `monthly at ${time}`;
        case "once": return `once at ${time}`;
        default: return `at ${time}`;
    }
}
//# sourceMappingURL=schedulingHandler.js.map