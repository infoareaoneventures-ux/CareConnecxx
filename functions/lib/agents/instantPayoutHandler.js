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
exports.startInstantPayout = startInstantPayout;
exports.handleInstantPayoutConfirm = handleInstantPayoutConfirm;
const admin = __importStar(require("firebase-admin"));
const stripe_1 = __importDefault(require("stripe"));
const client_1 = require("../linq/client");
const parseWithClaude_1 = require("../utils/parseWithClaude");
const openaiClient_1 = require("../utils/openaiClient");
const caraMessage_1 = require("../utils/caraMessage");
const db = admin.firestore();
let _stripe = null;
function getStripe() {
    var _a;
    if (!_stripe)
        _stripe = new stripe_1.default((_a = process.env.STRIPE_SECRET_KEY) !== null && _a !== void 0 ? _a : "", { apiVersion: "2023-10-16" });
    return _stripe;
}
/**
 * Entry: caregiver texts PAYOUT (or NLU classifies as INSTANT_PAYOUT). We look up
 * their available balance via Stripe Connect and ask for confirmation. The
 * router calls handleInstantPayoutConfirm for the subsequent YES/NO reply.
 */
async function startInstantPayout(caregiverId, phone, chatId) {
    var _a, _b;
    const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
    const cg = cgSnap.data();
    if (!cg) {
        await (0, client_1.sendMessage)(chatId, "I couldn't find your caregiver profile. Please contact support.");
        return;
    }
    const stripeAccountId = cg.stripeAccountId;
    if (!stripeAccountId) {
        await (0, client_1.sendMessage)(chatId, "Your payout account isn't set up yet. Reach out to support to finish setup.");
        return;
    }
    // Pull available balance from Stripe Connect
    let availableCents = 0;
    let currency = "usd";
    try {
        const balance = await getStripe().balance.retrieve({ stripeAccount: stripeAccountId });
        const inst = ((_b = (_a = balance.instant_available) !== null && _a !== void 0 ? _a : balance.available) !== null && _b !== void 0 ? _b : []);
        if (inst.length > 0) {
            availableCents = inst[0].amount;
            currency = inst[0].currency;
        }
    }
    catch (err) {
        console.error("[instantPayout] balance retrieve failed:", err);
        await (0, client_1.sendMessage)(chatId, "I couldn't pull your balance right now. Try again in a few minutes or contact support.");
        return;
    }
    if (availableCents <= 0) {
        await (0, client_1.sendMessage)(chatId, "You don't have any funds available for instant payout right now. Your next scheduled payout is on its regular Friday cadence.");
        return;
    }
    const amount = (availableCents / 100).toFixed(2);
    await db.collection("agent_sessions").doc(phone).update({
        pendingInstantPayoutConfirm: new Date().toISOString(),
    });
    await (0, client_1.sendMessage)(chatId, `You have $${amount} available for instant payout.\n\n` +
        `Instant payouts arrive within 30 minutes (Stripe charges a 1.5% fee). ` +
        `Send $${amount} to your bank now? Reply YES or NO.`);
    // Stash the balance on the session for the confirm step (saves another balance call)
    await db.collection("agent_sessions").doc(phone).update({
        pendingInstantPayoutAmount: String(availableCents),
        pendingInstantPayoutCurrency: currency,
        pendingInstantPayoutStripeAccount: stripeAccountId,
    });
    void currency; // used in confirm step via session
}
async function handleInstantPayoutConfirm(caregiverId, phone, text, chatId) {
    var _a, _b, _c;
    // isQuestionOrOther guard
    const reAsk = "Send the instant payout? Reply YES or NO.";
    const isQ = await (0, parseWithClaude_1.parseWithClaude)(`A caregiver was asked: "${reAsk}". ` +
        "Reply YES if their message is a question or off-topic, NO if it's a direct yes/no answer. Only reply YES or NO.", text, 5);
    if (isQ.toUpperCase().startsWith("Y")) {
        const answer = await (0, openaiClient_1.quickComplete)("You are Cara. A caregiver was asked to confirm an instant payout and asked a question instead. " +
            "Answer briefly (1-2 sentences). Do NOT ask them to confirm — that prompt comes next.", text, { maxTokens: 150 }).catch(() => "Let me get back to you on that. In the meantime —");
        await (0, client_1.sendMessage)(chatId, `${answer}\n\n${reAsk}`);
        return;
    }
    const decision = await (0, parseWithClaude_1.parseWithClaude)('"yes", "confirm", "send it", "do it", "now" → YES. "no", "wait", "cancel", "not yet" → NO. Reply exactly YES or NO.', text, 5);
    const sessionSnap = await db.collection("agent_sessions").doc(phone).get();
    const sd = (_a = sessionSnap.data()) !== null && _a !== void 0 ? _a : {};
    const stripeAccountId = sd.pendingInstantPayoutStripeAccount;
    const amountCents = parseInt((_b = sd.pendingInstantPayoutAmount) !== null && _b !== void 0 ? _b : "0", 10);
    const currency = (_c = sd.pendingInstantPayoutCurrency) !== null && _c !== void 0 ? _c : "usd";
    // Clear state regardless of decision
    await db.collection("agent_sessions").doc(phone).update({
        pendingInstantPayoutConfirm: admin.firestore.FieldValue.delete(),
        pendingInstantPayoutAmount: admin.firestore.FieldValue.delete(),
        pendingInstantPayoutCurrency: admin.firestore.FieldValue.delete(),
        pendingInstantPayoutStripeAccount: admin.firestore.FieldValue.delete(),
    });
    if (decision !== "YES" || !stripeAccountId || amountCents <= 0) {
        const msg = await (0, caraMessage_1.generateCaraMessage)({
            audience: "caregiver",
            context: "A caregiver decided not to take an instant payout right now. Brief, neutral acknowledgment.",
            fallback: "No problem — your balance stays in your account until the next regular payout.",
            maxTokens: 60,
        });
        await (0, client_1.sendMessage)(chatId, msg);
        return;
    }
    // Trigger the Stripe instant payout
    try {
        const payout = await getStripe().payouts.create({
            amount: amountCents,
            currency,
            method: "instant",
            description: "Instant payout requested via Cara SMS",
        }, { stripeAccount: stripeAccountId });
        await db.collection("instant_payouts").add({
            caregiverId,
            phone,
            stripeAccountId,
            stripePayoutId: payout.id,
            amountCents,
            currency,
            requestedAt: new Date().toISOString(),
            source: "cara_sms",
        });
        const amountStr = `$${(amountCents / 100).toFixed(2)}`;
        await (0, client_1.sendMessage)(chatId, `Done — $${(amountCents / 100).toFixed(2)} is on the way to your bank. ` +
            `Instant payouts typically arrive within 30 minutes.`);
        void amountStr;
    }
    catch (err) {
        console.error("[instantPayout] payouts.create failed:", err);
        await (0, client_1.sendMessage)(chatId, "I wasn't able to process that instant payout — Stripe rejected it. " +
            "This usually means your bank isn't enabled for instant payouts. " +
            "Your funds are safe and will arrive on the regular schedule. Contact support if this keeps happening.");
    }
}
//# sourceMappingURL=instantPayoutHandler.js.map