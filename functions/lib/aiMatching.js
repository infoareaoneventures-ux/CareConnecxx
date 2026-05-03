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
exports.runAiMatching = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const scoring_1 = require("./ai/scoring");
const matchJob_1 = require("./ai/matchJob");
const feedback_1 = require("./ai/feedback");
/**
 * Cloud Function: Run AI Matching Algorithm
 *
 * Triggered when coordinator clicks "Run Matching" in admin dashboard.
 * Uses the same unified scoring algorithm as the automatic intake trigger,
 * so coordinators and clients always see consistent scores.
 * Returns top 10 matches with full score breakdowns and red flags.
 */
exports.runAiMatching = functions.https.onCall(async (data, context) => {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "User must be authenticated");
    }
    const { matchAssignmentId } = data;
    if (!matchAssignmentId) {
        throw new functions.https.HttpsError("invalid-argument", "matchAssignmentId is required");
    }
    try {
        const db = admin.firestore();
        // Load assignment + linked intake
        const assignmentDoc = await db.collection("match_assignments").doc(matchAssignmentId).get();
        if (!assignmentDoc.exists) {
            throw new functions.https.HttpsError("not-found", "Match assignment not found");
        }
        const assignment = assignmentDoc.data();
        const clientId = assignment.clientId;
        // Load the client's intake (newest one)
        const intakeSnap = await db
            .collection("clientIntakes")
            .where("userId", "==", clientId)
            .orderBy("createdAt", "desc")
            .limit(1)
            .get();
        const intakeDoc = intakeSnap.empty ? null : intakeSnap.docs[0];
        const intakeData = intakeDoc ? intakeDoc.data() : assignment; // fall back to assignment fields
        const intakeId = intakeDoc ? intakeDoc.id : matchAssignmentId;
        // Ensure intake has an up-to-date embedding
        const intakeEmbedding = await (0, matchJob_1.ensureIntakeEmbedding)(intakeId, intakeData);
        // Load verified caregivers and client feedback in parallel
        const [caregiversSnap, feedback] = await Promise.all([
            db.collection("caregivers").where("verified", "==", true).get(),
            (0, feedback_1.readClientFeedback)(clientId),
        ]);
        console.log(`[runAiMatching] Scoring ${caregiversSnap.size} caregivers for assignment ${matchAssignmentId}`);
        // Pull preference signals from intake
        const clientGenderPref = intakeData.genderPreference;
        const clientLanguage = intakeData.languagePreference;
        const clientLat = (_c = (_a = intakeData.latitude) !== null && _a !== void 0 ? _a : (_b = intakeData.location) === null || _b === void 0 ? void 0 : _b.latitude) !== null && _c !== void 0 ? _c : (_d = intakeData.location) === null || _d === void 0 ? void 0 : _d.lat;
        const clientLng = (_g = (_e = intakeData.longitude) !== null && _e !== void 0 ? _e : (_f = intakeData.location) === null || _f === void 0 ? void 0 : _f.longitude) !== null && _g !== void 0 ? _g : (_h = intakeData.location) === null || _h === void 0 ? void 0 : _h.lng;
        const clientNeeds = (() => {
            if (Array.isArray(intakeData.careTypes) && intakeData.careTypes.length)
                return intakeData.careTypes;
            if (intakeData.tasks && typeof intakeData.tasks === "object") {
                return Object.keys(intakeData.tasks).filter(k => Array.isArray(intakeData.tasks[k]) && intakeData.tasks[k].length > 0);
            }
            if (Array.isArray(assignment.careNeeds)) {
                return assignment.careNeeds.map((n) => n.category || n.description || String(n));
            }
            return [];
        })();
        // Score every verified caregiver
        const scoredRaw = await Promise.all(caregiversSnap.docs.map(async (doc) => {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j;
            const cg = doc.data();
            if (cg.isActive === false)
                return null;
            // Ensure caregiver embedding is up to date
            const cgEmbedding = await (0, matchJob_1.ensureCaregiverEmbedding)(doc.id, cg);
            const cgLat = (_c = (_a = cg.latitude) !== null && _a !== void 0 ? _a : (_b = cg.location) === null || _b === void 0 ? void 0 : _b.latitude) !== null && _c !== void 0 ? _c : (_d = cg.location) === null || _d === void 0 ? void 0 : _d.lat;
            const cgLng = (_g = (_e = cg.longitude) !== null && _e !== void 0 ? _e : (_f = cg.location) === null || _f === void 0 ? void 0 : _f.longitude) !== null && _g !== void 0 ? _g : (_h = cg.location) === null || _h === void 0 ? void 0 : _h.lng;
            const distance = (0, scoring_1.haversineMiles)(clientLat, clientLng, cgLat, cgLng);
            const overlap = (0, scoring_1.availabilityOverlap)(cg.weeklyAvailability, intakeData.schedule);
            const cgSkills = [
                ...(cg.skills || []),
                ...(cg.specializations || []),
                ...(cg.specialties || []),
                ...(cg.medicalSkills || []),
            ];
            const result = (0, scoring_1.scoreCaregiver)({
                caregiverId: doc.id,
                caregiverEmbedding: cgEmbedding,
                clientEmbedding: intakeEmbedding,
                caregiverSkills: cgSkills,
                clientNeeds,
                distanceMiles: distance,
                availabilityOverlap: overlap,
                rating: cg.rating,
                yearsExperience: (_j = cg.yearsExperience) !== null && _j !== void 0 ? _j : cg.experience,
                personalBoost: (0, feedback_1.boostForCaregiver)(feedback, doc.id),
                clientGenderPref,
                caregiverGender: cg.gender,
                clientLanguage,
                caregiverLanguages: cg.languages,
            });
            return {
                caregiverId: doc.id,
                caregiverName: cg.name || `${cg.firstName || ""} ${cg.lastName || ""}`.trim(),
                caregiverPhoto: cg.profilePhoto || cg.photoURL || null,
                matchScore: result.score,
                confidence: result.confidence,
                reasoning: result.reasons,
                redFlags: result.redFlags,
                scoreBreakdown: {
                    semantic: result.semanticScore,
                    hardSkills: result.hardSkillsScore,
                    distance: result.distanceScore,
                    availability: result.availabilityScore,
                    rating: result.ratingScore,
                    experience: result.experienceScore,
                },
                predictiveFactors: {
                    successProbability: result.score,
                    acceptanceLikelihood: estimateAcceptanceLikelihood(cg, result.score),
                    retentionProbability: estimateRetentionProbability(cg, result.score),
                },
                distanceMiles: distance !== undefined ? Math.round(distance * 10) / 10 : null,
                availabilityOverlap: overlap !== undefined ? Math.round(overlap * 100) : null,
                source: result.source,
            };
        }));
        const validMatches = scoredRaw.filter(Boolean)
            .filter(m => m.matchScore > 50)
            .sort((a, b) => b.matchScore - a.matchScore)
            .slice(0, 10)
            .map((m, index) => (Object.assign(Object.assign({}, m), { ranking: index + 1 })));
        // Persist AI suggestions back to the assignment
        await db.collection("match_assignments").doc(matchAssignmentId).update({
            aiSuggestedMatches: validMatches,
            status: "matches_ready",
            matchingRunAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return {
            success: true,
            matches: validMatches,
            totalScored: caregiversSnap.size,
            matchesFound: validMatches.length,
        };
    }
    catch (error) {
        console.error("[runAiMatching] Error:", error);
        throw new functions.https.HttpsError("internal", "Failed to run matching algorithm");
    }
});
function estimateAcceptanceLikelihood(caregiver, matchScore) {
    let likelihood = 55;
    if (caregiver.rating >= 4.8)
        likelihood -= 8;
    if (caregiver.rating <= 4.0)
        likelihood += 12;
    if ((caregiver.yearsExperience || 0) >= 5)
        likelihood -= 5;
    if (matchScore >= 85)
        likelihood += 25;
    else if (matchScore >= 70)
        likelihood += 15;
    else if (matchScore >= 60)
        likelihood += 5;
    return Math.min(Math.max(likelihood, 20), 95);
}
function estimateRetentionProbability(caregiver, matchScore) {
    let probability = 70;
    const exp = caregiver.yearsExperience || 0;
    if (exp >= 5)
        probability += 10;
    else if (exp >= 3)
        probability += 5;
    if (matchScore >= 85)
        probability += 15;
    else if (matchScore >= 70)
        probability += 10;
    if (caregiver.rating >= 4.8)
        probability += 5;
    return Math.min(Math.max(probability, 50), 98);
}
//# sourceMappingURL=aiMatching.js.map