import { Caregiver, Senior, MatchFeedback } from '../types';

export interface ObjectiveSignals {
  distanceMiles: number;
  skillsCoveragePercent: number;
  scheduleOverlapPercent: number;
  rating: number;
  reviewCount: number;
  yearsExperience: number;
  isVerified: boolean;
  reliabilityScore: number;
  retentionRate: number;
  certifications: string[];
  languages: string[];
  personalityTags: string[];
  hourlyRate: number;
  feedbackSummary: string;
}
import { availabilityService } from './availabilityService';
import { getPredictiveFactors, generatePredictiveReasoning, getBatchPredictiveFactors } from './predictiveMatchingOptimized';

// Haversine Formula for real distance
const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const R = 3958.8; // Radius of Earth in miles
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(R * c * 10) / 10; // Round to 1 decimal
};

// Maximum distance for caregivers (in miles)
const MAX_DISTANCE_MILES = 30;
const NEARBY_DISTANCE_MILES = 5;
const MEDIUM_DISTANCE_MILES = 15;
const MAX_EXPERIENCE_YEARS = 5;
const MIN_EXPERIENCE_YEARS = 3;

// Scoring weights - configurable for A/B testing
const WEIGHTS = {
    distance: {
        nearby: 20,      // < 5 miles
        medium: 10,      // 5-15 miles
        far: -10,        // > 15 miles
        microVisitBonus: 15, // Extra for micro-visits nearby
        microVisitPenalty: -15 // Less penalty for micro-visits far away
    },
    skills: {
        perMatch: 10,    // +10 per matched skill
        maxBonus: 30,    // Cap at 30 points
        highNeedsBoost: 10 // Extra when caregiver has 3+ years experience
    },
    schedule: 15,      // Schedule compatibility
    gender: 15,        // Gender preference match
    reliability: 0.2,  // 20% of reliability score (0-100)
    verified: 10,      // Verified bonus
    rating: 0.5,       // 0.5 points per star
    experience: 5,     // Per year of experience (max 25)
    retention: 20      // NEW: Client retention/rebooking bonus (up to 20 pts)
};

// Score caps
const SCORE_CAPS = {
    min: 0,
    max: 100,
    excellent: 85,
    good: 70,
    fair: 50
};

