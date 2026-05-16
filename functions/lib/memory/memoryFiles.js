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
exports.readMemoryFile = readMemoryFile;
exports.writeMemoryFile = writeMemoryFile;
exports.appendToMemoryFile = appendToMemoryFile;
exports.getMemoryContext = getMemoryContext;
exports.initializeMemoryFiles = initializeMemoryFiles;
exports.handleMemoryQuery = handleMemoryQuery;
exports.consolidateMemoryForUser = consolidateMemoryForUser;
const admin = __importStar(require("firebase-admin"));
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const storage = admin.storage();
const db = admin.firestore();
let _claude = null;
function getClaude() {
    if (!_claude)
        _claude = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    return _claude;
}
const ALL_FILES = ["profile", "health", "family", "recent_episodes", "procedural"];
function filePath(userId, file) {
    return `memory/${userId}/${file}.md`;
}
async function readMemoryFile(userId, file) {
    try {
        const bucket = storage.bucket();
        const [contents] = await bucket.file(filePath(userId, file)).download();
        return contents.toString("utf-8");
    }
    catch (_a) {
        return "";
    }
}
async function writeMemoryFile(userId, file, content) {
    const bucket = storage.bucket();
    await bucket.file(filePath(userId, file)).save(content, {
        contentType: "text/markdown",
        metadata: { cacheControl: "no-cache" },
    });
}
async function appendToMemoryFile(userId, file, entry) {
    const existing = await readMemoryFile(userId, file);
    const updated = existing
        ? `${existing.trimEnd()}\n\n${entry}`
        : entry;
    await writeMemoryFile(userId, file, updated);
}
// Returns all 5 files concatenated, trimmed to ~3000 tokens (~12 000 chars)
async function getMemoryContext(userId) {
    const parts = await Promise.all(ALL_FILES.map(async (file) => {
        const content = await readMemoryFile(userId, file);
        return content ? `## ${file}\n${content}` : "";
    }));
    const combined = parts.filter(Boolean).join("\n\n");
    if (combined.length <= 12000)
        return combined;
    return combined.slice(0, 12000) + "\n\n[Memory truncated for length]";
}
async function initializeMemoryFiles(userId, data) {
    var _a, _b, _c, _d, _e, _f;
    const seniorName = (_a = data.seniorName) !== null && _a !== void 0 ? _a : "your loved one";
    const clientName = (_b = data.clientName) !== null && _b !== void 0 ? _b : "";
    const relationship = (_c = data.relationship) !== null && _c !== void 0 ? _c : "family member";
    const conditions = Array.isArray(data.conditions)
        ? data.conditions.join(", ")
        : ((_d = data.conditions) !== null && _d !== void 0 ? _d : "none noted");
    const careNeeds = Array.isArray(data.careNeeds)
        ? data.careNeeds.join(", ")
        : ((_e = data.careNeeds) !== null && _e !== void 0 ? _e : "general support");
    const profileMd = `# Profile\n\n` +
        `**Senior:** ${seniorName}${data.seniorAge ? `, age ${data.seniorAge}` : ""}\n` +
        `**Primary contact:** ${clientName} (${relationship})\n` +
        `**Location:** ${(_f = data.city) !== null && _f !== void 0 ? _f : "unknown"}\n` +
        `**Care needs:** ${careNeeds}\n`;
    const healthMd = `# Health\n\n` +
        `**Conditions:** ${conditions}\n` +
        `**Medications:** unknown\n` +
        `**Allergies:** unknown\n`;
    await Promise.all([
        writeMemoryFile(userId, "profile", profileMd),
        writeMemoryFile(userId, "health", healthMd),
    ]);
}
// Triggered when user asks "what do you know about mom?" (or similar)
async function handleMemoryQuery(userId, chatId, sendMessage) {
    var _a;
    const context = await getMemoryContext(userId);
    if (!context) {
        await sendMessage(chatId, "I'm still building up my picture of your situation. The more we talk, the more I'll know.");
        return;
    }
    const result = await getClaude().messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        system: "You are Cara, a care assistant. Summarize what you know about this family's care situation " +
            "in 2–3 warm, conversational sentences. No bullet points. No headers. Speak as if recounting " +
            "what a trusted friend would remember.",
        messages: [{ role: "user", content: context }],
    });
    const summary = ((_a = result.content[0].text) !== null && _a !== void 0 ? _a : "").trim();
    await sendMessage(chatId, summary || "I remember quite a bit — just ask me something specific.");
}
// Consolidate last 48h of audit log entries into memory files
async function consolidateMemoryForUser(userId) {
    var _a, _b;
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const logSnap = await db
        .collection("agent_audit_log")
        .where("userId", "==", userId)
        .where("timestamp", ">=", fortyEightHoursAgo)
        .orderBy("timestamp", "asc")
        .limit(50)
        .get();
    if (logSnap.empty)
        return;
    const events = logSnap.docs
        .map((d) => d.data())
        .filter((e) => e.eventType === "message_sent" || e.eventType === "message_received")
        .map((e) => `[${e.timestamp}] ${e.eventType}: ${JSON.stringify(e.data).slice(0, 200)}`)
        .join("\n");
    if (!events)
        return;
    const existingContext = await getMemoryContext(userId);
    const result = await getClaude().messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 600,
        system: "You maintain memory files for a caregiving AI assistant named Cara. " +
            "Based on recent conversation events, extract new facts and decide which memory files to update. " +
            "Memory files: profile (identity/contact prefs), health (diagnoses/meds/allergies), " +
            "family (relationships/dynamics), recent_episodes (last 30 days events), procedural (routines). " +
            "Reply with JSON: [{\"file\": \"<type>\", \"append\": \"<markdown to append>\"}]. " +
            "Only include files that need updating. Keep appended content concise (1–3 lines each).",
        messages: [{
                role: "user",
                content: `Existing memory:\n${existingContext}\n\nRecent events:\n${events}`,
            }],
    });
    let updates = [];
    try {
        updates = JSON.parse((_a = result.content[0].text) !== null && _a !== void 0 ? _a : "[]");
    }
    catch (_c) {
        return;
    }
    for (const { file, append } of updates) {
        if (ALL_FILES.includes(file) && append) {
            await appendToMemoryFile(userId, file, append).catch(() => { });
        }
    }
    // Trim recent_episodes.md if it exceeds 8000 chars
    const episodes = await readMemoryFile(userId, "recent_episodes");
    if (episodes.length > 8000) {
        const trimResult = await getClaude().messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 400,
            system: "Summarize the oldest entries in this care episode log into a brief paragraph. " +
                "Keep the most recent entries verbatim. Reply with only the revised markdown content.",
            messages: [{ role: "user", content: episodes }],
        });
        const trimmed = ((_b = trimResult.content[0].text) !== null && _b !== void 0 ? _b : "").trim();
        if (trimmed)
            await writeMemoryFile(userId, "recent_episodes", trimmed);
    }
}
//# sourceMappingURL=memoryFiles.js.map