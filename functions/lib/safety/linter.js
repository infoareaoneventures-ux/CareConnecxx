"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.lintMessage = lintMessage;
const BANNED_PHRASES = [
    "as an AI",
    "I cannot",
    "I am unable",
    "I don't have the ability",
    "I'm not able to",
    "rest assured",
    "at the end of the day",
    "moving forward",
    "in conclusion",
    "it's important to note",
    "please note that",
    "I want to make sure",
    "I hope this helps",
    "do not hesitate to",
    "feel free to",
    "leverage",
    "utilize",
    "synergy",
    "going forward",
    // Anti-sycophancy: robotic sympathy openers
    "I'm sorry to hear that",
    "I understand your frustration",
    "I understand how difficult",
    "Of course!",
    "Certainly!",
    "Absolutely!",
    "Let me know if you need anything else",
    "Let me know if there's anything else",
    "Is there anything else I can",
];
// Patterns that make text feel robotic or formal
const BANNED_PATTERNS = [
    // Em-dashes → comma
    { pattern: /\s*—\s*/g, replacement: ", " },
    // Trailing "Is there anything else I can help you with?"
    { pattern: /is there anything else (?:I can help(?: you)?(?: with)?|you(?:'d like to discuss)?)\??/gi, replacement: "" },
    // Sycophantic openers: "I understand" as sentence start → nothing (keep the rest)
    { pattern: /^I understand[,.]?\s*/i, replacement: "" },
];
function lintMessage(text) {
    let result = text;
    for (const { pattern, replacement } of BANNED_PATTERNS) {
        result = result.replace(pattern, replacement);
    }
    for (const phrase of BANNED_PHRASES) {
        // Case-insensitive, word-boundary-aware replacement
        const safePhrase = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        result = result.replace(new RegExp(safePhrase, "gi"), "");
    }
    // Clean up double spaces and leading/trailing whitespace left by replacements
    result = result.replace(/  +/g, " ").trim();
    // Remove lines that became empty after phrase removal
    result = result
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .join("\n");
    return result;
}
//# sourceMappingURL=linter.js.map