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
exports.aggregateFeedbackForCaregiver = aggregateFeedbackForCaregiver;
exports.handleLowRating = handleLowRating;
exports.onFeedbackSubmitted = onFeedbackSubmitted;
const admin = __importStar(require("firebase-admin"));
const caraAgent_1 = require("./caraAgent");
const db = admin.firestore();
// ── Aggregate post-visit feedback into caregiver document ────────────────────
async function aggregateFeedbackForCaregiver(caregiverId) {
    const snap = await db.collection("post_visit_feedback")
        .where("caregiverId", "==", caregiverId)
        .where("status", "==", "submitted")
        .get();
    if (snap.empty)
        return;
    let total = 0;
    let count = 0;
    let lastFeedbackAt = "";
    for (const doc of snap.docs) {
        const data = doc.data();
        const rating = data.rating;
        if (typeof rating === "number" && rating >= 1 && rating <= 5) {
            total += rating;
            count += 1;
        }
        const createdAt = data.createdAt;
        if (createdAt && createdAt > lastFeedbackAt) {
            lastFeedbackAt = createdAt;
        }
    }
    if (count === 0)
        return;
    const averageRating = Math.round((total / count) * 100) / 100;
    await db.collection("caregivers").doc(caregiverId).update({
        averageRating,
        rating: averageRating, // matchingAgent.ts reads caregiver.rating
        ratingCount: count,
        lastFeedbackAt,
    });
}
// ── Create admin alert when a low rating is submitted ────────────────────────
async function handleLowRating(caregiverId, rating, appointmentId, clientId) {
    await db.collection("admin_alerts").add({
        type: "low_caregiver_rating",
        caregiverId,
        rating,
        appointmentId,
        clientId,
        resolved: false,
        priority: "medium",
        createdAt: new Date().toISOString(),
    });
}
// ── Detect repeated negative feedback from same client → suggest switch ──────
async function checkSatisfactionTrend(caregiverId, clientId) {
    var _a, _b, _c;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const recentSnap = await db.collection("post_visit_feedback")
        .where("caregiverId", "==", caregiverId)
        .where("clientId", "==", clientId)
        .where("createdAt", ">=", thirtyDaysAgo)
        .get();
    const negCount = recentSnap.docs.filter(d => d.data().rating <= 2).length;
    if (negCount < 2)
        return;
    // Gate: only suggest once per 14 days per (client, caregiver) pair
    const gateKey = `satisfactionAlertSent_${caregiverId}`;
    const clientSnap = await db.collection("users").doc(clientId).get();
    const clientData = (_a = clientSnap.data()) !== null && _a !== void 0 ? _a : {};
    const lastSent = clientData[gateKey];
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    if (lastSent && lastSent > fourteenDaysAgo)
        return;
    // Look up client phone from agent_sessions
    const sessionSnap = await db.collection("agent_sessions")
        .where("userId", "==", clientId)
        .limit(1)
        .get();
    if (sessionSnap.empty)
        return;
    const clientPhone = sessionSnap.docs[0].id;
    // Get caregiver name
    const cgSnap = await db.collection("caregivers").doc(caregiverId).get();
    const cgName = cgSnap.exists
        ? `${(_b = cgSnap.data().firstName) !== null && _b !== void 0 ? _b : ""} ${(_c = cgSnap.data().lastName) !== null && _c !== void 0 ? _c : ""}`.trim() || "your caregiver"
        : "your caregiver";
    await (0, caraAgent_1.sendViaInteractionAgent)(clientPhone, {
        content: `I noticed you've had a few visits with ${cgName} that didn't go as well as hoped. Would you like me to find someone new who might be a better fit? Just say "find a new caregiver" and I'll get started.`,
        urgency: "standard",
        sourceAgent: "feedback_aggregator",
        canDrop: true,
    }).catch(() => { });
    await db.collection("users").doc(clientId).update({
        [gateKey]: new Date().toISOString(),
    });
}
// ── Single entry point after any feedback is saved ───────────────────────────
async function onFeedbackSubmitted(caregiverId, rating, appointmentId, clientId) {
    await aggregateFeedbackForCaregiver(caregiverId);
    if (rating < 3.5) {
        await handleLowRating(caregiverId, rating, appointmentId, clientId);
    }
    if (rating <= 2) {
        checkSatisfactionTrend(caregiverId, clientId).catch((err) => console.error("[feedbackAggregator] checkSatisfactionTrend error:", err));
    }
}
//# sourceMappingURL=feedbackAggregator.js.map