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
exports.listMemoryFiles = listMemoryFiles;
exports.readMemoryFile = readMemoryFile;
exports.writeMemoryFile = writeMemoryFile;
exports.appendToMemoryFile = appendToMemoryFile;
exports.editMemoryFile = editMemoryFile;
exports.searchMemory = searchMemory;
exports.searchMemoryHybrid = searchMemoryHybrid;
exports.getMemoryContext = getMemoryContext;
exports.initializeMemoryFiles = initializeMemoryFiles;
exports.handleMemoryQuery = handleMemoryQuery;
exports.consolidateMemoryForUser = consolidateMemoryForUser;
const admin = __importStar(require("firebase-admin"));
const claudeClient_1 = require("../utils/claudeClient");
const jsonUtils_1 = require("../utils/jsonUtils");
const embeddings_1 = require("./embeddings");
const storage = admin.storage();
const db = admin.firestore();
const ALL_FILES = ["profile", "health", "family", "recent_episodes", "procedural"];
// Restrict slugs to a safe charset so a file name can never escape the user's prefix.
function sanitizeFileName(file) {
    const slug = String(file).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 64);
    return slug || "untitled";
}
function filePath(userId, file) {
    return `memory/${userId}/${sanitizeFileName(file)}.md`;
}
// Enumerate the memory files that actually exist for a user (canonical + ad-hoc).
async function listMemoryFiles(userId) {
    try {
        const bucket = storage.bucket();
        const [files] = await bucket.getFiles({ prefix: `memory/${userId}/` });
        return files
            .map((f) => f.name.slice(`memory/${userId}/`.length).replace(/\.md$/, ""))
            .filter(Boolean);
    }
    catch (_a) {
        return [];
    }
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
    // Refresh block embeddings for this file. Failure is non-fatal — substring
    // search still works; we just lose semantic recall until the next write.
    reindexMemoryFileEmbeddings(userId, file, content).catch((err) => {
        console.warn("[memoryFiles] reindex failed:", err instanceof Error ? err.message : err);
    });
}
// Replace all embeddings for a single memory file. Idempotent. Skipped silently
// when no blocks pass the size filter or when the OpenAI key is absent (embedMany
// returns nulls, which we filter out).
async function reindexMemoryFileEmbeddings(userId, file, content) {
    const slug = sanitizeFileName(file);
    const blocks = (0, embeddings_1.splitIntoBlocks)(content);
    const col = db.collection("memory_embeddings").doc(userId).collection("blocks");
    // Delete prior embeddings for this file (whole-file rewrite, so no diffing).
    const prior = await col.where("file", "==", slug).get();
    if (!prior.empty) {
        const batch = db.batch();
        prior.docs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
    }
    if (blocks.length === 0)
        return;
    const vectors = await (0, embeddings_1.embedMany)(blocks);
    const batch = db.batch();
    const nowIso = new Date().toISOString();
    let wrote = 0;
    for (let i = 0; i < blocks.length; i++) {
        const vec = vectors[i];
        if (!vec)
            continue; // embedding API failed for this block — skip
        const ref = col.doc();
        batch.set(ref, {
            file: slug,
            block: blocks[i].slice(0, 800),
            embedding: vec,
            model: embeddings_1.EMBED_MODEL,
            updatedAt: nowIso,
        });
        wrote++;
    }
    if (wrote > 0)
        await batch.commit();
}
async function appendToMemoryFile(userId, file, entry) {
    const existing = await readMemoryFile(userId, file);
    const updated = existing
        ? `${existing.trimEnd()}\n\n${entry}`
        : entry;
    await writeMemoryFile(userId, file, updated);
}
// Surgical find/replace within a single memory file — for correcting a stored fact
// ("Mom is 82 not 78") without rewriting the whole file or appending a duplicate.
// Returns the number of occurrences replaced (0 = no match, file left untouched).
async function editMemoryFile(userId, file, find, replace) {
    if (!find)
        return 0;
    const existing = await readMemoryFile(userId, file);
    if (!existing || !existing.includes(find))
        return 0;
    const count = existing.split(find).length - 1;
    const updated = existing.split(find).join(replace);
    await writeMemoryFile(userId, file, updated);
    return count;
}
// Substring search across all of a user's memory files. Returns the matching
// sections so the QA agent can retrieve a fact without injecting all ~12K chars.
async function searchMemory(userId, query) {
    const q = query.trim().toLowerCase();
    if (!q)
        return [];
    const files = await listMemoryFiles(userId);
    const hits = [];
    for (const file of files) {
        const content = await readMemoryFile(userId, file);
        if (!content)
            continue;
        // Split into blocks on blank lines so a hit returns a coherent chunk of context.
        for (const block of content.split(/\n\s*\n/)) {
            if (block.toLowerCase().includes(q)) {
                hits.push({ file, section: block.trim().slice(0, 800), source: "substring", score: 1 });
            }
        }
    }
    return hits;
}
/**
 * Hybrid memory search — substring (exact) ∪ semantic (cosine over embeddings).
 *
 * Substring is run unconditionally so we never regress on exact-match recall.
 * Semantic recall pulls in synonym / paraphrase matches that substring would miss
 * ("T2DM" → "diabetes", "tripped Tuesday" → "fall"). If the embedding API fails
 * or the key is missing, this collapses cleanly to substring-only.
 */
