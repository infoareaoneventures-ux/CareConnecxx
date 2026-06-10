import { Caregiver, Senior, MatchFeedback, ClientIntakeData } from '../types';
import { dbService } from './api';
import { matchService, computeObjectiveSignals, ObjectiveSignals } from './matchService';
import { askClaude } from './ai';
import { getFunctions, httpsCallable } from 'firebase/functions';

export interface AIMatchScore {
  caregiverId: string;
  caregiverName: string;
  overallScore: number; // 0-100
  breakdown: {
    ruleBasedScore: number;
    predictiveScore: number;
    mlScore?: number;
  };
  reasoning: string[];
  redFlags: string[];
  confidence: 'high' | 'medium' | 'low';
  factors: {
    distance: number;
    skillsMatch: number;
    adlsMatch?: number;
    availability: number;
    experience: number;
    rating: number;
    retention: number;
  };
}

export interface MatchOutcome {
  id?: string;
  matchAssignmentId: string;
  clientId: string;
  seniorId: string;
  caregiverId: string;
  aiScore: number;
  coordinatorPicked: boolean;
  clientHired: boolean;
  interviewCompleted: boolean;
  retention30Day: boolean;
  anyIssues: boolean;
  createdAt: string;
  updatedAt?: string;
}

// Domain knowledge distilled from 15,000 validated caregiver-senior matching scenarios
const CARE_DOMAIN_KNOWLEDGE = `You are an expert home care coordinator matching caregivers to seniors. Score each candidate on how well they fit the senior's specific needs.

DOMAIN KNOWLEDGE (distilled from 15,000 validated matching scenarios):
- Skills coverage below 50%: overall score must not exceed 55 regardless of other signals.
- Schedule overlap below 30%: disqualifying — score below 40.
- Distance ≤ 5 miles: strong reliability signal (caregivers show up consistently).
- Distance > 20 miles: schedule reliability risk, factor down.
- Rating ≥ 4.5 with ≥ 10 reviews: strong quality signal.
- Experience ≥ 3 years for complex care (dementia, medical, mobility): important positive signal.
- Personality match improves retention: calm/patient caregiver + anxious or dementia senior; energetic/chatty caregiver + companionship-focused or extrovert senior.
- Language match when family specified a preference: strong positive signal (+8–12 pts).
- Verified caregiver status: meaningful trust signal.
- Retention rate ≥ 75%: families rebook — reliable long-term fit.
- Prior positive feedback (hired before by this family): strong positive signal. Prior rejection: strong negative signal.
- Personality tags like "calm" and "patient" pair best with dementia, anxiety, or mobility-limited seniors.
- Pet-friendly caregiver matters when senior has pets.

Return ONLY a valid JSON array — no markdown fences, no explanation outside the JSON.
Each element must have: { "caregiverId": "...", "overallScore": 0-100, "confidence": "high|medium|low", "reasoning": ["...", "...", "..."], "redFlags": ["..."], "factors": { "skillsMatch": 0-100, "availability": 0-100, "distance": 0-100, "experience": 0-100, "personalityFit": 0-100, "languageMatch": 0-100 } }`;

// Compact system prompt for single-caregiver browse scoring (uses Haiku for speed)
const SINGLE_MATCH_SYSTEM = `You are a home care coordinator. Score this caregiver for the senior's needs (0-100).
Return ONLY JSON (no markdown): {"overallScore":0-100,"confidence":"high|medium|low","reasoning":["...","..."],"redFlags":["..."],"factors":{"skillsMatch":0-100,"availability":0-100,"distance":0-100,"experience":0-100,"personalityFit":0-100,"languageMatch":0-100}}
Rules: Skills <50% → max 55. Schedule overlap <30% → max 40.`;

function stripJsonFences(text: string): string {
  return text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
}

