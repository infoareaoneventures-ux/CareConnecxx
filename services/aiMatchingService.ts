import { Caregiver, Senior, MatchFeedback, ClientIntakeData, CareNeed } from '../types';
import { dbService } from './api';
import { matchService } from './matchService';
import { getPredictiveFactors, generatePredictiveReasoning } from './predictiveMatchingOptimized';
import { calculateMLMatchScore } from './mlMatchScoring';

/**
 * AI Matching Service
 * Unified orchestrator for all matching algorithms
 * Runs in background, scores caregivers, tracks outcomes
 * 
 * Architecture:
 * - Rule-based scoring (primary) - explainable, predictable
 * - Predictive factors (secondary) - success probability
 * - ML scoring (tertiary) - neural network refinement (when available)
 */

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

// Scoring weights - tunable
const WEIGHTS = {
  ruleBased: 0.5,      // 50% - explainable rules
  predictive: 0.3,     // 30% - success probability
  ml: 0.2              // 20% - neural network (when ready)
};

// Confidence thresholds
const CONFIDENCE_THRESHOLDS = {
  high: 85,    // Score >= 85, no red flags
  medium: 70,  // Score >= 70, minor flags
  low: 0       // Everything else
};

class AIMatchingService {
  private isInitialized: boolean = false;

  /**
   * Initialize the service
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    
    // Any setup needed
    this.isInitialized = true;
    console.log('[AI Matching] Service initialized');
  }

  /**
   * Score a single caregiver against a senior profile
   * This is the core scoring function used by background jobs
   */
  async scoreCaregiver(
    caregiver: Caregiver,
    seniorProfile: Senior,
    intakeData?: ClientIntakeData,
    feedbackHistory: MatchFeedback[] = []
  ): Promise<AIMatchScore | null> {
    try {
      // Step 1: Rule-based scoring (primary)
      const ruleBasedResult = await matchService.scoreCaregiver(
        caregiver,
        seniorProfile,
        feedbackHistory,
        { requestedDate: new Date() } // Context for availability check
      );

      if (!ruleBasedResult) {
        return null; // Failed hard constraints (distance, availability)
      }

      const ruleBasedScore = ruleBasedResult.matchScore || 50;

      // Step 2: Predictive factors (secondary)
      const predictiveFactors = await getPredictiveFactors(
        caregiver,
        seniorProfile,
        new Date().toISOString()
      );
      const predictiveScore = predictiveFactors.successProbability;

      // Step 3: ML scoring (tertiary) - only if model is trained
      let mlScore: number | undefined;
      try {
        const mlResult = await calculateMLMatchScore(caregiver, seniorProfile);
        if (mlResult) {
          mlScore = mlResult.overallScore;
        }
      } catch (e) {
        // ML model not ready, skip
        console.log('[AI Matching] ML model not available, using rules only');
      }

      // Combine scores
      let overallScore = ruleBasedScore * WEIGHTS.ruleBased + 
                        predictiveScore * WEIGHTS.predictive;
      
      if (mlScore !== undefined) {
        overallScore += mlScore * WEIGHTS.ml;
      } else {
        // Redistribute weights if ML not available
        overallScore = ruleBasedScore * 0.7 + predictiveScore * 0.3;
      }

      overallScore = Math.round(overallScore);

      // Generate reasoning
      const reasoning = this.generateReasoning(
        ruleBasedResult,
        predictiveFactors,
        caregiver,
        seniorProfile
      );

      // Identify red flags
      const redFlags = this.identifyRedFlags(caregiver, seniorProfile, ruleBasedResult);

      // Determine confidence
      const confidence = this.calculateConfidence(overallScore, redFlags);

      return {
        caregiverId: caregiver.id,
        caregiverName: caregiver.name,
        overallScore,
        breakdown: {
          ruleBasedScore,
          predictiveScore,
          mlScore
        },
        reasoning,
        redFlags,
        confidence,
        factors: {
          distance: caregiver.distance || 999,
          skillsMatch: this.calculateSkillsMatch(caregiver, seniorProfile),
          availability: 1, // Already checked in rule-based
          experience: caregiver.experience || 0,
          rating: caregiver.rating || 0,
          retention: caregiver.retentionRate || 0
        }
      };
    } catch (error) {
      console.error('[AI Matching] Error scoring caregiver:', error);
      return null;
    }
  }

