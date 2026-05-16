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
exports.refreshAllMatchesWeekly = exports.onHireRequestFeedback = exports.onIntakeUpdatedAiMatch = exports.onIntakeAiMatch = exports.onCaregiverWrite = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const firestore_1 = require("firebase-admin/firestore");
const matchJob_1 = require("../ai/matchJob");
const embeddings_1 = require("../ai/embeddings");
const jobNotifications_1 = require("./jobNotifications");
const CAREGIVER_EMBED_FIELDS = [
    "skills",
    "specializations",
    "specialties",
    "medicalSkills",
    "certifications",
    "languages",
    "bio",
    "about",
    "yearsExperience",
    "experience",
    "personalityTags",
    "personality",
    "adls",
    "adlSkills",
    "gender",
    "petFriendly",
    "hasTransportation",
];
function caregiverFieldsChanged(before, after) {
    if (!before)
        return true;
    return CAREGIVER_EMBED_FIELDS.some((f) => {
        var _a, _b;
        const a = JSON.stringify((_a = before[f]) !== null && _a !== void 0 ? _a : null);
        const b = JSON.stringify((_b = after[f]) !== null && _b !== void 0 ? _b : null);
        return a !== b;
    });
}
exports.onCaregiverWrite = functions.firestore
    .document("caregivers/{caregiverId}")
    .onWrite(async (change, context) => {
    const caregiverId = context.params.caregiverId;
    const after = change.after.exists ? change.after.data() : null;
    if (!after)
        return null;
    const before = change.before.exists ? change.before.data() : null;
    if (before && !caregiverFieldsChanged(before, after)) {
        return null;
    }
    const sourceText = (0, embeddings_1.composeCaregiverText)(after);
    if (!sourceText)
        return null;
    if (after.embeddingInputHash === (0, embeddings_1.hashText)(sourceText)) {
        return null;
    }
    console.log(`[onCaregiverWrite] Re-embedding ${caregiverId}`);
    await (0, matchJob_1.ensureCaregiverEmbedding)(caregiverId, after);
    try {
        await rescoreActiveIntakes();
    }
    catch (err) {
        console.error("[onCaregiverWrite] rescore failed:", err);
    }
    return null;
});
async function rescoreActiveIntakes() {
    const db = admin.firestore();
    const recent = await db
        .collection("clientIntakes")
        .orderBy("createdAt", "desc")
        .limit(50)
        .get()
        .catch(() => null);
    if (!recent || recent.empty)
        return;
    for (const doc of recent.docs) {
        const data = doc.data();
        if (!data)
            continue;
        try {
            await (0, matchJob_1.runMatchingForIntake)(doc.id, data);
        }
        catch (err) {
            console.error(`[rescoreActiveIntakes] failed for intake ${doc.id}:`, err);
        }
    }
}
exports.onIntakeAiMatch = functions.firestore
    .document("clientIntakes/{intakeId}")
    .onCreate(async (snap, context) => {
    var _a;
    const intakeId = context.params.intakeId;
    const data = snap.data();
    if (!data)
        return null;
    try {
        const result = await (0, matchJob_1.runMatchingForIntake)(intakeId, data);
        console.log(`[onIntakeAiMatch] Wrote ${(_a = result === null || result === void 0 ? void 0 : result.count) !== null && _a !== void 0 ? _a : 0} matches for client ${result === null || result === void 0 ? void 0 : result.clientId}`);
        if (result === null || result === void 0 ? void 0 : result.clientId) {
            await (0, jobNotifications_1.createJobPost)(intakeId, data, result.clientId);
            await (0, jobNotifications_1.notifyAreaCaregivers)(intakeId, data, result.clientId);
        }
    }
    catch (err) {
        console.error("[onIntakeAiMatch] failed:", err);
    }
    return null;
});
exports.onIntakeUpdatedAiMatch = functions.firestore
    .document("clientIntakes/{intakeId}")
    .onUpdate(async (change, context) => {
    var _a;
    const intakeId = context.params.intakeId;
    const before = change.before.data();
    const after = change.after.data();
    if (!after)
        return null;
    const watched = ["careTypes", "tasks", "schedule", "additionalComments", "location"];
    const changed = watched.some((f) => { var _a, _b; return JSON.stringify((_a = before === null || before === void 0 ? void 0 : before[f]) !== null && _a !== void 0 ? _a : null) !== JSON.stringify((_b = after === null || after === void 0 ? void 0 : after[f]) !== null && _b !== void 0 ? _b : null); });
    if (!changed)
        return null;
    try {
        const result = await (0, matchJob_1.runMatchingForIntake)(intakeId, after);
        console.log(`[onIntakeUpdatedAiMatch] Refreshed ${(_a = result === null || result === void 0 ? void 0 : result.count) !== null && _a !== void 0 ? _a : 0} matches for ${result === null || result === void 0 ? void 0 : result.clientId}`);
    }
    catch (err) {
        console.error("[onIntakeUpdatedAiMatch] failed:", err);
    }
    return null;
});
exports.onHireRequestFeedback = functions.firestore
    .document("hire_requests/{requestId}")
    .onWrite(async (change, context) => {
    const after = change.after.exists ? change.after.data() : null;
    if (!after)
        return null;
    const before = change.before.exists ? change.before.data() : null;
    if (before && before.status === after.status)
        return null;
    const clientId = after.clientId;
    const caregiverId = after.caregiverId;
    if (!clientId || !caregiverId)
        return null;
    const positiveStatuses = ["coordinator_approved", "caregiver_accepted", "booking_created"];
    const negativeStatuses = ["rejected", "dismissed", "coordinator_rejected", "client_rejected"];
    const isPositive = positiveStatuses.includes(after.status);
    const isNegative = negativeStatuses.includes(after.status);
    if (!isPositive && !isNegative)
        return null;
    try {
        if (isPositive) {
            await admin
                .firestore()
                .collection("users")
                .doc(clientId)
                .collection("match_history")
                .doc(caregiverId)
                .set({
                caregiverId,
                signal: "hired",
                signals: { hired: firestore_1.FieldValue.serverTimestamp() },
                weight: firestore_1.FieldValue.increment(5),
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            }, { merge: true });
            console.log(`[onHireRequestFeedback] Logged 'hired' for client ${clientId} ↔ caregiver ${caregiverId}`);
        }
        else {
            // Negative signal: reduce boost weight so this caregiver ranks lower in future
            await admin
                .firestore()
                .collection("users")
                .doc(clientId)
                .collection("match_history")
                .doc(caregiverId)
                .set({
                caregiverId,
                signal: "rejected",
                signals: { rejected: firestore_1.FieldValue.serverTimestamp() },
                weight: firestore_1.FieldValue.increment(-3),
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            }, { merge: true });
            console.log(`[onHireRequestFeedback] Logged 'rejected' for client ${clientId} ↔ caregiver ${caregiverId}`);
        }
    }
    catch (err) {
        console.error("[onHireRequestFeedback] failed:", err);
    }
    return null;
});
exports.refreshAllMatchesWeekly = functions.pubsub
    .schedule("every monday 04:00")
    .timeZone("America/Los_Angeles")
    .onRun(async () => {
    const db = admin.firestore();
    const intakes = await db
        .collection("clientIntakes")
        .orderBy("createdAt", "desc")
        .limit(200)
        .get()
        .catch(() => null);
    if (!intakes || intakes.empty) {
        console.log("[refreshAllMatchesWeekly] No intakes to refresh");
        return null;
    }
    let count = 0;
    for (const doc of intakes.docs) {
        try {
            await (0, matchJob_1.runMatchingForIntake)(doc.id, doc.data());
            count++;
        }
        catch (err) {
            console.error(`[refreshAllMatchesWeekly] failed for ${doc.id}:`, err);
        }
    }
    console.log(`[refreshAllMatchesWeekly] Refreshed ${count} intakes`);
    return null;
});
//# sourceMappingURL=aiMatchTriggers.js.map