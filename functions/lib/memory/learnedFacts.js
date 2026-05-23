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
exports.extractAndStoreFacts = extractAndStoreFacts;
exports.getRelevantFacts = getRelevantFacts;
exports.updateOrRetractFact = updateOrRetractFact;
exports.detectAndApplyCorrection = detectAndApplyCorrection;
const admin = __importStar(require("firebase-admin"));
const openaiClient_1 = require("../utils/openaiClient");
const db = admin.firestore();
// Normalize a fact string for deduplication comparison
function normalizeFact(fact) {
    return fact.toLowerCase().replace(/\s+/g, " ").trim();
}
// Strip common LLM JSON wrappers (markdown code fences, leading prose).
// gpt-4o-mini and Claude both occasionally return JSON wrapped in ```json ... ```
// or with a stray sentence before the array; we extract the JSON substring.
function unwrapJson(raw) {
    let s = (raw !== null && raw !== void 0 ? raw : "").trim();
    // Strip leading/trailing markdown code fences
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    // If extra prose precedes the array, find the first '[' and last ']'
    const start = s.indexOf("[");
    const end = s.lastIndexOf("]");
    if (start >= 0 && end > start)
        s = s.slice(start, end + 1);
    return s;
}
async function extractAndStoreFacts(userId, text, zepUserId) {
    var _a;
    if (!text || text.length < 10)
        return;
    let extracted = [];
    try {
        const raw = await (0, openaiClient_1.quickComplete)("Extract persistent, reusable facts about the user's care situation from this message. " +
            "Categories: medical (diagnoses, meds, allergies), preference (likes/dislikes, habits), " +
            "routine (schedule, recurring activities), family (relationships, names). " +
            "Only extract facts that are clearly stated and would be useful in future conversations. " +
            "Reply with ONLY a raw JSON array (no markdown, no prose): " +
            "[{\"fact\": \"...\", \"category\": \"medical|preference|routine|family\"}]. " +
            "Return [] if nothing worth storing.", text, { maxTokens: 300 });
        const cleaned = unwrapJson(raw);
        if (!cleaned)
            return;
        extracted = JSON.parse(cleaned);
    }
    catch (err) {
        console.warn("[learnedFacts] extractAndStoreFacts failed:", err instanceof Error ? err.message : err, { userId });
        return;
    }
    if (!Array.isArray(extracted) || extracted.length === 0)
        return;
    const factsCol = db.collection("learned_facts").doc(userId).collection("facts");
    const nowIso = new Date().toISOString();
    const newFacts = [];
    for (const item of extracted) {
        if (!item.fact || !item.category)
            continue;
        const norm = normalizeFact(item.fact);
        // Check for existing active (non-superseded) fact with same normalized text
        const existing = await factsCol
            .where("_norm", "==", norm)
            .limit(1)
            .get();
        const activeExisting = existing.docs.find((d) => !d.data().supersededAt);
        if (activeExisting) {
            const currentWeight = (_a = activeExisting.data().weight) !== null && _a !== void 0 ? _a : 1;
            await activeExisting.ref.update({
                weight: Math.min(currentWeight + 1, 10),
                lastMentionedAt: nowIso,
            });
        }
        else {
            await factsCol.add({
                userId,
                fact: item.fact,
                _norm: norm,
                weight: 1,
                category: item.category,
                createdAt: nowIso,
                lastMentionedAt: nowIso,
            });
            newFacts.push({ fact: item.fact, category: item.category });
        }
    }
    // Push newly-stored facts to Zep knowledge graph (fire-and-forget)
    if (zepUserId && newFacts.length > 0) {
        const { addBusinessDataToZep } = await Promise.resolve().then(() => __importStar(require("./zepClient")));
        addBusinessDataToZep({
            userId: zepUserId,
            data: {
                event_type: "learned_facts_extracted",
                facts: newFacts,
                source_text: text.slice(0, 200),
                timestamp: nowIso,
                data_source: "cara_fact_extraction",
            },
        }).catch(() => { });
    }
}
async function getRelevantFacts(userId, _topic) {
    // Fetch top-20 by weight, then filter superseded client-side (avoids composite index)
    const snap = await db
        .collection("learned_facts")
        .doc(userId)
        .collection("facts")
        .orderBy("weight", "desc")
        .limit(20)
        .get();
    return snap.docs
        .filter((d) => !d.data().supersededAt)
        .slice(0, 10)
        .map((d) => ({
        userId: d.data().userId,
        fact: d.data().fact,
        weight: d.data().weight,
        category: d.data().category,
        createdAt: d.data().createdAt,
        lastMentionedAt: d.data().lastMentionedAt,
        _docId: d.id,
    }));
}
// Soft-delete an existing fact and optionally replace it with a corrected version.
// Both the new-fact creation and the old-fact supersession are wrapped in a single
// Firestore transaction to prevent the "both facts active" corruption if we crash between writes.
async function updateOrRetractFact(userId, oldDocId, newFact, zepUserId) {
    var _a, _b;
    const factsCol = db.collection("learned_facts").doc(userId).collection("facts");
    const nowIso = new Date().toISOString();
    const oldRef = factsCol.doc(oldDocId);
    const newRef = newFact ? factsCol.doc() : null;
    let oldFactText;
    await db.runTransaction(async (t) => {
        var _a;
        const oldSnap = await t.get(oldRef);
        oldFactText = oldSnap.exists ? (_a = oldSnap.data()) === null || _a === void 0 ? void 0 : _a.fact : undefined;
        if (newRef && newFact) {
            t.set(newRef, {
                userId,
                fact: newFact.fact,
                _norm: normalizeFact(newFact.fact),
                weight: 2, // user explicitly stated — start higher than passive extraction
                category: newFact.category,
                createdAt: nowIso,
                lastMentionedAt: nowIso,
            });
        }
        t.update(oldRef, Object.assign({ supersededAt: nowIso }, (newRef ? { supersededBy: newRef.id } : {})));
    });
    // Sync correction to Zep as a bi-temporal event (fire-and-forget, non-blocking)
    if (zepUserId) {
        const { addBusinessDataToZep } = await Promise.resolve().then(() => __importStar(require("./zepClient")));
        addBusinessDataToZep({
            userId: zepUserId,
            data: {
                event_type: "fact_correction",
                old_fact: oldFactText !== null && oldFactText !== void 0 ? oldFactText : oldDocId,
                new_fact: (_a = newFact === null || newFact === void 0 ? void 0 : newFact.fact) !== null && _a !== void 0 ? _a : null,
                category: (_b = newFact === null || newFact === void 0 ? void 0 : newFact.category) !== null && _b !== void 0 ? _b : null,
                corrected_at: nowIso,
                data_source: "cara_correction",
            },
        }).catch(() => { });
    }
}
// Detect if the user's message corrects a known fact, and apply the correction.
// Returns true if a correction was found and applied.
async function detectAndApplyCorrection(userId, text, zepUserId) {
    var _a;
    // Fast pre-filter — only run if message looks like a correction or an update to known information.
    // Deliberately broad: false positives are cheap (one Haiku call); false negatives silently corrupt memory.
    if (!/actually|wait,?|sorry|i meant|meant to say|no,?\s*it'?s|that'?s wrong|wrong,?\s*it'?s|not\s+\d+|his\s+(doctor|nurse|med|name|age|condition)|her\s+(doctor|nurse|med|name|age|condition)|they?\s+(changed|switched|stopped|started|now\s+takes?|no\s+longer)|update|correction|forgot\s+to\s+mention|should\s+be|it'?s\s+actually|the\s+(new|correct|right)\s+(doctor|medication|med|number|address|diagnosis)/i.test(text)) {
        return false;
    }
    const currentFacts = await getRelevantFacts(userId).catch(() => []);
    if (currentFacts.length === 0)
        return false;
    const factsJson = currentFacts
        .map((f, i) => `${i}: "${f.fact}" [${f.category}]`)
        .join("\n");
    let raw;
    try {
        raw = await (0, openaiClient_1.quickComplete)("The user may be correcting previously stated information about their care situation. " +
            "You are given a numbered list of known facts and the user's message. " +
            "If the message directly corrects one of the known facts, reply with JSON only (no markdown fences): " +
            "{\"corrects\": <index>, \"newFact\": \"<corrected text>\", \"category\": \"medical|preference|routine|family\"}. " +
            "If the message retracts a fact without replacement: {\"corrects\": <index>, \"newFact\": null}. " +
            "If this is NOT a correction of a known fact, reply with the single word: null", `Known facts:\n${factsJson}\n\nUser message: "${text}"`, { maxTokens: 200 });
        raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    }
    catch (_b) {
        return false;
    }
    if (raw === "null" || !raw.startsWith("{"))
        return false;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (_c) {
        return false;
    }
    const targetFact = currentFacts[parsed.corrects];
    if (!targetFact)
        return false;
    await updateOrRetractFact(userId, targetFact._docId, parsed.newFact
        ? { fact: parsed.newFact, category: (_a = parsed.category) !== null && _a !== void 0 ? _a : targetFact.category }
        : undefined, zepUserId);
    return true;
}
//# sourceMappingURL=learnedFacts.js.map