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
const functions = __importStar(require("firebase-functions/v1"));
const admin = __importStar(require("firebase-admin"));
const scoring_1 = require("./ai/scoring");
const matchJob_1 = require("./ai/matchJob");
const feedback_1 = require("./ai/feedback");
const claudeMatching_1 = require("./ai/claudeMatching");
const outcomeAnalytics_1 = require("./ai/outcomeAnalytics");
/**
 * Cloud Function: Run AI Matching Algorithm
 *
 * Triggered when coordinator clicks "Run Matching" in admin dashboard.
 * 1. Computes objective signals for all verified caregivers (embeddings, distance, skills, availability).
 * 2. Pre-filters to top 25 candidates using the rule-based scorer.
 * 3. Sends all 25 to Claude Sonnet in ONE batch call for holistic ranking.
 * 4. Injects real platform hire/pass patterns so Claude scores from evidence, not just rules.
 */
exports.runAiMatching = functions.https.onCall(async (data, context) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
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
        const intakeSnap = await db
            .collection("clientIntakes")
            .where("userId", "==", clientId)
            .orderBy("createdAt", "desc")
            .limit(1)
            .get();
        const intakeDoc = intakeSnap.empty ? null : intakeSnap.docs[0];
        const intakeData = intakeDoc ? intakeDoc.data() : assignment;
        const intakeId = intakeDoc ? intakeDoc.id : matchAssignmentId;
        // Load embeddings, caregivers, feedback, and outcome patterns in parallel
        const [intakeEmbedding, caregiversSnap, feedback, outcomePatterns] = await Promise.all([
            (0, matchJob_1.ensureIntakeEmbedding)(intakeId, intakeData),
            db.collection("caregivers").where("verified", "==", true).get(),
            (0, feedback_1.readClientFeedback)(clientId),
            (0, outcomeAnalytics_1.getOutcomePatternSummary)(db),
        ]);
        console.log(`[runAiMatching] Scoring ${caregiversSnap.size} caregivers, outcome patterns: ${outcomePatterns ? "loaded" : "none yet"}`);
        const clientGenderPref = intakeData.genderPreference;
        const clientLanguage = intakeData.languagePreference;
        const seniorPersonality = (_a = intakeData.personality) !== null && _a !== void 0 ? _a : intakeData.seniorPersonality;
        const clientLat = (_d = (_b = intakeData.latitude) !== null && _b !== void 0 ? _b : (_c = intakeData.location) === null || _c === void 0 ? void 0 : _c.latitude) !== null && _d !== void 0 ? _d : (_e = intakeData.location) === null || _e === void 0 ? void 0 : _e.lat;
        const clientLng = (_h = (_f = intakeData.longitude) !== null && _f !== void 0 ? _f : (_g = intakeData.location) === null || _g === void 0 ? void 0 : _g.longitude) !== null && _h !== void 0 ? _h : (_j = intakeData.location) === null || _j === void 0 ? void 0 : _j.lng;
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
        // Step 1: compute objective signals for all caregivers using rule-based scorer
        const scoredRaw = await Promise.all(caregiversSnap.docs.map(async (doc) => {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x;
            const cg = doc.data();
            if (cg.isActive === false)
                return null;
            const cgEmbedding = await (0, matchJob_1.ensureCaregiverEmbedding)(doc.id, cg);
            const cgLat = (_c = (_a = cg.latitude) !== null && _a !== void 0 ? _a : (_b = cg.location) === null || _b === void 0 ? void 0 : _b.latitude) !== null && _c !== void 0 ? _c : (_d = cg.location) === null || _d === void 0 ? void 0 : _d.lat;
            const cgLng = (_g = (_e = cg.longitude) !== null && _e !== void 0 ? _e : (_f = cg.location) === null || _f === void 0 ? void 0 : _f.longitude) !== null && _g !== void 0 ? _g : (_h = cg.location) === null || _h === void 0 ? void 0 : _h.lng;
            const distance = (0, scoring_1.haversineMiles)(clientLat, clientLng, cgLat, cgLng);
            const overlap = (0, scoring_1.availabilityOverlap)(cg.weeklyAvailability, intakeData.schedule);
            if (distance !== undefined && distance > 30)
                return null;
            const cgSkills = [
                ...((_j = cg.skills) !== null && _j !== void 0 ? _j : []),
                ...((_k = cg.specializations) !== null && _k !== void 0 ? _k : []),
                ...((_l = cg.specialties) !== null && _l !== void 0 ? _l : []),
                ...((_m = cg.medicalSkills) !== null && _m !== void 0 ? _m : []),
                ...((_o = cg.certifications) !== null && _o !== void 0 ? _o : []),
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
                yearsExperience: (_p = cg.yearsExperience) !== null && _p !== void 0 ? _p : cg.experience,
                personalBoost: (0, feedback_1.boostForCaregiver)(feedback, doc.id),
                clientGenderPref,
                caregiverGender: cg.gender,
                clientLanguage,
                caregiverLanguages: cg.languages,
            });
            const personalBoost = (0, feedback_1.boostForCaregiver)(feedback, doc.id);
            const signals = {
                caregiverId: doc.id,
                name: (_q = cg.name) !== null && _q !== void 0 ? _q : `${(_r = cg.firstName) !== null && _r !== void 0 ? _r : ""} ${(_s = cg.lastName) !== null && _s !== void 0 ? _s : ""}`.trim(),
                distanceMiles: distance !== undefined ? Math.round(distance * 10) / 10 : undefined,
                skillsCoveragePercent: (0, claudeMatching_1.computeSkillsCoverage)(cgSkills, clientNeeds),
                scheduleOverlapPercent: overlap !== undefined ? Math.round(overlap * 100) : undefined,
                rating: cg.rating,
                reviewCount: cg.reviewCount,
                yearsExperience: (_t = cg.yearsExperience) !== null && _t !== void 0 ? _t : cg.experience,
                isVerified: !!cg.verified,
                certifications: [...((_u = cg.certifications) !== null && _u !== void 0 ? _u : []), ...((_v = cg.medicalSkills) !== null && _v !== void 0 ? _v : [])],
                languages: cg.languages,
                personalityTags: cg.personalityTags,
                hourlyRate: cg.hourlyRate,
                reliabilityScore: cg.reliabilityScore,
                retentionRate: cg.retentionRate,
                feedbackSummary: personalBoost > 2
                    ? "previously hired by this family"
                    : personalBoost < -1
                        ? "previously rejected by this family"
                        : "no prior history with this family",
                ruleScore: result.score,
            };
            return {
                signals,
                caregiverPhoto: (_x = (_w = cg.profilePhoto) !== null && _w !== void 0 ? _w : cg.photoURL) !== null && _x !== void 0 ? _x : null,
                ruleResult: result,
            };
        }));
        // Step 2: pre-filter and take top 25 by rule score
        const candidates = scoredRaw.filter(Boolean)
            .filter(m => m.signals.ruleScore > 30)
            .sort((a, b) => { var _a, _b; return ((_a = b.signals.ruleScore) !== null && _a !== void 0 ? _a : 0) - ((_b = a.signals.ruleScore) !== null && _b !== void 0 ? _b : 0); })
            .slice(0, 25);
        // Step 3: Claude Sonnet scores all candidates holistically
        const systemPrompt = (0, claudeMatching_1.buildMatchingSystemPrompt)(outcomePatterns);
        let claudeScores;
        try {
            claudeScores = await (0, claudeMatching_1.scoreWithClaude)(candidates.map(c => c.signals), {
                needs: clientNeeds,
                personality: seniorPersonality,
                genderPreference: clientGenderPref,
                languagePreference: clientLanguage,
            }, systemPrompt);
        }
        catch (err) {
            console.error("[runAiMatching] Claude scoring failed, falling back to rule-based:", err);
            // Fallback: use rule-based scores
            claudeScores = new Map(candidates.map(c => {
                var _a, _b, _c, _d, _e;
                return [c.signals.caregiverId, {
                        caregiverId: c.signals.caregiverId,
                        overallScore: (_a = c.signals.ruleScore) !== null && _a !== void 0 ? _a : 50,
                        confidence: ((_b = c.signals.ruleScore) !== null && _b !== void 0 ? _b : 0) >= 75 ? "high" :
                            ((_c = c.signals.ruleScore) !== null && _c !== void 0 ? _c : 0) >= 55 ? "medium" : "low",
                        reasoning: c.ruleResult.reasons,
                        redFlags: c.ruleResult.redFlags,
                        factors: {
                            skillsMatch: Math.round(((_d = c.signals.skillsCoveragePercent) !== null && _d !== void 0 ? _d : 50)),
                            availability: Math.round(((_e = c.signals.scheduleOverlapPercent) !== null && _e !== void 0 ? _e : 50)),
                            distance: Math.round(c.ruleResult.distanceScore),
                            experience: Math.round(c.ruleResult.experienceScore * 10),
                            personalityFit: 50,
                            languageMatch: 50,
                        },
                    }];
            }));
        }
        // Step 4: merge, filter, rank
        const validMatches = candidates
            .map(c => {
            var _a, _b;
            const claude = claudeScores.get(c.signals.caregiverId);
            if (!claude || claude.overallScore <= 50)
                return null;
            return {
                caregiverId: c.signals.caregiverId,
                caregiverName: c.signals.name,
                caregiverPhoto: c.caregiverPhoto,
                matchScore: claude.overallScore,
                confidence: claude.confidence,
                reasoning: claude.reasoning,
                redFlags: claude.redFlags,
                scoreBreakdown: {
                    semantic: c.ruleResult.semanticScore,
                    hardSkills: c.ruleResult.hardSkillsScore,
                    distance: c.ruleResult.distanceScore,
                    availability: c.ruleResult.availabilityScore,
                    rating: c.ruleResult.ratingScore,
                    experience: c.ruleResult.experienceScore,
                },
                predictiveFactors: {
                    successProbability: claude.overallScore,
                    acceptanceLikelihood: estimateAcceptanceLikelihood(c.signals, claude.overallScore),
                    retentionProbability: estimateRetentionProbability(c.signals, claude.overallScore),
                },
                distanceMiles: (_a = c.signals.distanceMiles) !== null && _a !== void 0 ? _a : null,
                availabilityOverlap: (_b = c.signals.scheduleOverlapPercent) !== null && _b !== void 0 ? _b : null,
                source: "claude-sonnet",
            };
        })
            .filter(Boolean)
            .sort((a, b) => b.matchScore - a.matchScore)
            .slice(0, 10)
            .map((m, index) => (Object.assign(Object.assign({}, m), { ranking: index + 1 })));
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
function estimateAcceptanceLikelihood(signals, matchScore) {
    var _a, _b, _c;
    let likelihood = 55;
    if (((_a = signals.rating) !== null && _a !== void 0 ? _a : 0) >= 4.8)
        likelihood -= 8;
    if (((_b = signals.rating) !== null && _b !== void 0 ? _b : 0) <= 4.0)
        likelihood += 12;
    if (((_c = signals.yearsExperience) !== null && _c !== void 0 ? _c : 0) >= 5)
        likelihood -= 5;
    if (matchScore >= 85)
        likelihood += 25;
    else if (matchScore >= 70)
        likelihood += 15;
    else if (matchScore >= 60)
        likelihood += 5;
    return Math.min(Math.max(likelihood, 20), 95);
}
function estimateRetentionProbability(signals, matchScore) {
    var _a, _b;
    let probability = 70;
    const exp = (_a = signals.yearsExperience) !== null && _a !== void 0 ? _a : 0;
    if (exp >= 5)
        probability += 10;
    else if (exp >= 3)
        probability += 5;
    if (matchScore >= 85)
        probability += 15;
    else if (matchScore >= 70)
        probability += 10;
    if (((_b = signals.rating) !== null && _b !== void 0 ? _b : 0) >= 4.8)
        probability += 5;
    return Math.min(Math.max(probability, 50), 98);
}
//# sourceMappingURL=aiMatching.js.map