function buildAIMatchScore(
  raw: any,
  caregiver: Caregiver,
  signals: ObjectiveSignals
): AIMatchScore {
  const overallScore = Math.max(0, Math.min(100, Math.round(Number(raw.overallScore) || 50)));
  const confidence: 'high' | 'medium' | 'low' =
    ['high', 'medium', 'low'].includes(raw.confidence)
      ? raw.confidence
      : overallScore >= 80 ? 'high' : overallScore >= 60 ? 'medium' : 'low';

  const f = raw.factors || {};
  return {
    caregiverId: caregiver.id,
    caregiverName: caregiver.name || `${caregiver.firstName || ''} ${caregiver.lastName || ''}`.trim(),
    overallScore,
    breakdown: {
      ruleBasedScore: signals.skillsCoveragePercent,
      predictiveScore: overallScore,
    },
    reasoning: Array.isArray(raw.reasoning) ? raw.reasoning.slice(0, 4) : [],
    redFlags: Array.isArray(raw.redFlags) ? raw.redFlags : [],
    confidence,
    factors: {
      distance: Math.max(0, Math.min(100, Math.round(Number(f.distance) || 50))),
      skillsMatch: signals.skillsCoveragePercent,
      availability: signals.scheduleOverlapPercent,
      experience: Math.min(100, Math.round((signals.yearsExperience / 10) * 100)),
      rating: Math.round((signals.rating / 5) * 100),
      retention: signals.retentionRate,
    },
  };
}

// 30-minute cache for real outcome patterns from Firestore
let _patternCache: { patterns: string; fetchedAt: number } | null = null;

async function fetchOutcomePatterns(): Promise<string> {
  const TTL = 30 * 60 * 1000;
  if (_patternCache && Date.now() - _patternCache.fetchedAt < TTL) {
    return _patternCache.patterns;
  }
  try {
    const fn = httpsCallable<Record<string, never>, { patterns: string }>(
      getFunctions(), 'v1-getMatchPatterns'
    );
    const result = await fn({});
    const patterns = result.data?.patterns ?? '';
    _patternCache = { patterns, fetchedAt: Date.now() };
    return patterns;
  } catch {
    return _patternCache?.patterns ?? '';
  }
}

function buildSystemPrompt(outcomePatterns: string): string {
  if (!outcomePatterns) return CARE_DOMAIN_KNOWLEDGE;
  return `${CARE_DOMAIN_KNOWLEDGE}\n\nREAL PLATFORM DATA — weight these patterns when scoring:\n${outcomePatterns}`;
}

