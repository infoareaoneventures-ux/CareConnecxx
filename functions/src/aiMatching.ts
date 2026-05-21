import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { scoreCaregiver, haversineMiles, availabilityOverlap } from "./ai/scoring";
import { ensureIntakeEmbedding, ensureCaregiverEmbedding } from "./ai/matchJob";
import { boostForCaregiver, readClientFeedback } from "./ai/feedback";
import {
  buildMatchingSystemPrompt,
  scoreWithClaude,
  computeSkillsCoverage,
  detectDementiaCert,
  detectMedicalCred,
  CandidateSignals,
} from "./ai/claudeMatching";
import { getOutcomePatternSummary } from "./ai/outcomeAnalytics";

/**
 * Cloud Function: Run AI Matching Algorithm
 *
 * Triggered when coordinator clicks "Run Matching" in admin dashboard.
 * 1. Computes objective signals for all verified caregivers (embeddings, distance, skills, availability).
 * 2. Pre-filters to top 25 candidates using the rule-based scorer.
 * 3. Sends all 25 to Claude Sonnet in ONE batch call for holistic ranking.
 * 4. Injects real platform hire/pass patterns so Claude scores from evidence, not just rules.
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
      ensureIntakeEmbedding(intakeId, intakeData),
      db.collection("caregivers").where("verified", "==", true).get(),
      readClientFeedback(clientId),
      getOutcomePatternSummary(db),
    ]);

    console.log(`[runAiMatching] Scoring ${caregiversSnap.size} caregivers, outcome patterns: ${outcomePatterns ? "loaded" : "none yet"}`);

    const clientGenderPref: string | undefined = intakeData.genderPreference;
    const clientLanguage:   string | undefined = intakeData.languagePreference;
    const seniorPersonality: string | undefined = intakeData.personality ?? intakeData.seniorPersonality;
    const clientLat = intakeData.latitude  ?? intakeData.location?.latitude  ?? intakeData.location?.lat;
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

    // Step 1: compute objective signals for all caregivers using rule-based scorer
    const scoredRaw = await Promise.all(
      caregiversSnap.docs.map(async doc => {
        const cg = doc.data();
        if (cg.isActive === false) return null;

        const cgEmbedding = await ensureCaregiverEmbedding(doc.id, cg);
        const cgLat = cg.latitude ?? cg.location?.latitude ?? cg.location?.lat;
        const cgLng = cg.longitude ?? cg.location?.longitude ?? cg.location?.lng;
        const distance = haversineMiles(clientLat, clientLng, cgLat, cgLng);
        const overlap = availabilityOverlap(cg.weeklyAvailability, intakeData.schedule);

        if (distance !== undefined && distance > 30) return null;

        const cgSkills = [
          ...(cg.skills ?? []),
          ...(cg.specializations ?? []),
          ...(cg.specialties ?? []),
          ...(cg.medicalSkills ?? []),
          ...(cg.certifications ?? []),
        ];

        const result = scoreCaregiver({
          caregiverId:         doc.id,
          caregiverEmbedding:  cgEmbedding,
          clientEmbedding:     intakeEmbedding,
          caregiverSkills:     cgSkills,
          clientNeeds,
          distanceMiles:       distance,
          availabilityOverlap: overlap,
          rating:              cg.rating,
          yearsExperience:     cg.yearsExperience ?? cg.experience,
          personalBoost:       boostForCaregiver(feedback, doc.id),
          clientGenderPref,
          caregiverGender:     cg.gender,
          clientLanguage,
          caregiverLanguages:  cg.languages,
        });

        const personalBoost = boostForCaregiver(feedback, doc.id);

        const signals: CandidateSignals = {
          caregiverId:          doc.id,
          name:                 cg.name ?? `${cg.firstName ?? ""} ${cg.lastName ?? ""}`.trim(),
          distanceMiles:        distance !== undefined ? Math.round(distance * 10) / 10 : undefined,
          skillsCoveragePercent: computeSkillsCoverage(cgSkills, clientNeeds),
          scheduleOverlapPercent: overlap !== undefined ? Math.round(overlap * 100) : undefined,
          rating:               cg.rating,
          reviewCount:          cg.reviewCount,
          yearsExperience:      cg.yearsExperience ?? cg.experience,
          isVerified:           !!cg.verified,
          certifications:       [...(cg.certifications ?? []), ...(cg.medicalSkills ?? [])],
          languages:            cg.languages,
          personalityTags:      cg.personalityTags,
          hourlyRate:           cg.hourlyRate,
          reliabilityScore:     cg.reliabilityScore,
          retentionRate:        cg.retentionRate,
          hasDementiaCert:      detectDementiaCert(cgSkills),
          hasMedicalCred:       detectMedicalCred(cgSkills),
          feedbackSummary:      personalBoost > 2
            ? "previously hired by this family"
            : personalBoost < -1
            ? "previously rejected by this family"
            : "no prior history with this family",
          ruleScore: result.score,
        };

        return {
          signals,
          caregiverPhoto: cg.profilePhoto ?? cg.photoURL ?? null,
          ruleResult: result,
        };
      })
    );

    // Step 2: pre-filter and take top 25 by rule score
    const candidates = (scoredRaw.filter(Boolean) as NonNullable<typeof scoredRaw[0]>[])
      .filter(m => m.signals.ruleScore! > 30)
      .sort((a, b) => (b.signals.ruleScore ?? 0) - (a.signals.ruleScore ?? 0))
      .slice(0, 25);

    // Step 3: Claude Sonnet scores all candidates holistically
    const systemPrompt = buildMatchingSystemPrompt(outcomePatterns);
    let claudeScores: Map<string, Awaited<ReturnType<typeof scoreWithClaude>> extends Map<string, infer V> ? V : never>;

    try {
      claudeScores = await scoreWithClaude(
        candidates.map(c => c.signals),
        {
          needs:           clientNeeds,
          personality:     seniorPersonality,
          genderPreference: clientGenderPref,
          languagePreference: clientLanguage,
        },
        systemPrompt
      ) as any;
    } catch (err) {
      console.error("[runAiMatching] Claude scoring failed, falling back to rule-based:", err);
      // Fallback: use rule-based scores
      claudeScores = new Map(candidates.map(c => [c.signals.caregiverId, {
        caregiverId:  c.signals.caregiverId,
        overallScore: c.signals.ruleScore ?? 50,
        confidence:   (c.signals.ruleScore ?? 0) >= 75 ? "high" as const :
                      (c.signals.ruleScore ?? 0) >= 55 ? "medium" as const : "low" as const,
        reasoning:    c.ruleResult.reasons,
        redFlags:     c.ruleResult.redFlags,
        factors:      {
          skillsMatch:    Math.round((c.signals.skillsCoveragePercent ?? 50)),
          availability:   Math.round((c.signals.scheduleOverlapPercent ?? 50)),
          distance:       Math.round(c.ruleResult.distanceScore),
          experience:     Math.round(c.ruleResult.experienceScore * 10),
          personalityFit: 50,
          languageMatch:  50,
        },
      }])) as any;
    }

    // Step 4: merge, filter, rank
    const validMatches = candidates
      .map(c => {
        const claude = (claudeScores as Map<string, any>).get(c.signals.caregiverId);
        if (!claude || claude.overallScore <= 50) return null;
        return {
          caregiverId:    c.signals.caregiverId,
          caregiverName:  c.signals.name,
          caregiverPhoto: c.caregiverPhoto,
          matchScore:     claude.overallScore,
          confidence:     claude.confidence,
          reasoning:      claude.reasoning,
          redFlags:       claude.redFlags,
          scoreBreakdown: {
            semantic:     c.ruleResult.semanticScore,
            hardSkills:   c.ruleResult.hardSkillsScore,
            distance:     c.ruleResult.distanceScore,
            availability: c.ruleResult.availabilityScore,
            rating:       c.ruleResult.ratingScore,
            experience:   c.ruleResult.experienceScore,
          },
          predictiveFactors: {
            successProbability:    claude.overallScore,
            acceptanceLikelihood:  estimateAcceptanceLikelihood(c.signals, claude.overallScore),
            retentionProbability:  estimateRetentionProbability(c.signals, claude.overallScore),
          },
          distanceMiles:      c.signals.distanceMiles ?? null,
          availabilityOverlap: c.signals.scheduleOverlapPercent ?? null,
          source: "claude-sonnet",
        };
      })
      .filter(Boolean)
      .sort((a, b) => b!.matchScore - a!.matchScore)
      .slice(0, 10)
      .map((m, index) => ({ ...m!, ranking: index + 1 }));

    await db.collection("match_assignments").doc(matchAssignmentId).update({
      aiSuggestedMatches:  validMatches,
      status:              "matches_ready",
      matchingRunAt:       admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      success:      true,
      matches:      validMatches,
      totalScored:  caregiversSnap.size,
      matchesFound: validMatches.length,
    };
  } catch (error) {
    console.error("[runAiMatching] Error:", error);
    throw new functions.https.HttpsError("internal", "Failed to run matching algorithm");
  }
});

function estimateAcceptanceLikelihood(signals: CandidateSignals, matchScore: number): number {
  let likelihood = 55;
  if ((signals.rating ?? 0) >= 4.8) likelihood -= 8;
  if ((signals.rating ?? 0) <= 4.0) likelihood += 12;
  if ((signals.yearsExperience ?? 0) >= 5) likelihood -= 5;
  if (matchScore >= 85) likelihood += 25;
  else if (matchScore >= 70) likelihood += 15;
  else if (matchScore >= 60) likelihood += 5;
  return Math.min(Math.max(likelihood, 20), 95);
}

function estimateRetentionProbability(signals: CandidateSignals, matchScore: number): number {
  let probability = 70;
  const exp = signals.yearsExperience ?? 0;
  if (exp >= 5) probability += 10;
  else if (exp >= 3) probability += 5;
  if (matchScore >= 85) probability += 15;
  else if (matchScore >= 70) probability += 10;
  if ((signals.rating ?? 0) >= 4.8) probability += 5;
  return Math.min(Math.max(probability, 50), 98);
}
