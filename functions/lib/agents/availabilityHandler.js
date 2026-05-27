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
exports.handleAvailabilityUpdate = handleAvailabilityUpdate;
const admin = __importStar(require("firebase-admin"));
const parseWithClaude_1 = require("../utils/parseWithClaude");
const caraMessage_1 = require("../utils/caraMessage");
const db = admin.firestore();
const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
/**
 * Canonical time blocks — same as the UI grid.
 * Cara always asks caregivers to pick from these explicitly so there
 * is zero ambiguity and no approximate time-to-block mapping.
 */
const BLOCKS = {
    morning: { start: "06:00", end: "12:00", label: "Morning", hours: "6am–12pm" },
    afternoon: { start: "12:00", end: "18:00", label: "Afternoon", hours: "12pm–6pm" },
    evening: { start: "18:00", end: "23:00", label: "Evening", hours: "6pm–11pm" },
    overnight: { start: "23:00", end: "06:00", label: "Overnight", hours: "11pm–6am" },
};
const BLOCK_IDS = ["morning", "afternoon", "evening", "overnight"];
/** Convert block ID array → TimeSlot array for Firestore */
function blocksToSlots(blockIds) {
    return blockIds.filter(id => BLOCKS[id]).map(id => ({ start: BLOCKS[id].start, end: BLOCKS[id].end }));
}
/** Convert stored TimeSlots → block IDs (handles both formats in Firestore) */
function slotsToBlocks(slots) {
    const active = new Set();
    const blockMins = {
        morning: { s: 360, e: 720 },
        afternoon: { s: 720, e: 1080 },
        evening: { s: 1080, e: 1380 },
        overnight: { s: 1380, e: 1440 },
    };
    const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
    for (const slot of slots) {
        const s = toMin(slot.start);
        const eRaw = toMin(slot.end);
        const e = eRaw <= s ? eRaw + 1440 : eRaw;
        for (const b of BLOCK_IDS) {
            const r = blockMins[b];
            if (s < r.e && e > r.s)
                active.add(b);
        }
    }
    return BLOCK_IDS.filter(b => active.has(b));
}
/** Format the weekly schedule as readable block names for confirmation SMS */
function formatAvailability(weekly) {
    var _a;
    const lines = [];
    for (const day of DAYS) {
        const slots = (_a = weekly[day]) !== null && _a !== void 0 ? _a : [];
        if (slots.length > 0) {
            const blockNames = slotsToBlocks(slots)
                .map(id => `${BLOCKS[id].label} (${BLOCKS[id].hours})`)
                .join(", ");
            lines.push(`  ${day.charAt(0).toUpperCase() + day.slice(1)}: ${blockNames}`);
        }
    }
    return lines.length > 0 ? lines.join("\n") : "  (no availability set)";
}
/** The block menu shown to caregivers when picking availability */
const BLOCK_MENU = `  1. Morning (6am–12pm)\n` +
    `  2. Afternoon (12pm–6pm)\n` +
    `  3. Evening (6pm–11pm)\n` +
    `  4. Overnight (11pm–6am)`;
async function isQuestionOrOther(text) {
    const result = await (0, parseWithClaude_1.parseWithClaude)("Reply YES if this is a general question or off-topic comment unrelated to confirming a schedule change or picking time blocks. Reply NO if it is a direct answer. Only reply YES or NO.", text, 5);
    return result.toUpperCase().startsWith("Y");
}
/**
 * UPDATE_AVAILABILITY handler — caregiver updates their weekly schedule.
 *
 * Flow:
 *   start           → parse which day(s) and action from message,
 *                      then ask caregiver to pick blocks explicitly
 *   awaiting_blocks → parse block selections, build proposed schedule, ask to confirm
 *   confirm         → YES saves to Firestore; NO cancels
 */
