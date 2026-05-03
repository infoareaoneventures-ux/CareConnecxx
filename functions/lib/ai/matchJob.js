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
exports.ensureCaregiverEmbedding = ensureCaregiverEmbedding;
exports.ensureIntakeEmbedding = ensureIntakeEmbedding;
exports.computeMatchesForIntake = computeMatchesForIntake;
exports.writeClientMatches = writeClientMatches;
exports.runMatchingForIntake = runMatchingForIntake;
const admin = __importStar(require("firebase-admin"));
const firestore_1 = require("firebase-admin/firestore");
const embeddings_1 = require("./embeddings");
const scoring_1 = require("./scoring");
const feedback_1 = require("./feedback");
const MAX_CAREGIVERS_PER_RUN = 500;
const TOP_N = 20;
function pickSkills(data) {
    return [
        ...(data.skills || []),
        ...(data.specializations || []),
        ...(data.specialties || []),
    ];
}
function pickNeeds(intake) {
    if (Array.isArray(intake.careTypes))
        return intake.careTypes;
    if (intake.tasks && typeof intake.tasks === "object") {
        return Object.keys(intake.tasks).filter((k) => Array.isArray(intake.tasks[k]) && intake.tasks[k].length > 0);
    }
    return [];
}
function pickLatLng(data) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const lat = (_c = (_a = data.latitude) !== null && _a !== void 0 ? _a : (_b = data.location) === null || _b === void 0 ? void 0 : _b.latitude) !== null && _c !== void 0 ? _c : (_d = data.location) === null || _d === void 0 ? void 0 : _d.lat;
    const lng = (_g = (_e = data.longitude) !== null && _e !== void 0 ? _e : (_f = data.location) === null || _f === void 0 ? void 0 : _f.longitude) !== null && _g !== void 0 ? _g : (_h = data.location) === null || _h === void 0 ? void 0 : _h.lng;
    return { lat, lng };
}
async function ensureCaregiverEmbedding(caregiverId, data) {
    const text = (0, embeddings_1.composeCaregiverText)(data);
    if (!text)
        return null;
    const hash = (0, embeddings_1.hashText)(text);
    if (data.embeddingInputHash === hash && Array.isArray(data.embedding)) {
        return data.embedding;
    }
    const result = await (0, embeddings_1.generateEmbedding)(text);
    if (!result)
        return null;
    await admin.firestore().collection("caregivers").doc(caregiverId).set({
        embedding: result.vector,
        embeddingInputHash: result.inputHash,
        embeddingUpdatedAt: firestore_1.FieldValue.serverTimestamp(),
    }, { merge: true });
    return result.vector;
}
async function ensureIntakeEmbedding(intakeId, data) {
    const text = (0, embeddings_1.composeIntakeText)(data);
    if (!text)
        return null;
    const hash = (0, embeddings_1.hashText)(text);
    if (data.embeddingInputHash === hash && Array.isArray(data.embedding)) {
        return data.embedding;
    }
    const result = await (0, embeddings_1.generateEmbedding)(text);
    if (!result)
        return null;
    await admin.firestore().collection("clientIntakes").doc(intakeId).set({
        embedding: result.vector,
        embeddingInputHash: result.inputHash,
        embeddingUpdatedAt: firestore_1.FieldValue.serverTimestamp(),
    }, { merge: true });
    return result.vector;
}
async function computeMatchesForIntake(intakeId, intakeData, intakeEmbedding) {
    var _a;
    const db = admin.firestore();
    const clientId = intakeData.userId || intakeId;
    const [caregiversSnap, feedback] = await Promise.all([
        db.collection("caregivers").limit(MAX_CAREGIVERS_PER_RUN).get(),
        (0, feedback_1.readClientFeedback)(clientId),
    ]);
    const clientNeeds = pickNeeds(intakeData);
    const clientLoc = pickLatLng(intakeData);
    // Preference signals from intake
    const clientGenderPref = intakeData.genderPreference;
    const clientLanguage = intakeData.languagePreference;
    const scored = [];
    for (const doc of caregiversSnap.docs) {
        const cg = doc.data();
        if (cg.isActive === false)
            continue;
        const caregiverLoc = pickLatLng(cg);
        const distance = (0, scoring_1.haversineMiles)(clientLoc.lat, clientLoc.lng, caregiverLoc.lat, caregiverLoc.lng);
        const overlap = (0, scoring_1.availabilityOverlap)(cg.weeklyAvailability, intakeData.schedule);
        scored.push((0, scoring_1.scoreCaregiver)({
            caregiverId: doc.id,
            caregiverEmbedding: cg.embedding,
            clientEmbedding: intakeEmbedding,
            caregiverSkills: pickSkills(cg),
            clientNeeds,
            distanceMiles: distance,
            availabilityOverlap: overlap,
            rating: cg.rating,
            yearsExperience: (_a = cg.yearsExperience) !== null && _a !== void 0 ? _a : cg.experience,
            personalBoost: (0, feedback_1.boostForCaregiver)(feedback, doc.id),
            clientGenderPref,
            caregiverGender: cg.gender,
            clientLanguage,
            caregiverLanguages: cg.languages,
        }));
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, TOP_N);
}
async function writeClientMatches(clientId, intakeId, matches) {
    const visibleMatches = matches.filter((m) => m.confidence === "high" || m.confidence === "medium");
    await admin
        .firestore()
        .collection("clientMatches")
        .doc(clientId)
        .set({
        clientId,
        intakeId,
        topMatches: visibleMatches,
        allMatches: matches,
        computedAt: firestore_1.FieldValue.serverTimestamp(),
        version: Date.now(),
    }, { merge: false });
}
async function runMatchingForIntake(intakeId, intakeData) {
    const clientId = intakeData.userId || intakeId;
    const embedding = await ensureIntakeEmbedding(intakeId, intakeData);
    const matches = await computeMatchesForIntake(intakeId, intakeData, embedding);
    await writeClientMatches(clientId, intakeId, matches);
    return { clientId, count: matches.length };
}
//# sourceMappingURL=matchJob.js.map