class AIMatchingService {
  private isInitialized = false;

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    this.isInitialized = true;
  }

  /**
   * Score a single caregiver. Uses Claude Sonnet as primary intelligence.
   * Falls back to rule-based scoring if Claude is unavailable.
   */
  async scoreCaregiver(
    caregiver: Caregiver,
    seniorProfile: Senior,
    intakeData?: ClientIntakeData,
    feedbackHistory: MatchFeedback[] = []
  ): Promise<AIMatchScore | null> {
    const signals = computeObjectiveSignals(caregiver, seniorProfile, feedbackHistory);
    if (signals.distanceMiles > 30) return null;

    try {
      const scoreMap = await this.scoreWithClaude(
        [{ caregiver, signals }],
        seniorProfile,
        intakeData
      );
      return scoreMap.get(caregiver.id) ?? null;
    } catch {
      return this._legacyScoreCaregiver(caregiver, seniorProfile, feedbackHistory);
    }
  }

  /**
   * Score all caregivers for an intake. Sends candidates to Claude Sonnet
   * in batches of 20 for holistic comparative scoring.
   */
  async scoreAllCaregiversForIntake(
    intakeData: ClientIntakeData,
    seniorProfile: Senior,
    feedbackHistory: MatchFeedback[] = []
  ): Promise<AIMatchScore[]> {
    try {
      const { caregivers } = await dbService.getCaregivers(1000, null);
      if (!caregivers?.length) return [];

      // Apply hard gates before calling Claude
      const candidates = caregivers
        .map(cg => ({ caregiver: cg, signals: computeObjectiveSignals(cg, seniorProfile, feedbackHistory) }))
        .filter(({ signals }) => signals.distanceMiles <= 30 && signals.scheduleOverlapPercent > 0);

      if (!candidates.length) return [];

      const allScores: AIMatchScore[] = [];

      // Chunk into batches of 20 to stay within token limits
      for (let i = 0; i < candidates.length; i += 20) {
        const chunk = candidates.slice(i, i + 20);
        try {
          const scoreMap = await this.scoreWithClaude(chunk, seniorProfile, intakeData);
          allScores.push(...scoreMap.values());
        } catch {
          for (const { caregiver, signals: _ } of chunk) {
            const score = await this._legacyScoreCaregiver(caregiver, seniorProfile, feedbackHistory);
            if (score) allScores.push(score);
          }
        }
        // Brief pause between chunks to respect rate limits
        if (i + 20 < candidates.length) {
          await new Promise(r => setTimeout(r, 500));
        }
      }

      return allScores.sort((a, b) => b.overallScore - a.overallScore);
    } catch (error) {
      console.error('[AI Matching] Error scoring caregivers:', error);
      return [];
    }
  }

  async getTopMatches(
    intakeData: ClientIntakeData,
    seniorProfile: Senior,
    count = 10,
    minScore = 50
  ): Promise<AIMatchScore[]> {
    const all = await this.scoreAllCaregiversForIntake(intakeData, seniorProfile);
    return all.filter(s => s.overallScore >= minScore).slice(0, count);
  }

  async storeMatchScores(matchAssignmentId: string, scores: AIMatchScore[]): Promise<void> {
    try {
      await dbService.storeAIMatchScores(matchAssignmentId, scores as any[]);
    } catch (error) {
      console.error('[AI Matching] Error storing scores:', error);
    }
  }

  async recordOutcome(outcome: Omit<MatchOutcome, 'id'>): Promise<void> {
    try {
      await dbService.recordMatchOutcome(
        outcome.clientId || '',
        outcome.caregiverId,
        outcome.clientHired ? 'hired' : 'rejected'
      );
    } catch (error) {
      console.error('[AI Matching] Error recording outcome:', error);
    }
  }

  async getCoordinatorStats(coordinatorId: string): Promise<{
    totalMatches: number;
    aiSuggestionsPicked: number;
    averageAiScoreOfPicks: number;
  }> {
    try {
      return await dbService.getCoordinatorMatchingStats(coordinatorId);
    } catch {
      return { totalMatches: 0, aiSuggestionsPicked: 0, averageAiScoreOfPicks: 0 };
    }
  }

  /**
   * Core Claude batch scoring. Sends all candidates in one call so Claude
   * can rank them holistically rather than in isolation.
   */
  private async scoreWithClaude(
    candidates: Array<{ caregiver: Caregiver; signals: ObjectiveSignals }>,
    senior: Senior,
    intakeData?: ClientIntakeData
  ): Promise<Map<string, AIMatchScore>> {
    const seniorContext = {
      name: senior.name || 'Senior',
      age: senior.age,
      needs: [
        ...(senior.needs || []),
        ...(intakeData?.careTypes || []),
      ].filter(Boolean),
      adls: senior.adls || [],
      personality: senior.personality,
      genderPreference: senior.genderPreference || 'No Preference',
      languagePreference: senior.languagePreference || 'English',
      hasPets: senior.hasPets,
      scheduleNeeded: senior.scheduleNeeded || [],
    };

    const candidateList = candidates.map(({ caregiver, signals }) => ({
      caregiverId: caregiver.id,
      name: caregiver.name || `${caregiver.firstName || ''} ${caregiver.lastName || ''}`.trim(),
      signals: {
        distanceMiles: signals.distanceMiles,
        skillsCoverage: signals.skillsCoveragePercent,
        scheduleOverlap: signals.scheduleOverlapPercent,
        rating: signals.rating,
        reviewCount: signals.reviewCount,
        yearsExperience: signals.yearsExperience,
        isVerified: signals.isVerified,
        certifications: signals.certifications,
        languages: signals.languages,
        personalityTags: signals.personalityTags,
        hourlyRate: signals.hourlyRate,
        reliabilityScore: signals.reliabilityScore,
        retentionRate: signals.retentionRate,
        feedbackSummary: signals.feedbackSummary,
      },
    }));

    const userMessage = `Score these candidates for the senior profile:\n${JSON.stringify({
      seniorProfile: seniorContext,
      candidates: candidateList,
    })}`;

    const outcomePatterns = await fetchOutcomePatterns();
    const systemPrompt = buildSystemPrompt(outcomePatterns);
    const responseText = await askClaude(systemPrompt, userMessage, 'claude-sonnet-4-6', 4000);
    const parsed: any[] = JSON.parse(stripJsonFences(responseText));

    const resultMap = new Map<string, AIMatchScore>();
    for (const raw of parsed) {
      const match = candidates.find(c => c.caregiver.id === raw.caregiverId);
      if (!match) continue;
      resultMap.set(raw.caregiverId, buildAIMatchScore(raw, match.caregiver, match.signals));
    }
    return resultMap;
  }

  /**
   * Rule-based fallback used when Claude is unavailable.
   */
  private async _legacyScoreCaregiver(
    caregiver: Caregiver,
    seniorProfile: Senior,
    feedbackHistory: MatchFeedback[]
  ): Promise<AIMatchScore | null> {
    try {
      const result = await matchService.scoreCaregiver(
        caregiver, seniorProfile, feedbackHistory, { requestedDate: new Date() }
      );
      if (!result) return null;

      const score = result.matchScore || 50;
      const signals = computeObjectiveSignals(caregiver, seniorProfile, feedbackHistory);
      return {
        caregiverId: caregiver.id,
        caregiverName: caregiver.name,
        overallScore: score,
        breakdown: { ruleBasedScore: score, predictiveScore: score },
        reasoning: result.matchReasoning ? [result.matchReasoning] : [],
        redFlags: result.matchFlags || [],
        confidence: score >= 85 ? 'high' : score >= 70 ? 'medium' : 'low',
        factors: {
          distance: Math.max(0, Math.round(100 - (signals.distanceMiles / 30) * 100)),
          skillsMatch: signals.skillsCoveragePercent,
          availability: signals.scheduleOverlapPercent,
          experience: Math.min(100, Math.round((signals.yearsExperience / 10) * 100)),
          rating: Math.round((signals.rating / 5) * 100),
          retention: signals.retentionRate,
        },
      };
    } catch {
      return null;
    }
  }
}

