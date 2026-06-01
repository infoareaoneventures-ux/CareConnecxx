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
exports.checkDisputeSLAs = exports.onDisputeCreated = void 0;
const functions = __importStar(require("firebase-functions/v1"));
const admin = __importStar(require("firebase-admin"));
const caraAgent_1 = require("../agents/caraAgent");
const db = admin.firestore();
// ── onDisputeCreated — notify both parties and set 48h SLA ────────────────────
exports.onDisputeCreated = functions.firestore
    .document("disputes/{disputeId}")
    .onCreate(async (snap, context) => {
    var _a, _b, _c;
    const disputeId = context.params.disputeId;
    const dispute = snap.data();
    if (!dispute)
        return;
    const { clientId, caregiverId, appointmentId, reason } = dispute;
    // Load phones for both parties
    const [clientSnap, caregiverSnap] = await Promise.all([
        db.collection("users").doc(clientId !== null && clientId !== void 0 ? clientId : "").get(),
        db.collection("caregivers").doc(caregiverId !== null && caregiverId !== void 0 ? caregiverId : "").get(),
    ]);
    const clientPhone = (_a = clientSnap.data()) === null || _a === void 0 ? void 0 : _a.phone;
    const caregiverPhone = (_b = caregiverSnap.data()) === null || _b === void 0 ? void 0 : _b.phone;
    const slaDeadline = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    // Record SLA deadline on the dispute
    await snap.ref.update({ slaDeadline, status: "open", notifiedAt: new Date().toISOString() });
    const displayReason = (_c = reason) !== null && _c !== void 0 ? _c : "a billing concern";
    // Notify family
    if (clientPhone) {
        await (0, caraAgent_1.sendViaInteractionAgent)(clientPhone, {
            content: `We received a dispute regarding ${displayReason}.\n\n` +
                `Our team is reviewing it and will respond within 48 hours. ` +
                `Reply with any additional details you'd like us to consider.`,
            urgency: "standard",
            sourceAgent: "dispute_resolution",
            canDrop: false,
        }).catch(err => console.error("[onDisputeCreated] notify client failed:", err));
    }
    // Notify caregiver
    if (caregiverPhone) {
        await (0, caraAgent_1.sendViaInteractionAgent)(caregiverPhone, {
            content: `A dispute has been filed regarding ${displayReason}.\n\n` +
                `Please reply with your account of what happened so we can review it fairly.`,
            urgency: "standard",
            sourceAgent: "dispute_resolution",
            canDrop: false,
        }).catch(err => console.error("[onDisputeCreated] notify caregiver failed:", err));
    }
    // Log admin alert
    await db.collection("admin_alerts").add({
        type: "dispute_opened",
        disputeId,
        clientId,
        caregiverId,
        appointmentId,
        reason,
        slaDeadline,
        createdAt: new Date().toISOString(),
        resolved: false,
    });
    console.log(`[onDisputeCreated] Dispute ${disputeId} opened, SLA: ${slaDeadline}`);
});
// ── checkDisputeSLAs — runs every hour, escalates disputes past 48h ───────────
exports.checkDisputeSLAs = functions.pubsub
    .schedule("0 * * * *") // top of every hour
    .onRun(async () => {
    const now = new Date().toISOString();
    const snap = await db.collection("disputes")
        .where("status", "==", "open")
        .where("slaDeadline", "<=", now)
        .get();
    if (snap.empty)
        return null;
    for (const doc of snap.docs) {
        const dispute = doc.data();
        try {
            await escalateDispute(doc.id, dispute);
        }
        catch (err) {
            console.error(`[checkDisputeSLAs] escalation failed for dispute ${doc.id}:`, err);
        }
    }
    console.log(`[checkDisputeSLAs] Escalated ${snap.size} overdue disputes`);
    return null;
});
async function escalateDispute(disputeId, dispute) {
    var _a, _b, _c, _d;
    // Mark escalated so it doesn't get picked up again
    await db.collection("disputes").doc(disputeId).update({
        status: "escalated",
        escalatedAt: new Date().toISOString(),
    });
    // Notify both parties of escalation
    const [clientSnap, caregiverSnap] = await Promise.all([
        db.collection("users").doc((_a = dispute.clientId) !== null && _a !== void 0 ? _a : "").get(),
        db.collection("caregivers").doc((_b = dispute.caregiverId) !== null && _b !== void 0 ? _b : "").get(),
    ]);
    const clientPhone = (_c = clientSnap.data()) === null || _c === void 0 ? void 0 : _c.phone;
    const caregiverPhone = (_d = caregiverSnap.data()) === null || _d === void 0 ? void 0 : _d.phone;
    const escalationMsg = "Your dispute has been escalated to our senior care team for a final decision. " +
        "You'll hear from us within 24 hours.";
    if (clientPhone) {
        await (0, caraAgent_1.sendViaInteractionAgent)(clientPhone, {
            content: escalationMsg,
            urgency: "standard",
            sourceAgent: "dispute_resolution",
            canDrop: false,
        }).catch(() => { });
    }
    if (caregiverPhone) {
        await (0, caraAgent_1.sendViaInteractionAgent)(caregiverPhone, {
            content: escalationMsg,
            urgency: "standard",
            sourceAgent: "dispute_resolution",
            canDrop: false,
        }).catch(() => { });
    }
    // Mark admin alert for immediate attention
    await db.collection("admin_alerts").add({
        type: "dispute_escalated",
        disputeId,
        clientId: dispute.clientId,
        caregiverId: dispute.caregiverId,
        createdAt: new Date().toISOString(),
        resolved: false,
        priority: "high",
    });
    console.log(`[escalateDispute] Dispute ${disputeId} escalated`);
}
//# sourceMappingURL=disputeResolution.js.map