  /**
   * Score all caregivers for a given intake
   * Returns ranked list (highest score first)
   */
  async scoreAllCaregiversForIntake(
    intakeData: ClientIntakeData,
    seniorProfile: Senior,
    feedbackHistory: MatchFeedback[] = []
  ): Promise<AIMatchScore[]> {
    console.log(`[AI Matching] Scoring caregivers for intake: ${intakeData.userId}`);

    try {
      // Get all approved caregivers
      const { caregivers } = await dbService.getCaregivers(1000, null);
      
      if (!caregivers || caregivers.length === 0) {
        console.warn('[AI Matching] No caregivers found');
        return [];
      }

      // Score each caregiver
      const scorePromises = caregivers.map(cg => 
        this.scoreCaregiver(cg, seniorProfile, intakeData, feedbackHistory)
      );

      const scores = await Promise.all(scorePromises);

      // Filter out nulls and sort by score
      const validScores = scores.filter((s): s is AIMatchScore => s !== null);
      validScores.sort((a, b) => b.overallScore - a.overallScore);

      console.log(`[AI Matching] Scored ${validScores.length} caregivers`);
      
      return validScores;
    } catch (error) {
      console.error('[AI Matching] Error scoring all caregivers:', error);
      return [];
    }
  }

  /**
   * Get top N matches for an intake
   */
  async getTopMatches(
    intakeData: ClientIntakeData,
    seniorProfile: Senior,
    count: number = 10,
    minScore: number = 50
  ): Promise<AIMatchScore[]> {
    const allScores = await this.scoreAllCaregiversForIntake(intakeData, seniorProfile);
    
    return allScores
      .filter(s => s.overallScore >= minScore)
      .slice(0, count);
  }

  /**
   * Store match scores in Firestore for coordinator review
   */
  async storeMatchScores(
    matchAssignmentId: string,
    scores: AIMatchScore[]
  ): Promise<void> {
    try {
      await dbService.storeAIMatchScores(matchAssignmentId, scores as any[]);
      console.log(`[AI Matching] Stored ${scores.length} scores for ${matchAssignmentId}`);
    } catch (error) {
      console.error('[AI Matching] Error storing scores:', error);
    }
  }

  /**
   * Record match outcome for learning
   */
  async recordOutcome(outcome: Omit<MatchOutcome, 'id'>): Promise<void> {
    try {
      await dbService.recordMatchOutcome(outcome.clientId || '', outcome.caregiverId, outcome.clientHired ? 'hired' : 'rejected');
      console.log(`[AI Matching] Recorded outcome for ${outcome.caregiverId}`);
    } catch (error) {
      console.error('[AI Matching] Error recording outcome:', error);
    }
  }

  /**
   * Get coordinator's pick rate (how often they pick AI suggestions)
   */
  async getCoordinatorStats(coordinatorId: string): Promise<{
    totalMatches: number;
    aiSuggestionsPicked: number;
    averageAiScoreOfPicks: number;
  }> {
    try {
      return await dbService.getCoordinatorMatchingStats(coordinatorId);
    } catch (error) {
      console.error('[AI Matching] Error getting stats:', error);
      return { totalMatches: 0, aiSuggestionsPicked: 0, averageAiScoreOfPicks: 0 };
    }
  }

  // Private helper methods

  private generateReasoning(
    ruleBasedResult: any,
    predictiveFactors: any,
    caregiver: Caregiver,
    senior: Senior
  ): string[] {
    const reasons: string[] = [];

    // Distance
    if (caregiver.distance && caregiver.distance < 5) {
      reasons.push(`Only ${caregiver.distance} miles away`);
    }

    // Skills
    const seniorNeeds = senior.needs || [];
    const caregiverSkills = caregiver.skills || [];
    const matchingSkills = seniorNeeds.filter(need =>
      caregiverSkills.some(skill => 
        skill.toLowerCase().includes(need.toLowerCase())
      )
    );
    if (matchingSkills.length > 0) {
      reasons.push(`Has experience with: ${matchingSkills.slice(0, 2).join(', ')}`);
    }

    // Experience
    if (caregiver.experience && caregiver.experience >= 3) {
      reasons.push(`${caregiver.experience} years of experience`);
    }

    // Rating
    if (caregiver.rating && caregiver.rating >= 4.5) {
      reasons.push(`Exceptional ${caregiver.rating.toFixed(1)}★ rating`);
    }

    // Predictive factors
    if (predictiveFactors.factors && predictiveFactors.factors.length > 0) {
      reasons.push(...predictiveFactors.factors.slice(0, 2));
    }

    return reasons.slice(0, 4); // Max 4 reasons
  }