export const aiMatchingService = new AIMatchingService();

/**
 * Per-caregiver scoring for the FindCaregivers browse flow.
 * Uses Claude Haiku for fast, low-cost individual scoring.
 * Falls back to rule-based formula if Claude is unavailable.
 */
export async function getAIMatches(
  seniorProfile: Partial<Senior>,
  caregiver: Partial<Caregiver>,
  clientIntakeData?: any
): Promise<AIMatchScore> {
  const signals = computeObjectiveSignals(caregiver as Caregiver, seniorProfile as Senior, []);

  try {
    const seniorNeeds = [
      ...(seniorProfile.needs || []),
      ...(clientIntakeData?.careTypes || []),
      ...(clientIntakeData?.tasks
        ? Object.keys(clientIntakeData.tasks).filter(
            k => Array.isArray(clientIntakeData.tasks[k]) && clientIntakeData.tasks[k].length > 0
          )
        : []),
    ].filter(Boolean);

    const userMsg = JSON.stringify({
      senior: {
        needs: seniorNeeds,
        personality: seniorProfile.personality,
        genderPreference: seniorProfile.genderPreference,
        languagePreference: seniorProfile.languagePreference,
      },
      caregiver: {
        distanceMiles: signals.distanceMiles,
        skillsCoverage: signals.skillsCoveragePercent,
        scheduleOverlap: signals.scheduleOverlapPercent,
        rating: signals.rating,
        reviewCount: signals.reviewCount,
        experience: signals.yearsExperience,
        verified: signals.isVerified,
        certifications: signals.certifications,
        languages: signals.languages,
        personalityTags: signals.personalityTags,
        retentionRate: signals.retentionRate,
        feedbackSummary: signals.feedbackSummary,
      },
    });

    const raw = await askClaude(SINGLE_MATCH_SYSTEM, userMsg, 'claude-haiku-4-5-20251001', 500);
    const parsed = JSON.parse(stripJsonFences(raw));

    const overallScore = Math.max(0, Math.min(100, Math.round(Number(parsed.overallScore) || 50)));
    const confidence: 'high' | 'medium' | 'low' =
      ['high', 'medium', 'low'].includes(parsed.confidence)
        ? parsed.confidence
        : overallScore >= 80 ? 'high' : overallScore >= 60 ? 'medium' : 'low';
    const f = parsed.factors || {};

    return {
      caregiverId: caregiver.id || '',
      caregiverName:
        `${caregiver.firstName || ''} ${caregiver.lastName || ''}`.trim() || caregiver.name || '',
      overallScore,
      breakdown: { ruleBasedScore: signals.skillsCoveragePercent, predictiveScore: overallScore },
      reasoning: Array.isArray(parsed.reasoning) ? parsed.reasoning.slice(0, 3) : [],
      redFlags: Array.isArray(parsed.redFlags) ? parsed.redFlags : [],
      confidence,
      factors: {
        distance: Math.max(0, Math.min(100, Math.round(Number(f.distance) || 50))),
        skillsMatch: signals.skillsCoveragePercent,
        availability: signals.scheduleOverlapPercent,
        experience: Math.min(100, Math.round((signals.yearsExperience / 10) * 100)),
        rating: Math.round((signals.rating / 5) * 100),
        retention: signals.retentionRate,
      },
    };
  } catch {
    return _ruleBasedFallback(caregiver, seniorProfile, signals, clientIntakeData);
  }
}

