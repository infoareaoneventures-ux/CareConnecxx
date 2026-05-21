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
exports.handleEarningsView = handleEarningsView;
const admin = __importStar(require("firebase-admin"));
const caraMessage_1 = require("../utils/caraMessage");
const db = admin.firestore();
/**
 * VIEW_EARNINGS handler — caregiver asks about their pay/earnings.
 * Single-shot: queries completed appointments for last 30 days,
 * aggregates earnings, and sends a concise summary.
 */
async function handleEarningsView(caregiverId, sendMessage) {
    var _a, _b, _c, _d, _e, _f;
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);
    const today = now.toISOString().slice(0, 10);
    // Load last 30 days of completed appointments
    const [apptSnap, pendingSnap, cgSnap] = await Promise.all([
        db.collection("appointments")
            .where("caregiverId", "==", caregiverId)
            .where("date", ">=", thirtyDaysAgo)
            .where("date", "<=", today)
            .where("status", "==", "completed")
            .get(),
        // Pending timesheets awaiting client approval
        db.collection("shiftHours")
            .where("caregiverId", "==", caregiverId)
            .where("status", "in", ["pending_client_review", "approved"])
            .get(),
        db.collection("caregivers").doc(caregiverId).get(),
    ]);
    const cgData = (_a = cgSnap.data()) !== null && _a !== void 0 ? _a : {};
    const firstName = ((_b = cgData.name) !== null && _b !== void 0 ? _b : "").split(" ")[0] || "there";
    const hourlyRate = Number((_c = cgData.hourlyRate) !== null && _c !== void 0 ? _c : 20);
    // Aggregate 30-day and 7-day earnings from appointments
    let total30 = 0;
    let total7 = 0;
    let visitCount = 0;
    for (const doc of apptSnap.docs) {
        const d = doc.data();
        const rate = Number((_d = d.hourlyRate) !== null && _d !== void 0 ? _d : hourlyRate);
        const hours = Number((_e = d.durationHours) !== null && _e !== void 0 ? _e : 0);
        const earned = rate * hours;
        total30 += earned;
        visitCount++;
        if (d.date >= weekAgo)
            total7 += earned;
    }
    // Pending pay: approved timesheets not yet paid out
    let pendingCents = 0;
    let pendingCount = 0;
    for (const doc of pendingSnap.docs) {
        const d = doc.data();
        if (!d.payoutId && !d.paidAt) {
            pendingCents += Number((_f = d.amountCents) !== null && _f !== void 0 ? _f : 0);
            pendingCount++;
        }
    }
    const pendingAmount = pendingCents / 100;
    // Next payout date — typically next Friday
    const daysUntilFriday = (5 - now.getDay() + 7) % 7 || 7;
    const nextFriday = new Date(now.getTime() + daysUntilFriday * 24 * 60 * 60 * 1000);
    const nextPayoutDate = nextFriday.toLocaleDateString("en-US", { month: "long", day: "numeric" });
    if (visitCount === 0 && pendingAmount === 0) {
        const msg = await (0, caraMessage_1.generateCaraMessage)({
            audience: "caregiver",
            context: `${firstName} asked about their earnings but they have no completed visits in the last 30 days and nothing pending. Let them know gently.`,
            fallback: `No completed visits in the last 30 days yet — earnings will show here once visits are recorded.`,
            maxTokens: 80,
        });
        await sendMessage(msg);
        return;
    }
    const lines = [];
    if (total7 > 0)
        lines.push(`This week: $${total7.toFixed(2)}`);
    if (total30 > 0)
        lines.push(`Last 30 days: $${total30.toFixed(2)} across ${visitCount} visit${visitCount !== 1 ? "s" : ""}`);
    if (pendingAmount > 0)
        lines.push(`Pending payout: $${pendingAmount.toFixed(2)} (${pendingCount} timesheet${pendingCount !== 1 ? "s" : ""} queued)`);
    const opener = await (0, caraMessage_1.generateCaraMessage)({
        audience: "caregiver",
        context: `${firstName} asked to see their earnings. Write a warm 1-sentence intro before the summary. Keep it short.`,
        fallback: `Here's your earnings summary, ${firstName}:`,
        maxTokens: 50,
    });
    const body = lines.join("\n");
    const nextPayoutLine = pendingAmount > 0
        ? `\n\nNext payout: ${nextPayoutDate}`
        : "";
    await sendMessage(`${opener}\n\n${body}${nextPayoutLine}\n\nText PAYOUT to request an instant payout, or ask me anything else.`);
}
//# sourceMappingURL=earningsHandler.js.map