  private identifyRedFlags(
    caregiver: Caregiver,
    senior: Senior,
    ruleBasedResult: any
  ): string[] {
    const flags: string[] = [];

    // Distance
    if (caregiver.distance && caregiver.distance > 15) {
      flags.push(`${caregiver.distance} miles away - may affect reliability`);
    }

    // Low rating
    if (caregiver.rating && caregiver.rating < 4.0) {
      flags.push(`Lower rating (${caregiver.rating}★) - review feedback`);
    }

    // Low retention
    if (caregiver.retentionRate && caregiver.retentionRate < 50) {
      flags.push(`Lower client retention - may not be long-term fit`);
    }

    // Limited experience with needs
    const seniorNeeds = senior.needs || [];
    const caregiverSkills = caregiver.skills || [];
    const hasDementiaExperience = caregiverSkills.some(s => 
      s.toLowerCase().includes('dementia')
    );
    if (seniorNeeds.some(n => n.toLowerCase().includes('dementia')) && !hasDementiaExperience) {
      flags.push(`No dementia care experience listed`);
    }

    return flags;
  }

  private calculateConfidence(
    score: number,
    redFlags: string[]
  ): 'high' | 'medium' | 'low' {
    if (score >= CONFIDENCE_THRESHOLDS.high && redFlags.length === 0) {
      return 'high';
    }
    if (score >= CONFIDENCE_THRESHOLDS.medium && redFlags.length <= 1) {
      return 'medium';
    }
    return 'low';
  }

  private calculateSkillsMatch(caregiver: Caregiver, senior: Senior): number {
    const seniorNeeds = senior.needs || [];
    const caregiverSkills = caregiver.skills || [];
    
    if (seniorNeeds.length === 0) return 1;

    const matches = seniorNeeds.filter(need =>
      caregiverSkills.some(skill =>
        skill.toLowerCase().includes(need.toLowerCase()) ||
        need.toLowerCase().includes(skill.toLowerCase())
      )
    ).length;

    return matches / seniorNeeds.length;
  }
}

// Export singleton
export const aiMatchingService = new AIMatchingService();

/**
 * Simplified function for client-side matching
 * Used by FindCaregivers component
 */
