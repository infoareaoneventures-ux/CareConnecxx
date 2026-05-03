import { Caregiver, Senior, Appointment, MatchScore } from '../types';

/**
 * Smart Matching Service
 * Calculates compatibility scores between seniors and caregivers
 * 
 * This is a rules-based scoring system that acts as "AI v1"
 * Future versions will use ML models trained on booking data
 */

interface MatchFactors {
  skillsMatch: number;      // 0-100
  availabilityMatch: number; // 0-100
  personalityMatch: number;  // 0-100
  distanceScore: number;     // 0-100
  ratingScore: number;       // 0-100
  rebookingRate: number;     // 0-100 (if historical data exists)
}

/**
 * Calculate match score between a senior and caregiver
 */
export function calculateMatchScore(
  caregiver: Caregiver,
  senior: Senior,
  history?: Appointment[]
): MatchScore {
  const factors = calculateFactors(caregiver, senior, history);
  const overallScore = weightedAverage(factors);

  return {
    caregiverId: caregiver.id,
    overallScore: Math.round(overallScore),
    breakdown: factors,
    reasoning: generateReasoning(caregiver, factors, senior),
    confidence: calculateConfidence(factors)
  };
}

/**
 * Calculate individual match factors
 */
function calculateFactors(
  caregiver: Caregiver,
  senior: Senior,
  history?: Appointment[]
): MatchFactors {
  return {
    skillsMatch: calculateSkillsMatch(caregiver, senior),
    availabilityMatch: calculateAvailabilityMatch(caregiver, senior),
    personalityMatch: calculatePersonalityMatch(caregiver, senior),
    distanceScore: calculateDistanceScore(caregiver, senior),
    ratingScore: calculateRatingScore(caregiver),
    rebookingRate: calculateRebookingRate(caregiver.id, history)
  };
}

/**
 * Skills match: How well do caregiver skills match senior needs?
 * Weight: 35%
 */
function calculateSkillsMatch(caregiver: Caregiver, senior: Senior): number {
  if (!senior.needs || senior.needs.length === 0) return 70; // Default if no needs specified
  if (!caregiver.skills || caregiver.skills.length === 0) return 50; // No skills listed

  const seniorNeeds = senior.needs.map(n => n.toLowerCase());
  const caregiverSkills = caregiver.skills.map(s => s.toLowerCase());

  let matches = 0;
  const matchedSkills: string[] = [];

  for (const need of seniorNeeds) {
    // Direct match
    if (caregiverSkills.some(s => s.includes(need) || need.includes(s))) {
      matches++;
      matchedSkills.push(need);
      continue;
    }

    // Semantic matches
    const semanticMatches: Record<string, string[]> = {
      'dementia': ['memory care', 'alzheimer', 'cognitive', 'patience'],
      'mobility': ['lifting', 'transfer', 'hoyer', 'wheelchair', 'physical'],
      'medication': ['medical', 'cna', 'nurse', 'cpr', 'first aid'],
      'meal': ['cooking', 'nutrition', 'kitchen', 'diet'],
      'transportation': ['driving', 'driver', 'car', 'errands'],
      'housekeeping': ['cleaning', 'laundry', 'organizing', 'chores'],
      'bathing': ['hygiene', 'personal care', 'bathroom', 'shower'],
      'companionship': ['social', 'conversation', 'activities', 'games']
    };

    for (const [key, related] of Object.entries(semanticMatches)) {
      if (need.includes(key)) {
        if (caregiverSkills.some(s => related.some(r => s.includes(r)))) {
          matches += 0.7; // Partial credit for related skill
          break;
        }
      }
    }
  }

  return Math.round((matches / seniorNeeds.length) * 100);
}

/**
 * Availability match: Do schedules align?
 * Weight: 25%
 */
function calculateAvailabilityMatch(caregiver: Caregiver, senior: Senior): number {
  // If no specific schedule needed, give medium score
  if (!senior.scheduleNeeded || senior.scheduleNeeded.length === 0) {
    return 70;
  }

  // If caregiver has no availability set, assume flexible
  if (!caregiver.availability) {
    return 60;
  }

  // Simple schedule overlap check
  const neededTimes = senior.scheduleNeeded.map(s => s.toLowerCase());
  
  // Check if caregiver's general availability aligns
  const caregiverAvailable = caregiver.availability;
  
  // Score based on how many requested times could potentially work
  // This is simplified - real implementation would check specific days/times
  const potentialMatch = neededTimes.some(time => {
    if (time.includes('morning')) return true; // Most caregivers work mornings
    if (time.includes('afternoon')) return true;
    if (time.includes('evening')) return caregiverAvailable.some((a: string) => a.toLowerCase().includes('evening'));
    if (time.includes('overnight')) return caregiverAvailable.some((a: string) => a.toLowerCase().includes('overnight') || a.toLowerCase().includes('night'));
    return true;
  });

  return potentialMatch ? 85 : 45;
}

/**
 * Personality match: Lifestyle and preference compatibility
 * Weight: 15%
 */
function calculatePersonalityMatch(caregiver: Caregiver, senior: Senior): number {
  let score = 70; // Base score

  // Language match (very important for many seniors)
  if (senior.languagePreference && caregiver.languages) {
    if (caregiver.languages.some(l => 
      senior.languagePreference?.toLowerCase().includes(l.toLowerCase())
    )) {
      score += 15;
    }
  }

  // Pet compatibility
  if (senior.hasPets && caregiver.petFriendly) {
    score += 10;
  }

  // Gender preference
  if (senior.genderPreference && senior.genderPreference !== 'No Preference') {
    // Note: We'd need caregiver gender in the type
    // For now, assume match if no strong preference
  }

  // Smoking preference
  if (senior.smokingPreference === 'non-smoker' && caregiver.nonSmoker) {
    score += 5;
  }

  return Math.min(100, score);
}

