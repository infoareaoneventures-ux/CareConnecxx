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
exports.handleRefundRequest = handleRefundRequest;
const admin = __importStar(require("firebase-admin"));
const db = admin.firestore();
// State stored in agent_sessions.refundStep
// Steps: identify_visit → confirm → submitted
async function handleRefundRequest(clientId, text, session, sendMessage) {
    var _a, _b;
    const step = (_a = session.refundStep) !== null && _a !== void 0 ? _a : "identify_visit";
    if (step === "identify_visit") {
        // Get recent appointments for this client
        const apptSnap = await db.collection("appointments")
            .where("clientId", "==", clientId)
            .where("status", "in", ["completed", "confirmed"])
            .orderBy("isoDate", "desc")
            .limit(5)
            .get();
        if (apptSnap.empty) {
            await sendMessage("I don't see any recent visits to refund. If you think this is a mistake, I can create a support ticket for you.");
            await db.collection("agent_sessions").doc(clientId).update({ refundStep: admin.firestore.FieldValue.delete() });
            return;
        }
        const visits = apptSnap.docs.map((d, i) => {
            const data = d.data();
            return {
                index: i + 1,
                id: d.id,
                date: data.date,
                caregiverName: data.caregiverName,
                cost: data.cost,
            };
        });
        await db.collection("agent_sessions").doc(clientId).update({
            refundStep: "confirm",
            refundCandidates: JSON.stringify(visits),
        });
        const list = visits
            .map(v => { var _a; return `${v.index}. ${v.date} with ${v.caregiverName} — $${(_a = v.cost) !== null && _a !== void 0 ? _a : "?"}`; })
            .join("\n");
        await sendMessage(`Which visit would you like a refund for?\n${list}\n\nReply with the number.`);
        return;
    }
    if (step === "confirm") {
        const candidates = JSON.parse((_b = session.refundCandidates) !== null && _b !== void 0 ? _b : "[]");
        const pick = parseInt(text.trim(), 10);
        const visit = candidates.find(v => v.index === pick);
        if (!visit) {
            await sendMessage(`Please reply with a number between 1 and ${candidates.length}.`);
            return;
        }
        await db.collection("agent_sessions").doc(clientId).update({
            refundStep: "submitted",
            refundAppointmentId: visit.id,
        });
        await sendMessage(`Just to confirm — you want a refund for the ${visit.date} visit with ${visit.caregiverName}? ` +
            `Reply YES to submit the request.`);
        return;
    }
    if (step === "submitted") {
        const norm = text.trim().toUpperCase();
        if (norm !== "YES") {
            await sendMessage("No problem — refund request cancelled. Let me know if you need anything else.");
            await db.collection("agent_sessions").doc(clientId).update({
                refundStep: admin.firestore.FieldValue.delete(),
                refundAppointmentId: admin.firestore.FieldValue.delete(),
                refundCandidates: admin.firestore.FieldValue.delete(),
            });
            return;
        }
        const appointmentId = session.refundAppointmentId;
        await db.collection("refundRequests").add({
            clientId,
            appointmentId,
            status: "pending_review",
            requestedAt: new Date().toISOString(),
            source: "cara_self_service",
        });
        await db.collection("agent_sessions").doc(clientId).update({
            refundStep: admin.firestore.FieldValue.delete(),
            refundAppointmentId: admin.firestore.FieldValue.delete(),
            refundCandidates: admin.firestore.FieldValue.delete(),
        });
        await sendMessage("Your refund request has been submitted. An admin will review it within 24 hours and you'll hear back via text. " +
            "If approved, it typically takes 3–5 business days to appear on your statement.");
    }
}
//# sourceMappingURL=refundHandler.js.map