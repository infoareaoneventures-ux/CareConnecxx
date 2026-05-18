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
exports.writeFeedbackSignal = writeFeedbackSignal;
exports.readClientFeedback = readClientFeedback;
exports.boostForCaregiver = boostForCaregiver;
const admin = __importStar(require("firebase-admin"));
const MAX_BOOST = 5; // max positive boost (pts)
const MAX_PENALTY = -5; // max negative penalty (pts)
async function writeFeedbackSignal(params) {
    var _a, _b, _c;
    const db = admin.firestore();
    const ref = db.collection("users").doc(params.clientId)
        .collection("match_history").doc(params.caregiverId);
    const snap = await ref.get();
    const current = snap.exists ? ((_b = (_a = snap.data()) === null || _a === void 0 ? void 0 : _a.weight) !== null && _b !== void 0 ? _b : 0) : 0;
    const next = Math.min(MAX_BOOST, Math.max(MAX_PENALTY, current + params.signal));
    await ref.set({
        weight: next,
        lastUpdated: new Date().toISOString(),
        lastSource: params.source,
        lastAppointmentId: (_c = params.appointmentId) !== null && _c !== void 0 ? _c : null,
        signalCount: admin.firestore.FieldValue.increment(1),
    }, { merge: true });
    console.log(`[writeFeedbackSignal] ${params.clientId} ↔ ${params.caregiverId}: ` +
        `${current} + ${params.signal} = ${next} (${params.source})`);
}
async function readClientFeedback(clientId) {
    const map = new Map();
    if (!clientId)
        return map;
    try {
        const snap = await admin
            .firestore()
            .collection("users")
            .doc(clientId)
            .collection("match_history")
            .limit(500)
            .get();
        snap.forEach((doc) => {
            const data = doc.data();
            const raw = Number(data.weight || 0);
            if (raw === 0)
                return;
            // Clamp to [MAX_PENALTY, MAX_BOOST]
            map.set(doc.id, Math.min(MAX_BOOST, Math.max(MAX_PENALTY, raw)));
        });
    }
    catch (err) {
        console.warn("[readClientFeedback] failed:", err);
    }
    return map;
}
function boostForCaregiver(feedback, caregiverId) {
    return feedback.get(caregiverId) || 0;
}
//# sourceMappingURL=feedback.js.map