async function searchMemoryHybrid(userId, query, topK = 8) {
    var _a, _b;
    const q = (query !== null && query !== void 0 ? query : "").trim();
    if (!q)
        return [];
    // Run substring + query embedding in parallel — substring is local-ish (Storage
    // reads), embedding is one OpenAI call; we don't want to serialize them.
    const [substringHits, queryEmbed] = await Promise.all([
        searchMemory(userId, q),
        (0, embeddings_1.embedText)(q),
    ]);
    let semanticHits = [];
    if (queryEmbed) {
        try {
            const snap = await db
                .collection("memory_embeddings")
                .doc(userId)
                .collection("blocks")
                .get();
            const candidates = snap.docs.map((d) => {
                const data = d.data();
                return { file: data.file, block: data.block, embedding: data.embedding };
            });
            const ranked = (0, embeddings_1.rankBySimilarity)(candidates, queryEmbed, topK);
            semanticHits = ranked.map((r) => ({
                file: r.file,
                section: r.block,
                source: "semantic",
                score: r._sim,
            }));
        }
        catch (err) {
            console.warn("[memoryFiles] semantic search failed:", err instanceof Error ? err.message : err);
        }
    }
    // Dedup on (file, section) — prefer substring hits (score=1) over semantic.
    const seen = new Map();
    for (const hit of [...substringHits, ...semanticHits]) {
        const key = `${hit.file}::${hit.section.slice(0, 200)}`;
        const existing = seen.get(key);
        if (!existing || ((_a = hit.score) !== null && _a !== void 0 ? _a : 0) > ((_b = existing.score) !== null && _b !== void 0 ? _b : 0)) {
            seen.set(key, hit);
        }
    }
    return Array.from(seen.values())
        .sort((a, b) => { var _a, _b; return ((_a = b.score) !== null && _a !== void 0 ? _a : 0) - ((_b = a.score) !== null && _b !== void 0 ? _b : 0); })
        .slice(0, topK);
}
// Returns existing files concatenated, trimmed to ~3000 tokens (~12 000 chars).
// Enumerates the user's bucket prefix so ad-hoc files are included, with the five
// canonical files ordered first.
async function getMemoryContext(userId) {
    const present = await listMemoryFiles(userId);
    const ordered = [
        ...ALL_FILES.filter((f) => present.includes(f)),
        ...present.filter((f) => !ALL_FILES.includes(f)).sort(),
    ];
    const parts = await Promise.all(ordered.map(async (file) => {
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