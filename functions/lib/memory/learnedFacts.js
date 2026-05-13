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
exports.extractAndStoreFacts = extractAndStoreFacts;
exports.getRelevantFacts = getRelevantFacts;
const admin = __importStar(require("firebase-admin"));
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const db = admin.firestore();
let _claude = null;
function getClaude() {
    if (!_claude)
        _claude = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    return _claude;
}
// Normalize a fact string for deduplication comparison
function normalizeFact(fact) {
    return fact.toLowerCase().replace(/\s+/g, " ").trim();
}
async function extractAndStoreFacts(userId, text) {
    var _a, _b;
    if (!text || text.length < 10)
        return;
    let extracted = [];
    try {
        const result = await getClaude().messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 300,
            system: "Extract persistent, reusable facts about the user's care situation from this message. " +
                "Categories: medical (diagnoses, meds, allergies), preference (likes/dislikes, habits), " +
                "routine (schedule, recurring activities), family (relationships, names). " +
                "Only extract facts that are clearly stated and would be useful in future conversations. " +
                "Reply with only a JSON array: [{\"fact\": \"...\", \"category\": \"medical|preference|routine|family\"}]. " +
                "Return [] if nothing worth storing.",
            messages: [{ role: "user", content: text }],
        });
        extracted = JSON.parse((_a = result.content[0].text) !== null && _a !== void 0 ? _a : "[]");
    }
    catch (_c) {
        return; // Non-critical — don't throw
    }
    if (!Array.isArray(extracted) || extracted.length === 0)
        return;
    const factsCol = db.collection("learned_facts").doc(userId).collection("facts");
    const nowIso = new Date().toISOString();
    for (const item of extracted) {
        if (!item.fact || !item.category)
            continue;
        const norm = normalizeFact(item.fact);
        // Check for existing fact with same normalized text
        const existing = await factsCol
            .where("_norm", "==", norm)
            .limit(1)
            .get();
        if (!existing.empty) {
            const doc = existing.docs[0];
            const currentWeight = (_b = doc.data().weight) !== null && _b !== void 0 ? _b : 1;
            await doc.ref.update({
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
        }
    }
}
async function getRelevantFacts(userId, _topic) {
    const snap = await db
        .collection("learned_facts")
        .doc(userId)
        .collection("facts")
        .orderBy("weight", "desc")
        .limit(10)
        .get();
    return snap.docs.map((d) => {
        const data = d.data();
        return {
            userId: data.userId,
            fact: data.fact,
            weight: data.weight,
            category: data.category,
            createdAt: data.createdAt,
            lastMentionedAt: data.lastMentionedAt,
        };
    });
}
//# sourceMappingURL=learnedFacts.js.map