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
exports.readMemoryFile = readMemoryFile;
exports.writeMemoryFile = writeMemoryFile;
exports.appendToMemoryFile = appendToMemoryFile;
exports.getMemoryContext = getMemoryContext;
exports.initializeMemoryFiles = initializeMemoryFiles;
exports.handleMemoryQuery = handleMemoryQuery;
exports.consolidateMemoryForUser = consolidateMemoryForUser;
const admin = __importStar(require("firebase-admin"));
const claudeClient_1 = require("../utils/claudeClient");
const jsonUtils_1 = require("../utils/jsonUtils");
const storage = admin.storage();
const db = admin.firestore();
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
// zepContext: recent conversational memory from Zep (optional, injected by caller)
async function handleMemoryQuery(userId, chatId, sendMessage, zepContext) {
    var _a;
    const fileContext = await getMemoryContext(userId);
    const combined = [fileContext, zepContext ? `## Recent context\n${zepContext}` : ""]
        .filter(Boolean)
        .join("\n\n");
    if (!combined) {
        await sendMessage(chatId, "I'm still building up my picture of your situation. The more we talk, the more I'll know.");
        return;
    }
    const result = await (0, claudeClient_1.getSharedClient)().messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 220,
        system: "You are Cara, a care assistant. Summarize what you know about this family's care situation " +
            "in 2–3 warm, conversational sentences. No bullet points. No headers. Speak as if recounting " +
            "what a trusted friend would remember.",
        messages: [{ role: "user", content: combined }],
    });
    const summary = ((_a = result.content[0].text) !== null && _a !== void 0 ? _a : "").trim();
    await sendMessage(chatId, summary || "I remember quite a bit — just ask me something specific.");
}
// Consolidate last 7 days of actual conversation messages into memory files.
// `phone` is optional — if omitted, we look it up from agent_sessions using userId.
async function consolidateMemoryForUser(userId, phone) {
    var _a, _b, _c;
    // Resolve phone → agent_conversations doc key
    let conversationKey = phone !== null && phone !== void 0 ? phone : userId;
    if (!phone) {
        const sessionSnap = await db.collection("agent_sessions")
            .where("userId", "==", userId)
            .limit(1)
            .get();
        if (!sessionSnap.empty)
            conversationKey = sessionSnap.docs[0].id;
    }
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).getTime();
    const msgSnap = await db
        .collection("agent_conversations")
        .doc(conversationKey)
        .collection("messages")
        .where("timestamp", ">=", sevenDaysAgo)
        .orderBy("timestamp", "asc")
        .limit(60)
        .get();
    if (msgSnap.empty)
        return;
    const events = msgSnap.docs
        .filter((d) => d.data().role === "user" || d.data().role === "assistant")
        .map((d) => {
        var _a;
        const label = d.data().role === "user" ? "Family" : "Cara";
        const content = (_a = d.data().content) !== null && _a !== void 0 ? _a : "";
        return `[${label}]: ${content.slice(0, 600)}`;
    })
        .join("\n");
    if (!events)
        return;
    const existingContext = await getMemoryContext(userId);
    const result = await (0, claudeClient_1.getSharedClient)().messages.create({
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
    const raw = ((_a = result.content[0].text) !== null && _a !== void 0 ? _a : "").trim();
    const updates = (_b = (0, jsonUtils_1.safeParseJson)(raw, "memoryFiles.consolidate", [], "array")) !== null && _b !== void 0 ? _b : [];
    if (updates.length === 0)
        return;
    const appliedUpdates = [];
    for (const { file, append } of updates) {
        if (ALL_FILES.includes(file) && append) {
            await appendToMemoryFile(userId, file, append).catch(() => { });
            appliedUpdates.push({ file, append });
        }
    }
    // Sync applied updates to Zep knowledge graph (fire-and-forget)
    if (appliedUpdates.length > 0 && phone) {
        const zepUserId = phone.replace(/\D/g, "");
        const { addBusinessDataToZep } = await Promise.resolve().then(() => __importStar(require("./zepClient")));
        addBusinessDataToZep({
            userId: zepUserId,
            data: {
                event_type: "memory_files_consolidated",
                updates: appliedUpdates.map((u) => ({ file: u.file, content: u.append.slice(0, 400) })),
                timestamp: new Date().toISOString(),
                data_source: "cara_memory_consolidation",
            },
        }).catch(() => { });
    }
    // Trim recent_episodes.md if it exceeds 8000 chars
    const episodes = await readMemoryFile(userId, "recent_episodes");
    if (episodes.length > 8000) {
        const trimResult = await (0, claudeClient_1.getSharedClient)().messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 400,
            system: "Summarize the oldest entries in this care episode log into a brief paragraph. " +
                "Keep the most recent entries verbatim. Reply with only the revised markdown content.",
            messages: [{ role: "user", content: episodes }],
        });
        const trimmed = ((_c = trimResult.content[0].text) !== null && _c !== void 0 ? _c : "").trim();
        if (trimmed) {
            await writeMemoryFile(userId, "recent_episodes", trimmed);
            // Keep Zep in sync with the trimmed version so context injection stays consistent.
            if (phone) {
                const zepUserId = phone.replace(/\D/g, "");
                const { addBusinessDataToZep } = await Promise.resolve().then(() => __importStar(require("./zepClient")));
                addBusinessDataToZep({
                    userId: zepUserId,
                    data: {
                        event_type: "recent_episodes_trimmed",
                        content: trimmed.slice(0, 800),
                        timestamp: new Date().toISOString(),
                        data_source: "cara_memory_trim",
                    },
                }).catch(() => { });
            }
        }
    }
}
//# sourceMappingURL=memoryFiles.js.map