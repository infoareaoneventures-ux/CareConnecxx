import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { scoreCaregiver, haversineMiles, availabilityOverlap } from "./ai/scoring";
import { ensureIntakeEmbedding, ensureCaregiverEmbedding } from "./ai/matchJob";
import { boostForCaregiver, readClientFeedback } from "./ai/feedback";

/**
 * Cloud Function: Run AI Matching Algorithm
 *
 * Triggered when coordinator clicks "Run Matching" in admin dashboard.
 * Uses the same unified scoring algorithm as the automatic intake trigger,
 * so coordinators and clients always see consistent scores.
 * Returns top 10 matches with full score breakdowns and red flags.
 */
export const runAiMatching = functions.https.onCall(async (data, context) => {
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
        const assignment = assignmentDoc.data()!;
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
        const intakeEmbedding = await ensureIntakeEmbedding(intakeId, intakeData);

        // Load verified caregivers and client feedback in parallel
        const [caregiversSnap, feedback] = await Promise.all([
            db.collection("caregivers").where("verified", "==", true).get(),
            readClientFeedback(clientId),
        ]);

        console.log(`[runAiMatching] Scoring ${caregiversSnap.size} caregivers for assignment ${matchAssignmentId}`);

        // Pull preference signals from intake
        const clientGenderPref = intakeData.genderPreference;
        const clientLanguage = intakeData.languagePreference;
        const clientLat = intakeData.latitude ?? intakeData.location?.latitude ?? intakeData.location?.lat;
        const clientLng = intakeData.longitude ?? intakeData.location?.longitude ?? intakeData.location?.lng;

        const clientNeeds: string[] = (() => {
            if (Array.isArray(intakeData.careTypes) && intakeData.careTypes.length) return intakeData.careTypes;
            if (intakeData.tasks && typeof intakeData.tasks === "object") {
                return Object.keys(intakeData.tasks).filter(
                    k => Array.isArray(intakeData.tasks[k]) && intakeData.tasks[k].length > 0
                );
            }
            if (Array.isArray(assignment.careNeeds)) {
                return assignment.careNeeds.map((n: any) => n.category || n.description || String(n));
            }
            return [];
        })();

        // Score every verified caregiver
        const scoredRaw = await Promise.all(
            caregiversSnap.docs.map(async doc => {
                const cg = doc.data();
                if (cg.isActive === false) return null;

                // Ensure caregiver embedding is up to date
                const cgEmbedding = await ensureCaregiverEmbedding(doc.id, cg);

                const cgLat = cg.latitude ?? cg.location?.latitude ?? cg.location?.lat;
                const cgLng = cg.longitude ?? cg.location?.longitude ?? cg.location?.lng;
                const distance = haversineMiles(clientLat, clientLng, cgLat, cgLng);

                const overlap = availabilityOverlap(cg.weeklyAvailability, intakeData.schedule);

                const cgSkills = [
                    ...(cg.skills || []),
                    ...(cg.specializations || []),
                    ...(cg.specialties || []),
                    ...(cg.medicalSkills || []),
                ];

                const result = scoreCaregiver({
                    caregiverId: doc.id,
                    caregiverEmbedding: cgEmbedding,
                    clientEmbedding: intakeEmbedding,
                    caregiverSkills: cgSkills,
                    clientNeeds,
                    distanceMiles: distance,
                    availabilityOverlap: overlap,
                    rating: cg.rating,
                    yearsExperience: cg.yearsExperience ?? cg.experience,
                    personalBoost: boostForCaregiver(feedback, doc.id),
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
            })
        );

        const validMatches = (scoredRaw.filter(Boolean) as NonNullable<typeof scoredRaw[0]>[])
            .filter(m => m.matchScore > 50)
            .sort((a, b) => b.matchScore - a.matchScore)
            .slice(0, 10)
            .map((m, index) => ({ ...m, ranking: index + 1 }));

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
    } catch (error) {
        console.error("[runAiMatching] Error:", error);
        throw new functions.https.HttpsError("internal", "Failed to run matching algorithm");
    }
});

function estimateAcceptanceLikelihood(caregiver: any, matchScore: number): number {
    let likelihood = 55;
    if (caregiver.rating >= 4.8) likelihood -= 8;
    if (caregiver.rating <= 4.0) likelihood += 12;
    if ((caregiver.yearsExperience || 0) >= 5) likelihood -= 5;
    if (matchScore >= 85) likelihood += 25;
    else if (matchScore >= 70) likelihood += 15;
    else if (matchScore >= 60) likelihood += 5;
    return Math.min(Math.max(likelihood, 20), 95);
}

function estimateRetentionProbability(caregiver: any, matchScore: number): number {
    let probability = 70;
    const exp = caregiver.yearsExperience || 0;
    if (exp >= 5) probability += 10;
    else if (exp >= 3) probability += 5;
    if (matchScore >= 85) probability += 15;
    else if (matchScore >= 70) probability += 10;
    if (caregiver.rating >= 4.8) probability += 5;
    return Math.min(Math.max(probability, 50), 98);
}