export const matchService = {
    /**
     * Core Algorithm: Calculates a weighted score for a caregiver based on senior profile and feedback history.
     * 
     * FIXES APPLIED:
     * 1. Proper score capping (0-100)
     * 2. Fixed double penalty for micro-visits
     * 3. Normalized weights
     * 4. Better reasoning generation
     * 5. Real availability checking
     */
    scoreCaregiver: async (
        caregiver: Caregiver, 
        seniorProfile: Senior, 
        feedbackHistory: MatchFeedback[], 
        context?: { 
            isMicroVisit?: boolean;
            requestedDate?: Date;
            requestedTime?: string;
            requestedDuration?: number;
        },
        preCalculatedFactors?: any
    ): Promise<Caregiver | null> => {
        const reasons: string[] = [];
        const flags: string[] = [];

        // --- STEP 0: REAL AVAILABILITY CHECK (CRITICAL FIX) ---
        if (context?.requestedDate && context?.requestedTime && context?.requestedDuration) {
            const isAvailable = await availabilityService.isAvailable(
                caregiver,
                context.requestedDate,
                context.requestedTime,
                context.requestedDuration
            );

            if (!isAvailable) {
                return null; // Not available at requested time
            }
        }

        // --- PRE-ANALYSIS: BUILD TASTE PROFILE FROM FEEDBACK ---
        const preferredTags = new Set<string>();
        const dislikedTags = new Set<string>();

        feedbackHistory.forEach(feedback => {
            if (feedback.action === 'rejected' && feedback.reason) {
                const reason = feedback.reason.toLowerCase();
                if (reason.includes('loud') || reason.includes('energy')) {
                    dislikedTags.add('High Energy');
                    dislikedTags.add('Chatty');
                }
                if (reason.includes('smoker')) {
                    dislikedTags.add('Smoker');
                }
                if (reason.includes('late') || reason.includes('unreliable')) {
                    dislikedTags.add('Unreliable');
                }
            } else if (feedback.action === 'hired') {
                // Learn from successful hires
                if (feedback.reason) {
                    preferredTags.add(feedback.reason);
                }
            }
        });

        // --- STEP 1: SAFETY & LOGISTICS GATE (Pass/Fail) ---
        // Calculate Real Distance
        let distance = caregiver.distance;
        if (seniorProfile.latitude && seniorProfile.longitude && caregiver.latitude && caregiver.longitude) {
            distance = calculateDistance(
                seniorProfile.latitude, 
                seniorProfile.longitude, 
                caregiver.latitude, 
                caregiver.longitude
            );
            caregiver.distance = distance; // Update instance for display
        }

        // Hard cutoff at max distance
        if (distance > MAX_DISTANCE_MILES) {
            flags.push(`Too far (> ${MAX_DISTANCE_MILES} miles)`);
            return null;
        }

        let score = 0;

        // --- STEP 2: DISTANCE SCORING (FIXED) ---
        const isMicroVisit = context?.isMicroVisit || false;

        if (distance < NEARBY_DISTANCE_MILES) {
            // Nearby: Good for all visit types
            score += WEIGHTS.distance.nearby;
            if (isMicroVisit) {
                score += WEIGHTS.distance.microVisitBonus;
                reasons.push(`Prime location for short visit (${distance} miles)`);
            } else {
                reasons.push(`Nearby (${distance} miles)`);
            }
        } else if (distance < MEDIUM_DISTANCE_MILES) {
            // Medium distance: Acceptable
            score += WEIGHTS.distance.medium;
            reasons.push(`Reasonable distance (${distance} miles)`);
        } else {
            // Far: Penalty, but FIX - no double penalty for micro-visits
            score += WEIGHTS.distance.far;
            if (isMicroVisit) {
                // Slightly better penalty for micro-visits (caregivers accept short trips)
                score += WEIGHTS.distance.microVisitPenalty; // -15 instead of -30
                flags.push('Far for short visit, but may accept');
            } else {
                flags.push(`Far away (${distance} miles)`);
            }
        }

        // --- STEP 3: VERIFICATION STATUS ---
        if (caregiver.verified) {
            score += WEIGHTS.verified;
            reasons.push('Verified & background checked');
        } else {
            flags.push('Not yet verified');
        }

        // --- STEP 4: CRITICAL NEEDS MATCHING (Safety First) ---
        const neededSkills = seniorProfile.needs || [];
        const caregiverSkills = [
            ...(caregiver.medicalSkills || []),
            ...(caregiver.skills || []),
            ...(caregiver.certifications || [])
        ];

        const matchedSkills = neededSkills.filter(need =>
            caregiverSkills.some(skill => 
                skill.toLowerCase().includes(need.toLowerCase()) ||
                need.toLowerCase().includes(skill.toLowerCase())
            )
        );

        if (matchedSkills.length > 0) {
            // Cap the skills bonus
            const skillsBonus = Math.min(
                matchedSkills.length * WEIGHTS.skills.perMatch,
                WEIGHTS.skills.maxBonus
            );
            score += skillsBonus;
            reasons.push(`Skilled in: ${matchedSkills.slice(0, 3).join(', ')}`);
        }

        // Experience boost for high-needs cases
        if ((caregiver.experience || 0) >= MIN_EXPERIENCE_YEARS && neededSkills.length > 1) {
            score += WEIGHTS.skills.highNeedsBoost;
            reasons.push(`${caregiver.experience} years experience with complex needs`);
        }

        // --- STEP 5: SCHEDULE COMPATIBILITY ---
        const neededSchedule = seniorProfile.scheduleNeeded || [];
        const availableTimes = caregiver.availability || [];

        const scheduleMatch = neededSchedule.filter(time => 
            availableTimes.includes(time)
        );

        if (scheduleMatch.length > 0) {
            score += WEIGHTS.schedule;
            reasons.push('Schedule matches your needs');
        } else if (neededSchedule.length > 0) {
            score -= 5; // Reduced penalty
            flags.push('Schedule may need adjustment');
        }

        // --- STEP 6: GENDER PREFERENCE ---
        if (seniorProfile.genderPreference && seniorProfile.genderPreference !== 'No Preference') {
            if (caregiver.gender) {
                if (caregiver.gender === seniorProfile.genderPreference) {
                    score += WEIGHTS.gender;
                    reasons.push(`Matches ${seniorProfile.genderPreference} preference`);
                } else {
                    score -= WEIGHTS.gender;
                    flags.push(`Gender mismatch (prefers ${seniorProfile.genderPreference})`);
                }
            } else {
                score -= 5; // Reduced penalty for unspecified gender
                flags.push('Gender not specified in profile');
            }
        }

        // --- STEP 7: PERSONALITY MATCHING ---
        if (seniorProfile.personality === 'Introvert') {
            if (caregiver.personalityTags?.includes('Patient')) {
                score += 15;
                reasons.push('Patient demeanor for introvert client');
            }
            if (caregiver.personalityTags?.includes('Calm')) {
                score += 20;
                reasons.push('Calm personality match');
            }
            if (caregiver.personalityTags?.includes('High Energy')) {
                score -= 10;
                flags.push('High energy may not match');
            }
            if (caregiver.personalityTags?.includes('Chatty')) {
                score -= 10;
                flags.push('Very chatty may not match');
            }
        } else if (seniorProfile.personality === 'Extrovert') {
            if (caregiver.personalityTags?.includes('Energetic') || caregiver.personalityTags?.includes('High Energy')) {
                score += 15;
                reasons.push('Energetic match for extrovert');
            }
            if (caregiver.personalityTags?.includes('Chatty')) {
                score += 20;
                reasons.push('Social & chatty personality match');
            }
        }

        // --- STEP 8: RELIABILITY & EXPERIENCE ---
        const relScore = caregiver.reliabilityScore || 80;
        score += Math.round(relScore * WEIGHTS.reliability);

        if ((caregiver.experience || 0) > 0) {
            const expBonus = Math.min(
                (caregiver.experience || 0) * WEIGHTS.experience, 
                MAX_EXPERIENCE_YEARS * WEIGHTS.experience
            );
            score += expBonus;
        }

        // --- STEP 9: RATING ---
        if (caregiver.rating && caregiver.rating > 0) {
            score += Math.round(caregiver.rating * WEIGHTS.rating);
            if (caregiver.rating >= 4.8) {
                reasons.push(`⭐ Excellent rating (${caregiver.rating})`);
            }
        }

        // --- STEP 9.5: RETENTION/REBOOKING SCORE (NEW) ---
        // Boost caregivers that families stick with
        const retentionRate = caregiver.retentionRate || caregiver.reliabilityScore || 0;
        if (retentionRate > 0) {
            // Scale retention rate (0-100) to score bonus (0-20)
            const retentionBonus = Math.round((retentionRate / 100) * WEIGHTS.retention);
            score += retentionBonus;
            
            if (retentionRate >= 80) {
                reasons.push('Families rebook often');
            } else if (retentionRate >= 60) {
                reasons.push('Strong client relationships');
            }
        }

        // --- STEP 10: FEEDBACK HISTORY (Self-Learning) ---
        let historyPenalty = 0;
        const badTags = caregiver.personalityTags?.filter(tag => dislikedTags.has(tag)) || [];

        if (badTags.length > 0) {
            historyPenalty = badTags.length * 35;
            score -= historyPenalty;
            flags.push(`Pattern: Previously rejected for '${badTags[0]}'`);
        }

        // Check for preferred tags
        const goodTags = caregiver.personalityTags?.filter(tag => preferredTags.has(tag)) || [];
        if (goodTags.length > 0) {
            score += goodTags.length * 15;
            reasons.push(`Has traits you've liked before`);
        }

        // --- STEP 11: SCORE NORMALIZATION & CAPPING (CRITICAL FIX) ---
        // Ensure score is between 0 and 100
        let finalScore = Math.max(SCORE_CAPS.min, Math.min(Math.round(score), SCORE_CAPS.max));

        // --- STEP 12: PREDICTIVE SCORING INTEGRATION (NEW) ---
        // Blend with AI-powered predictive factors if enabled
        if (context?.requestedDate && context?.requestedTime) {
            try {
                // Use pre-calculated factors if available (batch optimization)
                const predictiveFactors = preCalculatedFactors || await getPredictiveFactors(
                    caregiver,
                    seniorProfile,
                    context.requestedDate instanceof Date ? context.requestedDate.toISOString() : context.requestedDate,
                    context.requestedTime
                );

                // Blend: 70% base score, 30% predictive
                finalScore = Math.round(
                    (finalScore * 0.7) + (predictiveFactors.successProbability * 0.3)
                );

                // Add predictive reasoning
                if (predictiveFactors.similarSeniorsScore >= 75) {
                    reasons.push(`Seniors like yours love this caregiver`);
                }
                if (predictiveFactors.retentionScore >= 80) {
                    reasons.push(`${predictiveFactors.retentionScore}% client retention rate`);
                }
                if (predictiveFactors.acceptanceProbability >= 85) {
                    reasons.push(`Likely to accept this shift`);
                }

                // Cap again after blending
                finalScore = Math.max(SCORE_CAPS.min, Math.min(finalScore, SCORE_CAPS.max));

            } catch (error) {
                // Predictive scoring failed, continue with base score
                console.warn('Predictive scoring failed:', error);
            }
        }

        // --- STEP 13: REASONING GENERATION ---
        let reasoning = "";

        // Build confidence indicator
        const confidenceEmoji = finalScore >= 90 ? '🎯' : finalScore >= 75 ? '✓' : '⚠';

        if (finalScore >= SCORE_CAPS.excellent) {
            reasoning = reasons.length > 0 
                ? `${confidenceEmoji} Excellent match! ${reasons[0]}`
                : `${confidenceEmoji} Excellent overall match.`;
        } else if (finalScore >= SCORE_CAPS.good) {
            reasoning = reasons.length > 0
                ? `${confidenceEmoji} Good match. ${reasons[0]}`
                : `${confidenceEmoji} Good overall match.`;
        } else if (finalScore >= SCORE_CAPS.fair) {
            reasoning = reasons.length > 0
                ? `${confidenceEmoji} Fair match. ${reasons[0]}`
                : `${confidenceEmoji} Meets basic requirements.`;
        } else {
            reasoning = flags.length > 0
                ? `⚠ Some concerns: ${flags[0]}`
                : `⚠ Limited match.`;
        }

        // Add context for why not 100
        if (flags.length > 0 && finalScore < 90) {
            reasoning += ` Note: ${flags[0]}.`;
        }

        return {
            ...caregiver,
            matchScore: finalScore,
            matchReasoning: reasoning,
            matchFlags: flags
        };
    },

    /**
     * Batch scoring for multiple caregivers
     * More efficient than individual calls
     */
    scoreCaregivers: async (
        caregivers: Caregiver[],
        seniorProfile: Senior,
        feedbackHistory: MatchFeedback[],
        context?: {
            isMicroVisit?: boolean;
            requestedDate?: Date;
            requestedTime?: string;
            requestedDuration?: number;
        }
    ): Promise<Caregiver[]> => {
        const scoredCaregivers: Caregiver[] = [];

        // Pre-check availability for all (batch operation)
        let availabilityMap: Map<string, boolean> | null = null;
        
        if (context?.requestedDate && context?.requestedTime && context?.requestedDuration) {
            availabilityMap = await availabilityService.batchCheckAvailability(
                caregivers,
                context.requestedDate,
                context.requestedTime,
                context.requestedDuration
            );
        }

        // OPTIMIZATION: Batch predictive scoring for better performance
        let predictiveFactorsMap: Map<string, any> | null = null;
        if (context?.requestedDate && context?.requestedTime) {
            try {
                predictiveFactorsMap = await getBatchPredictiveFactors(
                    caregivers.filter(c => !availabilityMap || availabilityMap.get(c.id)),
                    seniorProfile,
                    context.requestedDate instanceof Date ? context.requestedDate.toISOString() : context.requestedDate,
                    context.requestedTime
                );
            } catch (error) {
                console.warn('[MatchService] Batch predictive scoring failed:', error);
            }
        }

        for (const caregiver of caregivers) {
            // Skip if not available
            if (availabilityMap && !availabilityMap.get(caregiver.id)) {
                continue;
            }

            const scored = await matchService.scoreCaregiver(
                caregiver,
                seniorProfile,
                feedbackHistory,
                context,
                predictiveFactorsMap?.get(caregiver.id)
            );

            if (scored && scored.matchScore > 0) {
                scoredCaregivers.push(scored);
            }
        }

        // Sort by score descending
        return scoredCaregivers.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));
    },

    /**
     * Get top N matches
     */
    getTopMatches: async (
        caregivers: Caregiver[],
        seniorProfile: Senior,
        feedbackHistory: MatchFeedback[],
        topN: number = 5,
        context?: {
            isMicroVisit?: boolean;
            requestedDate?: Date;
            requestedTime?: string;
            requestedDuration?: number;
        }
    ): Promise<Caregiver[]> => {
        const scored = await matchService.scoreCaregivers(
            caregivers,
            seniorProfile,
            feedbackHistory,
            context
        );

        return scored.slice(0, topN);
    },

    /**
     * Get predictive insights for a caregiver
     * Use this to show why a caregiver is a good match
     */
    getMatchInsights: async (
        caregiver: Caregiver,
        senior: Senior,
        requestedDate?: Date,
        requestedTime?: string
    ): Promise<{
        score: number;
        reasoning: string;
        confidence: 'high' | 'medium' | 'low';
        insights: string[];
    }> => {
        const factors = await getPredictiveFactors(caregiver, senior, requestedDate instanceof Date ? requestedDate.toISOString() : requestedDate, requestedTime);

        const insights: string[] = [];

        if (factors.similarSeniorsScore >= 75) {
            insights.push(`Seniors similar to ${senior.name || 'your loved one'} have given ${caregiver.name} excellent reviews`);
        }
        if ((factors.retentionScore ?? 0) >= 80) {
            insights.push(`${factors.retentionScore}% of families continue booking ${caregiver.name} long-term`);
        }
        if ((factors.acceptanceProbability ?? 0) >= 85) {
            insights.push(`${caregiver.name} usually accepts shifts at this time`);
        }
        if (factors.successProbability >= 85) {
            insights.push(`High confidence match based on historical data`);
        }

        return {
            score: factors.successProbability,
            reasoning: generatePredictiveReasoning(factors, caregiver.name || 'This caregiver'),
            confidence: (factors.confidence !== undefined
                ? (factors.confidence >= 70 ? 'high' : factors.confidence >= 40 ? 'medium' : 'low')
                : 'medium') as 'high' | 'medium' | 'low',
            insights
        };
    }
};

