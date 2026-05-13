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
exports.generateCareMemoryKeepsake = generateCareMemoryKeepsake;
const admin = __importStar(require("firebase-admin"));
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const memoryFiles_1 = require("../memory/memoryFiles");
const db = admin.firestore();
const storage = admin.storage();
let _claude = null;
function getClaude() {
    if (!_claude)
        _claude = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    return _claude;
}
async function generateCareMemoryKeepsake(seniorId, userId) {
    var _a;
    // Gather memory files + last 20 journal entries
    const [memoryContext, journalSnap] = await Promise.all([
        (0, memoryFiles_1.getMemoryContext)(userId),
        db.collection("care_journal")
            .where("seniorId", "==", seniorId)
            .orderBy("timestamp", "desc")
            .limit(20)
            .get(),
    ]);
    const journalEntries = journalSnap.docs
        .map((d) => {
        var _a, _b, _c, _d;
        const e = d.data();
        const date = (_b = (_a = e.timestamp) === null || _a === void 0 ? void 0 : _a.slice(0, 10)) !== null && _b !== void 0 ? _b : "unknown date";
        const notes = e.notes ? e.notes.slice(0, 300) : "";
        const mood = (_d = (_c = e.wellness) === null || _c === void 0 ? void 0 : _c.mood) !== null && _d !== void 0 ? _d : "";
        return `${date}: ${mood ? `Mood ${mood}. ` : ""}${notes}`;
    })
        .join("\n");
    const result = await getClaude().messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 800,
        system: "You are writing a warm, compassionate memory keepsake for a family who has lost their loved one. " +
            "Based on the care history below, write a 3–5 paragraph tribute that celebrates the person's life, " +
            "the care they received, and the love surrounding them. " +
            "Tone: warm, personal, comforting — like a loving letter, not a report. " +
            "Do not use bullet points or headers. Write in flowing prose.",
        messages: [{
                role: "user",
                content: `Care history:\n${memoryContext}\n\nJournal highlights:\n${journalEntries}`,
            }],
    });
    const keepsake = ((_a = result.content[0].text) !== null && _a !== void 0 ? _a : "").trim();
    if (!keepsake)
        return "";
    // Save to Firebase Storage
    const path = `keepsakes/${userId}/care_memory.md`;
    const bucket = storage.bucket();
    await bucket.file(path).save(keepsake, {
        contentType: "text/markdown",
        metadata: { cacheControl: "no-cache" },
    });
    // Generate signed URL (7-day access)
    const [url] = await bucket.file(path).getSignedUrl({
        action: "read",
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    return url;
}
//# sourceMappingURL=careMemory.js.map