async function handleAvailabilityUpdate(caregiverId, phone, text, session, sendMessage) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
    const step = (_a = session.availabilityStep) !== null && _a !== void 0 ? _a : "start";
    // ── start — identify days + action, then ask which blocks ────────────────
    if (step === "start") {
        // isQuestionOrOther check first
        if (await isQuestionOrOther(text)) {
            await sendMessage("I can update your availability! Just let me know which day(s) you'd like to change.\n\n" +
                "For example:\n" +
                "• \"Add Monday\"\n" +
                "• \"Remove Fridays\"\n" +
                "• \"Change my Tuesday schedule\"");
            return;
        }
        const raw = await (0, parseWithClaude_1.parseWithClaude)(`Extract which days and what action the caregiver wants for their availability. ` +
            `Return ONLY valid JSON: {"action":"add"|"remove"|"replace","days":["monday","tuesday",...]}. ` +
            `"add" = add new availability to those days. ` +
            `"remove" = remove all availability on those days. ` +
            `"replace" = replace existing availability on those days. ` +
            `Use lowercase full day names. ` +
            `If action is unclear but days are mentioned, default to "replace". ` +
            `If you cannot identify any days, return {"action":"unclear","days":[]}.`, text, 200);
        let parsed = { action: "unclear", days: [] };
        try {
            const stripped = raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "");
            parsed = JSON.parse(stripped);
        }
        catch ( /* keep unclear */_l) { /* keep unclear */ }
        const validDays = ((_b = parsed.days) !== null && _b !== void 0 ? _b : []).map(d => d.toLowerCase()).filter(d => DAYS.includes(d));
        if (parsed.action === "unclear" || validDays.length === 0) {
            await sendMessage("Which day(s) would you like to update?\n\n" +
                "For example: \"Monday\", \"Monday and Wednesday\", or \"weekdays\"");
            return;
        }
        const dayList = validDays.map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(", ");
        // "remove" doesn't need block selection — go straight to confirm
        if (parsed.action === "remove") {
            const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
            const current = ((_d = (_c = cgSnap.data()) === null || _c === void 0 ? void 0 : _c.weeklyAvailability) !== null && _d !== void 0 ? _d : {});
            const proposed = JSON.parse(JSON.stringify(current));
            for (const day of validDays)
                delete proposed[day];
            await db.collection("agent_sessions").doc(phone).update({
                availabilityStep: "confirm",
                pendingAvailability: JSON.stringify(proposed),
                stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            });
            const opener = await (0, caraMessage_1.generateCaraMessage)({
                audience: "caregiver",
                context: "Cara is about to show the caregiver their updated availability after removing a day. Write a brief 1-sentence intro asking them to confirm.",
                fallback: "Here's your updated schedule — does this look right?",
                maxTokens: 60,
            });
            await sendMessage(`${opener}\n\n` +
                formatAvailability(proposed) +
                `\n\nReply YES to save, or NO to cancel.`);
            return;
        }
        // For add/replace — ask which blocks
        await db.collection("agent_sessions").doc(phone).update({
            availabilityStep: "awaiting_blocks",
            pendingDays: JSON.stringify(validDays),
            pendingAction: parsed.action,
            stateExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        });
        const verb = parsed.action === "add" ? "add for" : "set for";
        await sendMessage(`Got it — ${dayList}. Which time blocks would you like to ${verb} ${validDays.length === 1 ? "that day" : "those days"}?\n\n` +
            BLOCK_MENU +
            `\n\nReply with the numbers or names (e.g. "1 and 2" or "Morning, Afternoon"). ` +
            `Reply "all" for all blocks or "none" to remove availability.`);
        return;
    }
    // ── awaiting_blocks — parse block selections, build proposed, ask confirm ─
    if (step === "awaiting_blocks") {
        // isQuestionOrOther check first
        if (await isQuestionOrOther(text)) {
            await sendMessage(`Which time blocks would you like?\n\n` +
                BLOCK_MENU +
                `\n\nReply with numbers or names, "all", or "none".`);
            return;
        }
        const pendingDays = JSON.parse((_e = session.pendingDays) !== null && _e !== void 0 ? _e : "[]");
        const pendingAction = (_f = session.pendingAction) !== null && _f !== void 0 ? _f : "replace";
        const raw = await (0, parseWithClaude_1.parseWithClaude)(`The caregiver is selecting which time blocks they are available. ` +
            `The blocks are: morning (6am–12pm), afternoon (12pm–6pm), evening (6pm–11pm), overnight (11pm–6am). ` +
            `Map their reply to block IDs. Rules:\n` +
            `- "1" or "morning" → "morning"\n` +
            `- "2" or "afternoon" → "afternoon"\n` +
            `- "3" or "evening" → "evening"\n` +
            `- "4" or "overnight" → "overnight"\n` +
            `- "all" or "all day" or "everything" → all four blocks\n` +
            `- "none" or "not available" or "remove" → empty array\n` +
            `- "1 and 2" → morning and afternoon\n` +
            `- "morning and afternoon" → morning and afternoon\n` +
            `Return ONLY a JSON array of block IDs, e.g. ["morning","afternoon"] or [].`, text, 100);
        let selectedBlocks = [];
        try {
            const stripped = raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "");
            const parsed = JSON.parse(stripped);
            selectedBlocks = (Array.isArray(parsed) ? parsed : []).filter((b) => BLOCKS[b]);
        }
        catch ( /* empty blocks */_m) { /* empty blocks */ }
        // Load current availability and apply the patch
        const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
        const current = ((_h = (_g = cgSnap.data()) === null || _g === void 0 ? void 0 : _g.weeklyAvailability) !== null && _h !== void 0 ? _h : {});
        const proposed = JSON.parse(JSON.stringify(current));
        if (selectedBlocks.length === 0) {
            // "none" — remove those days
            for (const day of pendingDays)
                delete proposed[day];
        }
        else if (pendingAction === "add") {
            for (const day of pendingDays) {
                const existingBlocks = slotsToBlocks((_j = proposed[day]) !== null && _j !== void 0 ? _j : []);
                const merged = Array.from(new Set([...existingBlocks, ...selectedBlocks]));
                proposed[day] = blocksToSlots(merged);
            }
        }
        else {
            // replace
            for (const day of pendingDays) {
                proposed[day] = blocksToSlots(selectedBlocks);
            }
        }
        // Move to confirm step
        await db.collection("agent_sessions").doc(phone).update({
            availabilityStep: "confirm",
            pendingAvailability: JSON.stringify(proposed),
            pendingDays: admin.firestore.FieldValue.delete(),
            pendingAction: admin.firestore.FieldValue.delete(),
            stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        });
        const opener = await (0, caraMessage_1.generateCaraMessage)({
            audience: "caregiver",
            context: "Cara is about to show the caregiver their updated availability schedule for confirmation. Write a brief 1-sentence intro asking them to confirm it looks right.",
            fallback: "Here's your updated schedule — does this look right?",
            maxTokens: 60,
        });
        await sendMessage(`${opener}\n\n` +
            formatAvailability(proposed) +
            `\n\nReply YES to save, or NO to cancel.`);
        return;
    }
    // ── confirm — apply update or cancel ─────────────────────────────────────
    if (step === "confirm") {
        const proposed = JSON.parse((_k = session.pendingAvailability) !== null && _k !== void 0 ? _k : "{}");
        if (await isQuestionOrOther(text)) {
            await sendMessage(`Your proposed schedule:\n\n` +
                formatAvailability(proposed) +
                `\n\nReply YES to save, or NO to cancel.`);
            return;
        }
        const decision = await (0, parseWithClaude_1.parseWithClaude)('"yes", "yeah", "looks good", "correct", "that\'s right", "save it", "confirm", "go ahead" → YES. ' +
            '"no", "cancel", "never mind", "wait", "wrong", "change it", "nope" → NO. ' +
            'Reply with exactly YES or NO.', text, 5);
        // Clear session state regardless of decision
        await db.collection("agent_sessions").doc(phone).update({
            availabilityStep: admin.firestore.FieldValue.delete(),
            pendingAvailability: admin.firestore.FieldValue.delete(),
            stateExpiresAt: admin.firestore.FieldValue.delete(),
        }).catch(() => { });
        if (decision === "YES") {
            await db.collection("caregivers").doc(caregiverId).update({
                weeklyAvailability: proposed,
                availabilityUpdatedAt: new Date().toISOString(),
            });
            const saveMsg = await (0, caraMessage_1.generateCaraMessage)({
                audience: "caregiver",
                context: "A caregiver just confirmed their updated availability schedule. Cara saved it. Write a warm 1-sentence confirmation.",
                fallback: "Done — your availability has been updated.",
                maxTokens: 60,
            });
            await sendMessage(saveMsg);
        }
        else {
            const cancelMsg = await (0, caraMessage_1.generateCaraMessage)({
                audience: "caregiver",
                context: "A caregiver decided not to apply their proposed availability change. Write a brief 1-sentence acknowledgment and invite them to try again when they're ready.",
                fallback: "No problem — your availability wasn't changed. Let me know whenever you'd like to update it.",
                maxTokens: 60,
            });
            await sendMessage(cancelMsg);
        }
        return;
    }
}
//# sourceMappingURL=availabilityHandler.js.map