function _ruleBasedFallback(
  caregiver: Partial<Caregiver>,
  seniorProfile: Partial<Senior>,
  signals: ObjectiveSignals,
  clientIntakeData?: any
): AIMatchScore {
  // ADLS match
  let adlsMatchScore = 0;
  const adlsReasoning: string[] = [];
  if (clientIntakeData?.tasks?.adls && Array.isArray(clientIntakeData.tasks.adls)) {
    const clientADLS = clientIntakeData.tasks.adls as string[];
    const caregiverADLS = caregiver.adls || caregiver.skills || [];
    if (clientADLS.length > 0) {
      const adlsMatches = clientADLS.filter((adl: string) =>
        caregiverADLS.some((skill: string) =>
          skill.toLowerCase().includes(adl.toLowerCase()) ||
          adl.toLowerCase().includes(skill.toLowerCase())
        )
      );
      adlsMatchScore = Math.round((adlsMatches.length / clientADLS.length) * 100);
      if (adlsMatches.length > 0) {
        const adlNames: Record<string, string> = {
          ambulation: 'Mobility assistance', bathing: 'Bathing support',
          dressing: 'Dressing assistance', feeding: 'Feeding support',
          toileting: 'Toileting assistance', transfer: 'Transfer assistance',
        };
        const matchedNames = adlsMatches
          .slice(0, 2)
          .map((adl: string) => adlNames[adl.toLowerCase()] || adl)
          .join(', ');
        if (matchedNames) adlsReasoning.push(`Trained in ${matchedNames}`);
      }
    }
  }

  const adlsWeight = adlsMatchScore > 0 ? 0.25 : 0;
  const skillsWeight = adlsMatchScore > 0 ? 0.10 : 0.35;
  const distanceScore =
    signals.distanceMiles <= 5 ? 100 :
    signals.distanceMiles <= 15 ? 80 :
    signals.distanceMiles <= 25 ? 60 : 40;
  const experienceScore =
    signals.yearsExperience >= 5 ? 100 :
    signals.yearsExperience >= 3 ? 80 :
    signals.yearsExperience >= 1 ? 60 : 50;
  const ratingScore = Math.round((signals.rating / 5) * 100);

  const overallScore = Math.round(
    signals.skillsCoveragePercent * skillsWeight +
    adlsMatchScore * adlsWeight +
    signals.scheduleOverlapPercent * 0.25 +
    distanceScore * 0.20 +
    experienceScore * 0.10 +
    ratingScore * 0.10
  );

  const reasoning: string[] = [];
  if (adlsReasoning.length > 0) reasoning.push(...adlsReasoning);
  else if (signals.skillsCoveragePercent >= 70) reasoning.push(`Matches ${signals.skillsCoveragePercent}% of care needs`);
  if (signals.scheduleOverlapPercent >= 70) reasoning.push('Available for your schedule');
  if (signals.distanceMiles <= 10) reasoning.push(`Only ${signals.distanceMiles} miles away`);
  if (signals.yearsExperience >= 3) reasoning.push(`${signals.yearsExperience} years experience`);
  if (signals.rating >= 4.5) reasoning.push(`${signals.rating.toFixed(1)}★ rating`);

  const confidence: 'high' | 'medium' | 'low' =
    overallScore >= 80 && signals.distanceMiles <= 15 ? 'high' :
    overallScore < 50 || signals.distanceMiles > 25 ? 'low' : 'medium';

  const redFlags: string[] = [];
  if (signals.distanceMiles > 20) redFlags.push(`${signals.distanceMiles} miles away`);
  if (signals.rating < 4.0 && signals.rating > 0) redFlags.push('Lower rating');
  if (signals.yearsExperience < 2) redFlags.push('Limited experience');

  return {
    caregiverId: caregiver.id || '',
    caregiverName:
      `${caregiver.firstName || ''} ${caregiver.lastName || ''}`.trim() || caregiver.name || '',
    overallScore,
    breakdown: { ruleBasedScore: overallScore, predictiveScore: overallScore },
    reasoning: reasoning.slice(0, 3),
    redFlags,
    confidence,
    factors: {
      distance: distanceScore,
      skillsMatch: signals.skillsCoveragePercent,
      adlsMatch: adlsMatchScore || undefined,
      availability: signals.scheduleOverlapPercent,
      experience: experienceScore,
      rating: ratingScore,
      retention: signals.retentionRate || 80,
    },
  };
}
