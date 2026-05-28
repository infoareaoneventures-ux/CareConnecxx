"use strict";
/**
 * Vector embedding layer for Cara's memory.
 *
 * Sprint 2 / roadmap §4.5 — substring search alone misses "T2DM" → "diabetes",
 * "fall" → "tripped Tuesday", "Dr. Patel" → "doctor". We add semantic recall
 * on top, fed by OpenAI text-embedding-3-small. Hybrid (substring ∪ cosine)
 * gives both exact recall and synonym recall.
 *
 * Design notes:
 *   • Fail open. If the embedding API errors or the key is missing, we return
 *     null and callers fall back to substring. NEVER throw from these helpers.
 *   • text-embedding-3-small is 1536-dim, $0.02 per 1M tokens — basically free
 *     at our volume. Storage cost on Firestore (~6KB per vector) is the bigger
 *     concern; we keep ≤30 blocks per user per file.
 *   • Cosine similarity is plain dot product over normalized vectors. OpenAI
 *     returns unit-norm vectors so we skip the norm step.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MIN_SIMILARITY = exports.EMBED_DIM = exports.EMBED_MODEL = void 0;
exports.embedText = embedText;
exports.embedMany = embedMany;
exports.cosine = cosine;
exports.splitIntoBlocks = splitIntoBlocks;
exports.rankBySimilarity = rankBySimilarity;
const openaiClient_1 = require("../utils/openaiClient");
exports.EMBED_MODEL = "text-embedding-3-small";
exports.EMBED_DIM = 1536;
// Below this threshold we don't treat a hit as semantically relevant. Picked
// empirically — adjust after telemetry shows real recall/precision numbers.
exports.MIN_SIMILARITY = 0.35;
/**
 * Embed a single piece of text. Returns null on any failure (missing key,
 * network, API error, malformed response). Callers should treat null as
 * "skip semantic, use substring only".
 */
async function embedText(text) {
    var _a, _b;
    const clean = (text !== null && text !== void 0 ? text : "").trim();
    if (!clean)
        return null;
    try {
        const res = await (0, openaiClient_1.getOpenAIClient)().embeddings.create({
            model: exports.EMBED_MODEL,
            input: clean.slice(0, 8000), // text-embedding-3-small input cap is 8191 tokens
        });
        const vec = (_b = (_a = res.data) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.embedding;
        if (!Array.isArray(vec) || vec.length !== exports.EMBED_DIM)
            return null;
        return vec;
    }
    catch (err) {
        console.warn("[embeddings] embedText failed:", err instanceof Error ? err.message : err);
        return null;
    }
}
/**
 * Embed multiple texts in a single API call. Same fail-open semantics — if
 * any error occurs, returns an array of nulls so per-item logic can degrade
 * to substring.
 */
async function embedMany(texts) {
    const input = texts.map((t) => (t !== null && t !== void 0 ? t : "").trim().slice(0, 8000));
    if (input.length === 0 || input.every((t) => !t)) {
        return texts.map(() => null);
    }
    try {
        const res = await (0, openaiClient_1.getOpenAIClient)().embeddings.create({
            model: exports.EMBED_MODEL,
            input,
        });
        return texts.map((_, i) => {
            var _a, _b;
            const vec = (_b = (_a = res.data) === null || _a === void 0 ? void 0 : _a[i]) === null || _b === void 0 ? void 0 : _b.embedding;
            return Array.isArray(vec) && vec.length === exports.EMBED_DIM ? vec : null;
        });
    }
    catch (err) {
        console.warn("[embeddings] embedMany failed:", err instanceof Error ? err.message : err);
        return texts.map(() => null);
    }
}
/**
 * Cosine similarity. OpenAI returns unit-norm vectors so this collapses to a
 * dot product. Defensive against mismatched dims (returns 0).
 */
function cosine(a, b) {
    if (a.length !== b.length)
        return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i++)
        dot += a[i] * b[i];
    return dot;
}
/**
 * Split memory-file content into searchable blocks. We split on blank lines
 * (paragraphs / sections) to match the existing substring search's block
 * boundaries, and skip tiny fragments that would just match noise.
 */
function splitIntoBlocks(content) {
    return (content !== null && content !== void 0 ? content : "")
        .split(/\n\s*\n/)
        .map((b) => b.trim())
        .filter((b) => b.length >= 8);
}
/**
 * Rank items by cosine similarity to a query embedding. Returns items above
 * MIN_SIMILARITY, sorted descending, capped at `topK`.
 */
function rankBySimilarity(items, queryEmbed, topK = 8, minSim = exports.MIN_SIMILARITY) {
    return items
        .map((it) => (Object.assign(Object.assign({}, it), { _sim: cosine(it.embedding, queryEmbed) })))
        .filter((it) => it._sim >= minSim)
        .sort((a, b) => b._sim - a._sim)
        .slice(0, topK);
}
//# sourceMappingURL=embeddings.js.map