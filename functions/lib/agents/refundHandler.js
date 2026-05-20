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
exports.handleRefundRequest = handleRefundRequest;
const admin = __importStar(require("firebase-admin"));
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const db = admin.firestore();
let _claude = null;
function getClaude() {
    if (!_claude)
        _claude = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    return _claude;
}
async function parseWithClaude(prompt, userText) {
    var _a;
    try {
        const response = await getClaude().messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 200,
            system: prompt,
            messages: [{ role: "user", content: userText }],
        });
        return ((_a = response.content[0].text) !== null && _a !== void 0 ? _a : "").trim();
    }
    catch (_b) {
        return "__parse_error__";
    }
}
async function isQuestionOrOther(text) {
    const result = await parseWithClaude("Reply YES if this is a general question or off-topic comment unrelated to answering the current question. Reply NO if it is a direct answer. Only reply YES or NO.", text);
    return result.toUpperCase().startsWith("Y");
}
async function answerQuestionMidFlow(text) {
    var _a;
    const response = await getClaude().messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 120,
        system: "You are Cara, an AI care assistant. A client is in the middle of requesting a refund. " +
            "Answer their question briefly (1–2 sentences). Be helpful and warm.",
        messages: [{ role: "user", content: text }],
    });
    return ((_a = response.content[0].text) !== null && _a !== void 0 ? _a : "").trim();
}
// State flow: identify_visit → select_visit → confirm → submitted
async function handleRefundRequest(clientId, text, session, sendMessage) {
    var _a, _b, _c, _d, _e, _f;
    const step = (_a = session.refundStep) !== null && _a !== void 0 ? _a : "identify_visit";
    // ── identify_visit — load recent visits and ask which one ────────────────
    if (step === "identify_visit") {
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
            refundStep: "select_visit",
            refundCandidates: JSON.stringify(visits),
        });
        const list = visits
            .map(v => { var _a; return `${v.index}. ${v.date} with ${v.caregiverName} — $${(_a = v.cost) !== null && _a !== void 0 ? _a : "?"}`; })
            .join("\n");
        await sendMessage(`Which visit would you like a refund for?\n${list}\n\nJust tell me which one (e.g. "the first one" or "the May 10th visit").`);
        return;
    }
    // ── select_visit — parse which visit they chose ───────────────────────────
    if (step === "select_visit") {
        if (await isQuestionOrOther(text)) {
            const answer = await answerQuestionMidFlow(text);
            await sendMessage(answer);
            const candidates = JSON.parse((_b = session.refundCandidates) !== null && _b !== void 0 ? _b : "[]");
            const list = candidates.map(v => { var _a; return `${v.index}. ${v.date} with ${v.caregiverName} — $${(_a = v.cost) !== null && _a !== void 0 ? _a : "?"}`; }).join("\n");
            await sendMessage(`Which visit would you like a refund for?\n${list}`);
            return;
        }
        const candidates = JSON.parse((_c = session.refundCandidates) !== null && _c !== void 0 ? _c : "[]");
        const raw = await parseWithClaude(`The user is selecting one of ${candidates.length} visits. ` +
            `Visits: ${candidates.map(v => `${v.index}. ${v.date} with ${v.caregiverName}`).join("; ")}. ` +
            `Reply with only the number (1 to ${candidates.length}) of the visit they are referring to, or 0 if unclear.`, text);
        const pick = parseInt(raw, 10);
        const visit = candidates.find(v => v.index === pick);
        if (!visit) {
            await sendMessage(`I didn't catch which visit — please tell me the number (1 to ${candidates.length}) or the date of the visit.`);
            return;
        }
        const visitDesc = `${visit.date} with ${visit.caregiverName}${visit.cost ? ` ($${visit.cost})` : ""}`;
        await db.collection("agent_sessions").doc(clientId).update({
            refundStep: "confirm",
            refundAppointmentId: visit.id,
            refundVisitDescription: visitDesc,
        });
        await sendMessage(`Got it — the ${visitDesc}. Can you tell me briefly why you'd like a refund? ` +
            `(e.g. caregiver no-show, unsatisfactory service, billing error)`);
        return;
    }
    // ── confirm — capture reason and ask for final confirmation ──────────────
    if (step === "confirm") {
        if (await isQuestionOrOther(text)) {
            const answer = await answerQuestionMidFlow(text);
            await sendMessage(answer);
            const desc = (_d = session.refundVisitDescription) !== null && _d !== void 0 ? _d : "that visit";
            await sendMessage(`Why would you like a refund for ${desc}? (e.g. caregiver no-show, unsatisfactory service, billing error)`);
            return;
        }
        const reason = text.trim().slice(0, 300);
        const desc = (_e = session.refundVisitDescription) !== null && _e !== void 0 ? _e : "that visit";
        await db.collection("agent_sessions").doc(clientId).update({
            refundStep: "submitted",
            refundReason: reason,
        });
        await sendMessage(`To confirm — you'd like a refund for ${desc} because: "${reason}".\n\n` +
            `Reply YES to submit the request, or NO to cancel.`);
        return;
    }
    // ── submitted — final YES/NO confirmation ─────────────────────────────────
    if (step === "submitted") {
        const norm = await parseWithClaude('"yes", "yeah", "yep", "correct", "submit it", "go ahead", "please", "do it", "sure" = YES. ' +
            '"no", "never mind", "cancel", "forget it", "nope", "don\'t" = NO. ' +
            'Reply with exactly YES or NO.', text);
        if (norm.toUpperCase() !== "YES") {
            await sendMessage("No problem — refund request cancelled. Let me know if you need anything else.");
            await db.collection("agent_sessions").doc(clientId).update({
                refundStep: admin.firestore.FieldValue.delete(),
                refundAppointmentId: admin.firestore.FieldValue.delete(),
                refundCandidates: admin.firestore.FieldValue.delete(),
                refundReason: admin.firestore.FieldValue.delete(),
                refundVisitDescription: admin.firestore.FieldValue.delete(),
            });
            return;
        }
        const appointmentId = session.refundAppointmentId;
        const refundReason = (_f = session.refundReason) !== null && _f !== void 0 ? _f : "";
        await db.collection("refundRequests").add({
            clientId,
            appointmentId,
            reason: refundReason,
            status: "pending_review",
            requestedAt: new Date().toISOString(),
            source: "cara_self_service",
        });
        await db.collection("agent_sessions").doc(clientId).update({
            refundStep: admin.firestore.FieldValue.delete(),
            refundAppointmentId: admin.firestore.FieldValue.delete(),
            refundCandidates: admin.firestore.FieldValue.delete(),
            refundReason: admin.firestore.FieldValue.delete(),
            refundVisitDescription: admin.firestore.FieldValue.delete(),
        });
        await sendMessage("Your refund request has been submitted. An admin will review it within 24 hours and you'll hear back via text. " +
            "If approved, it typically takes 3–5 business days to appear on your statement.");
    }
}
//# sourceMappingURL=refundHandler.js.map