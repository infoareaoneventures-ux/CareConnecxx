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
exports.classifyCompleteness = classifyCompleteness;
exports.shouldReoffer = shouldReoffer;
exports.sendOnboardingOffer = sendOnboardingOffer;
exports.classifyOfferReply = classifyOfferReply;
exports.markOfferAccepted = markOfferAccepted;
exports.markOfferDeclined = markOfferDeclined;
const admin = __importStar(require("firebase-admin"));
const client_1 = require("../linq/client");
const openaiClient_1 = require("../utils/openaiClient");
const db = admin.firestore();
function classifyCompleteness(session) {
    var _a;
    if (!session)
        return "NEW";
    const step = session.onboardingStep;
    const role = session.userType;
    const data = ((_a = session.onboardingData) !== null && _a !== void 0 ? _a : {});
    const hasName = typeof data.firstName === "string" && data.firstName.trim().length > 0;
    if (step === "complete" && role && hasName)
        return "ONBOARDED";
    return "PARTIAL";
}
// ── Onboarding offer state — tracked per session ─────────────────────────────
// `onboardingOfferState`:
//   "pending"  → we sent the offer; the next inbound is the answer
//   "declined" → user said no; we answer freely but suppress cross-entity data
//   (undefined) → never offered, or offer was accepted (now in onboardingStep flow)
//
// `onboardingOfferedAt` (ISO string) — used to re-offer once per fresh session
// (>12h since last inbound).
const REOFFER_AFTER_MS = 12 * 60 * 60 * 1000;
function shouldReoffer(session) {
    if (!session)
        return false;
    const state = session.onboardingOfferState;
    if (state !== "declined")
        return false;
    const lastInboundAt = session.lastInboundAt;
    if (!lastInboundAt)
        return true;
    return Date.now() - new Date(lastInboundAt).getTime() > REOFFER_AFTER_MS;
}
// ── Send the PARTIAL-state opener ────────────────────────────────────────────
// Direct + transparent wording. Acknowledges the gap, names what's missing,
// asks a single YES/NO question, and pins the session into a "pending" offer
// state so the next inbound is interpreted as the answer.
async function sendOnboardingOffer(phone, chatId, session) {
    var _a;
    const data = ((_a = session.onboardingData) !== null && _a !== void 0 ? _a : {});
    const knownName = data.firstName;
    const migrated = !!session.migratedFromSandbox;
    const hasMissedFromSandbox = migrated || !session.userType || (!knownName && !session.userId);
    const opener = hasMissedFromSandbox
        ? "You're right — we never finished setting up your account. I have your number on file but not your name or what you're looking for. " +
            "Want to do that now? Takes about 2 minutes over text — just reply YES and we'll go."
        : "Looks like we never finished setting up your account properly. " +
            "Want to do that now? Takes about 2 minutes over text — just reply YES and we'll go.";
    await (0, client_1.sendMessage)(chatId, opener);
    await db.collection("agent_sessions").doc(phone).update({
        onboardingOfferState: "pending",
        onboardingOfferedAt: new Date().toISOString(),
    });
}
// ── Interpret the user's reply to the offer ──────────────────────────────────
// Returns:
//   "accept"   → user wants to onboard (YES, "sure", "go ahead", etc.)
//   "decline"  → user said no, not now, etc.
//   "question" → they asked something else; answer it and re-show the offer
//
// Uses gpt-4o-mini per CLAUDE.md (no regex/keyword parsing of intent).
async function classifyOfferReply(text) {
    const norm = text.trim().toUpperCase();
    if (norm === "YES" || norm === "Y")
        return "accept";
    if (norm === "NO" || norm === "N")
        return "decline";
    try {
        const raw = await (0, openaiClient_1.quickComplete)("Cara just asked the user 'Want to set up your account now? Reply YES to go.' " +
            "Classify their reply. Reply with exactly one word:\n" +
            "ACCEPT — they want to do it (yes, sure, ok, let's go, fine, whatever)\n" +
            "DECLINE — they refuse or defer (no, not now, later, busy, skip)\n" +
            "QUESTION — they asked something else or want clarification first", text, { maxTokens: 5 });
        const v = raw.trim().toUpperCase();
        if (v.startsWith("A"))
            return "accept";
        if (v.startsWith("D"))
            return "decline";
        return "question";
    }
    catch (_a) {
        return "question";
    }
}
async function markOfferAccepted(phone) {
    await db.collection("agent_sessions").doc(phone).update({
        onboardingOfferState: admin.firestore.FieldValue.delete(),
        onboardingStep: "ask_role",
        onboardingData: {},
        stateExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
}
async function markOfferDeclined(phone) {
    await db.collection("agent_sessions").doc(phone).update({
        onboardingOfferState: "declined",
    });
}
//# sourceMappingURL=profileCompleteness.js.map