/**
 * Compute objective, numerical signals for a caregiver-senior pair.
 * These are fed as structured context to Claude for intelligent scoring.
 */
export function computeObjectiveSignals(
    caregiver: Caregiver,
    senior: Senior,
    feedbackHistory: MatchFeedback[] = []
): ObjectiveSignals {
    // Distance
    let distanceMiles = caregiver.distance ?? 999;
    if (senior.latitude && senior.longitude && caregiver.latitude && caregiver.longitude) {
        distanceMiles = calculateDistance(
            senior.latitude, senior.longitude,
            caregiver.latitude, caregiver.longitude
        );
    }

    // Skills coverage
    const neededSkills = senior.needs || [];
    const caregiverSkills = [
        ...(caregiver.medicalSkills || []),
        ...(caregiver.skills || []),
        ...(caregiver.certifications || [])
    ];
    const skillsCoveragePercent = neededSkills.length > 0
        ? Math.round(
            (neededSkills.filter(need =>
                caregiverSkills.some(skill =>
                    skill.toLowerCase().includes(need.toLowerCase()) ||
                    need.toLowerCase().includes(skill.toLowerCase())
                )
            ).length / neededSkills.length) * 100
        )
        : 70;

    // Schedule overlap
    const neededSchedule = senior.scheduleNeeded || [];
    const availableTimes = caregiver.availability || [];
    const scheduleOverlapPercent = neededSchedule.length > 0
        ? Math.round(
            (neededSchedule.filter(time => availableTimes.includes(time)).length / neededSchedule.length) * 100
        )
        : 80;

    // Certification flags
    const allCerts = [
        ...(caregiver.certifications || []),
        ...(caregiver.medicalSkills || []),
        ...(caregiver.skills || [])
    ].map(c => c.toLowerCase());
    // Feedback summary
    const hiredCount = feedbackHistory.filter(f => f.caregiverId === caregiver.id && f.action === 'hired').length;
    const rejectedCount = feedbackHistory.filter(f => f.caregiverId === caregiver.id && f.action === 'rejected').length;
    const feedbackSummary = (hiredCount > 0 || rejectedCount > 0)
        ? `hired ${hiredCount} time${hiredCount !== 1 ? 's' : ''}, rejected ${rejectedCount} time${rejectedCount !== 1 ? 's' : ''} by this family`
        : 'no prior history with this family';

    return {
        distanceMiles: Math.round(distanceMiles * 10) / 10,
        skillsCoveragePercent,
        scheduleOverlapPercent,
        rating: caregiver.rating || 0,
        reviewCount: caregiver.reviewCount || 0,
        yearsExperience: caregiver.experience || 0,
        isVerified: caregiver.verified || false,
        reliabilityScore: caregiver.reliabilityScore || 80,
        retentionRate: caregiver.retentionRate || 0,
        certifications: [...(caregiver.certifications || []), ...(caregiver.medicalSkills || [])],
        languages: caregiver.languages || [],
        personalityTags: caregiver.personalityTags || [],
        hourlyRate: caregiver.hourlyRate || 0,
        feedbackSummary
    };
}