/**
 * Distance score: How close is the caregiver?
 * Weight: 15%
 */
function calculateDistanceScore(caregiver: Caregiver, senior: Senior): number {
  if (!caregiver.distance && !caregiver.latitude) {
    return 60; // Unknown distance
  }

  // Use pre-calculated distance if available
  if (caregiver.distance !== undefined) {
    if (caregiver.distance < 3) return 100;
    if (caregiver.distance < 8) return 90;
    if (caregiver.distance < 15) return 75;
    if (caregiver.distance < 25) return 55;
    return 35;
  }

  // Calculate from coordinates
  if (caregiver.latitude && caregiver.longitude && senior.latitude && senior.longitude) {
    const distance = calculateHaversineDistance(
      senior.latitude, senior.longitude,
      caregiver.latitude, caregiver.longitude
    );
    
    if (distance < 3) return 100;
    if (distance < 8) return 90;
    if (distance < 15) return 75;
    if (distance < 25) return 55;
    return 35;
  }

  return 60;
}

/**
 * Rating score: Quality based on reviews
 * Weight: 10%
 */
function calculateRatingScore(caregiver: Caregiver): number {
  if (!caregiver.rating) return 70; // Default for unrated
  
  // Convert 5-star to 0-100 scale
  return (caregiver.rating / 5) * 100;
}

/**
 * Rebooking rate: Historical performance
 * Weight: Bonus up to 10%
 */
function calculateRebookingRate(caregiverId: string, history?: Appointment[]): number {
  if (!history || history.length === 0) return 50; // No data

  const caregiverHistory = history.filter(h => h.caregiverId === caregiverId);
  if (caregiverHistory.length === 0) return 50;

  // Count how many times this caregiver was rebooked
  const rebookedCount = caregiverHistory.filter(h => h.wasRebooked).length;
  return Math.round((rebookedCount / caregiverHistory.length) * 100);
}

/**
 * Weighted average of all factors
 */
function weightedAverage(factors: MatchFactors): number {
  const weights = {
    skillsMatch: 0.35,
    availabilityMatch: 0.25,
    personalityMatch: 0.15,
    distanceScore: 0.15,
    ratingScore: 0.10
  };

  let total = 0;
  let totalWeight = 0;

  for (const [key, weight] of Object.entries(weights)) {
    const factorKey = key as keyof MatchFactors;
    total += factors[factorKey] * weight;
    totalWeight += weight;
  }

  // Add rebooking as bonus (not part of 100%)
  if (factors.rebookingRate > 50) {
    total += (factors.rebookingRate - 50) * 0.1; // Up to 5 point bonus
  }

  return total / totalWeight;
}

/**
 * Generate human-readable reasoning
 */
function generateReasoning(
  caregiver: Caregiver,
  factors: MatchFactors,
  senior: Senior
): string[] {
  const reasons: string[] = [];

  // Top skills match
  if (factors.skillsMatch >= 80) {
    reasons.push(`Expert in ${senior.needs?.slice(0, 2).join(' and ')}`);
  } else if (factors.skillsMatch >= 60) {
    reasons.push('Experienced with your care needs');
  }

  // Distance
  if (factors.distanceScore >= 90) {
    reasons.push('Lives very nearby');
  } else if (factors.distanceScore >= 75) {
    reasons.push('Short travel distance');
  }

  // Rating
  if (caregiver.rating && caregiver.rating >= 4.8) {
    reasons.push('Top-rated caregiver');
  } else if (caregiver.rating && caregiver.rating >= 4.5) {
    reasons.push('Highly rated by families');
  }

  // Availability
  if (factors.availabilityMatch >= 85) {
    reasons.push('Available when you need care');
  }

  // Rebooking
  if (factors.rebookingRate >= 70) {
    reasons.push('Families rebook often');
  }

  // Personality
  if (factors.personalityMatch >= 80) {
    reasons.push('Great personality fit');
  }

  return reasons.length > 0 ? reasons.slice(0, 3) : ['Verified caregiver'];
}

/**
 * Calculate confidence level in the match
 */
function calculateConfidence(factors: MatchFactors): 'high' | 'medium' | 'low' {
  const unknownFactors = [
    factors.skillsMatch === 50,
    factors.availabilityMatch === 60,
    factors.distanceScore === 60,
    factors.ratingScore === 70
  ].filter(Boolean).length;

  if (unknownFactors === 0) return 'high';
  if (unknownFactors <= 2) return 'medium';
  return 'low';
}

/**
 * Calculate Haversine distance between two points
 */
function calculateHaversineDistance(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  const R = 3959; // Earth's radius in miles
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

/**
 * Sort caregivers by match score
 */
export function sortByMatchScore(
  caregivers: Caregiver[],
  senior: Senior,
  history?: Appointment[]
): { caregiver: Caregiver; score: MatchScore }[] {
  const scored = caregivers.map(caregiver => ({
    caregiver,
    score: calculateMatchScore(caregiver, senior, history)
  }));

  return scored.sort((a, b) => b.score.overallScore - a.score.overallScore);
}

/**
 * Get top N matches
 */
export function getTopMatches(
  caregivers: Caregiver[],
  senior: Senior,
  count: number = 5,
  history?: Appointment[]
): { caregiver: Caregiver; score: MatchScore }[] {
  return sortByMatchScore(caregivers, senior, history).slice(0, count);
}