export async function getAIMatches(
  seniorProfile: Partial<Senior>,
  caregiver: Partial<Caregiver>,
  clientIntakeData?: any
): Promise<AIMatchScore> {
  // Calculate skills match
  const seniorNeeds = seniorProfile.needs || [];
  const caregiverSkills = caregiver.skills || [];
  
  let skillsMatchScore = 0;
  if (seniorNeeds.length > 0 && caregiverSkills.length > 0) {
    const matches = seniorNeeds.filter(need =>
      caregiverSkills.some(skill =>
        skill.toLowerCase().includes(need.toLowerCase()) ||
        need.toLowerCase().includes(skill.toLowerCase())
      )
    ).length;
    skillsMatchScore = Math.round((matches / seniorNeeds.length) * 100);
  } else {
    skillsMatchScore = 70; // Default if no data
  }

  // Calculate ADLS match (Activities of Daily Living)
  let adlsMatchScore = 0;
  let adlsReasoning: string[] = [];
  
  if (clientIntakeData?.tasks?.adls && Array.isArray(clientIntakeData.tasks.adls)) {
    const clientADLS = clientIntakeData.tasks.adls as string[];
    const caregiverADLS = caregiver.adls || caregiver.skills || [];
    
    if (clientADLS.length > 0) {
      const adlsMatches = clientADLS.filter(adl =>
        caregiverADLS.some((skill: string) =>
          skill.toLowerCase().includes(adl.toLowerCase()) ||
          adl.toLowerCase().includes(skill.toLowerCase())
        )
      );
      
      adlsMatchScore = Math.round((adlsMatches.length / clientADLS.length) * 100);
      
      // Generate ADLS-specific reasoning
      if (adlsMatches.length > 0) {
        const adlNames: Record<string, string> = {
          'ambulation': 'Mobility assistance',
          'bathing': 'Bathing support',
          'dressing': 'Dressing assistance',
          'feeding': 'Feeding support',
          'toileting': 'Toileting assistance',
          'transfer': 'Transfer assistance'
        };
        
        const matchedNames = adlsMatches
          .slice(0, 2)
          .map(adl => adlNames[adl.toLowerCase()] || adl)
          .join(', ');
        
        if (matchedNames) {
          adlsReasoning.push(`Trained in ${matchedNames}`);
        }
      }
    }
  }

  // Calculate availability match
  const seniorSchedule: Record<string, string[]> = (Array.isArray(seniorProfile.schedule) ? {} : seniorProfile.schedule) || {};
  const caregiverAvailArr: string[] = Array.isArray(caregiver.availability) ? caregiver.availability : [];
  let availabilityScore = 0;

  const seniorDays = Object.keys(seniorSchedule);
  if (seniorDays.length > 0) {
    let matchingDays = 0;
    seniorDays.forEach(day => {
      const seniorTimes = seniorSchedule[day] || [];
      const caregiverTimes = caregiverAvailArr.filter(a => a.toLowerCase().includes(day.toLowerCase()));
      if (seniorTimes.some((t: string) => caregiverTimes.includes(t))) {
        matchingDays++;
      }
    });
    availabilityScore = Math.round((matchingDays / seniorDays.length) * 100);
  } else {
    availabilityScore = 80; // Default
  }

  // Use ADLS score if available, otherwise fall back to skills match
  const adlsWeight = adlsMatchScore > 0 ? 0.25 : 0;
  const skillsWeight = adlsMatchScore > 0 ? 0.10 : 0.35;

  // Distance score
  const distance = caregiver.distance || 10;
  const distanceScore = distance <= 5 ? 100 : distance <= 15 ? 80 : distance <= 25 ? 60 : 40;

  // Experience score
  const experience = caregiver.experience || 0;
  const experienceScore = experience >= 5 ? 100 : experience >= 3 ? 80 : experience >= 1 ? 60 : 50;

  // Rating score
  const rating = caregiver.rating || 4.0;
  const ratingScore = (rating / 5) * 100;

  // Calculate overall score (weighted) - includes ADLS
  const overallScore = Math.round(
    (skillsMatchScore * skillsWeight) +
    (adlsMatchScore * adlsWeight) +
    (availabilityScore * 0.25) +
    (distanceScore * 0.20) +
    (experienceScore * 0.10) +
    (ratingScore * 0.10)
  );

  // Generate reasoning
  const reasoning: string[] = [];
  
  // Add ADLS reasoning first if available
  if (adlsReasoning.length > 0) {
    reasoning.push(...adlsReasoning);
  } else if (skillsMatchScore >= 70) {
    reasoning.push(`Matches ${skillsMatchScore}% of your care needs`);
  }
  
  if (availabilityScore >= 70) reasoning.push('Available for your schedule');
  if (distance <= 10) reasoning.push(`Only ${distance} miles away`);
  if (experience >= 3) reasoning.push(`${experience} years experience`);
  if (rating >= 4.5) reasoning.push(`${rating.toFixed(1)}★ rating`);

  // Determine confidence
  let confidence: 'high' | 'medium' | 'low' = 'medium';
  if (overallScore >= 80 && distance <= 15) confidence = 'high';
  else if (overallScore < 50 || distance > 25) confidence = 'low';

  // Red flags
  const redFlags: string[] = [];
  if (distance > 20) redFlags.push(`${distance} miles away`);
  if (rating < 4.0) redFlags.push(`Lower rating`);
  if (experience < 2) redFlags.push(`Limited experience`);

  return {
    caregiverId: caregiver.id || '',
    caregiverName: `${caregiver.firstName || ''} ${caregiver.lastName || ''}`.trim(),
    overallScore,
    breakdown: {
      ruleBasedScore: overallScore,
      predictiveScore: overallScore,
    },
    reasoning: reasoning.slice(0, 3),
    redFlags,
    confidence,
    factors: {
      distance,
      skillsMatch: skillsMatchScore,
      adlsMatch: adlsMatchScore,
      availability: availabilityScore,
      experience: experienceScore,
      rating: Math.round(ratingScore),
      retention: 80,
    },
  };
}
