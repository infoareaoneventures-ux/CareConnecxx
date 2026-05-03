import { Caregiver, Senior, Appointment, MatchScore } from '../types';

/**
 * ML-Enhanced Match Scoring Service
 * Uses real TensorFlow.js neural network for predictions
 * 
 * Architecture: 50 inputs → 128 → 64 → 32 → 1 output
 * Trained on 15,000 synthetic scenarios
 */

import { getMLTrainingService, MLTrainingService } from './mlTraining';
import { FEATURE_INDICES } from './trainingData';

interface MLFeatures {
  senior_needs_count: number;
  senior_has_dementia: number;
  senior_has_mobility: number;
  senior_needs_medication: number;
  senior_care_hours: number;
  senior_prefers_same_gender: number;
  senior_has_pets: number;
  caregiver_skills_count: number;
  caregiver_has_dementia_care: number;
  caregiver_has_medical_training: number;
  caregiver_experience: number;
  caregiver_rating: number;
  caregiver_hourly_rate: number;
  caregiver_pet_friendly: number;
  caregiver_has_car: number;
  skills_match_ratio: number;
  distance_miles: number;
  schedule_overlap: number;
  language_match: number;
  price_fit: number;
}

interface MLMatchPrediction {
  bookingProbability: number;
  predictedSatisfaction: number;
  rebookingProbability: number;
  overallScore: number;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Extract features for ML model
 */
function extractFeatures(
  caregiver: Caregiver,
  senior: Senior,
  history?: Appointment[]
): MLFeatures {
  const seniorNeeds = senior.needs || [];
  const caregiverSkills = caregiver.skills || [];
  
  // Calculate skills match ratio
  const matchedSkills = seniorNeeds.filter(need => 
    caregiverSkills.some(skill => 
      skill.toLowerCase().includes(need.toLowerCase()) ||
      need.toLowerCase().includes(skill.toLowerCase())
    )
  );
  const skillsMatchRatio = seniorNeeds.length > 0 
    ? matchedSkills.length / seniorNeeds.length 
    : 0;
  
  // Calculate distance
  const distance = calculateDistance(
    senior.latitude, senior.longitude,
    caregiver.latitude, caregiver.longitude
  );
  
  // Calculate schedule overlap
  const seniorSchedule = senior.scheduleNeeded || [];
  const caregiverSchedule = caregiver.availability || {};
  const scheduleOverlap = calculateScheduleOverlap(seniorSchedule, caregiverSchedule);
  
  // Check language match
  const languageMatch = senior.languagePreference && caregiver.languages
    ? caregiver.languages.some(lang => 
        senior.languagePreference?.toLowerCase().includes(lang.toLowerCase())
      )
    : true;
  
  // Price fit (lower rates better for part-time, less important for full-time)
  const careHours = senior.scheduleNeeded?.length * 4 || 20; // Estimate
  const priceFit = caregiver.hourlyRate < 25 || careHours > 15;
  
  return {
    senior_needs_count: seniorNeeds.length,
    senior_has_dementia: seniorNeeds.some(n => n.toLowerCase().includes('dementia')) ? 1 : 0,
    senior_has_mobility: seniorNeeds.some(n => n.toLowerCase().includes('mobility')) ? 1 : 0,
    senior_needs_medication: seniorNeeds.some(n => n.toLowerCase().includes('medication')) ? 1 : 0,
    senior_care_hours: careHours,
    senior_prefers_same_gender: senior.genderPreference && senior.genderPreference !== 'No Preference' ? 1 : 0,
    senior_has_pets: 0, // Not in current type, default to 0
    caregiver_skills_count: caregiverSkills.length,
    caregiver_has_dementia_care: caregiverSkills.some(s => s.toLowerCase().includes('dementia')) ? 1 : 0,
    caregiver_has_medical_training: caregiverSkills.some(s => 
      ['medication', 'cna', 'nurse', 'medical'].some(m => s.toLowerCase().includes(m))
    ) ? 1 : 0,
    caregiver_experience: caregiver.experience ?? 3,
    caregiver_rating: caregiver.rating ?? 4.0,
    caregiver_hourly_rate: caregiver.hourlyRate,
    caregiver_pet_friendly: caregiver.petFriendly ? 1 : 0,
    caregiver_has_car: caregiver.hasTransportation ? 1 : 0,
    skills_match_ratio: skillsMatchRatio,
    distance_miles: distance,
    schedule_overlap: scheduleOverlap,
    language_match: languageMatch ? 1 : 0,
    price_fit: priceFit ? 1 : 0
  };
}

// ML Service instance
let mlService: MLTrainingService | null = null;

/**
 * Initialize ML service
 */
export async function initializeMLService(): Promise<boolean> {
  if (!mlService) {
    mlService = getMLTrainingService();
  }
  return await mlService.initialize();
}

/**
 * Apply REAL ML model scoring using TensorFlow.js
 */
function applyMLModel(features: MLFeatures): MLMatchPrediction {
  // Ensure ML service is initialized
  if (!mlService) {
    mlService = getMLTrainingService();
  }

  // Convert features to vector for neural network
  const featureVector = convertFeaturesToVector(features);
  
  // Get prediction from real ML model
  let overallScore: number;
  
  try {
    if (mlService.isModelReady()) {
      // Use real TensorFlow model
      overallScore = mlService.predict(featureVector);
    } else {
      // Fallback to rules-based if model not ready
      overallScore = calculateRulesBasedScore(features);
    }
  } catch (error) {
    console.warn('[ML Scoring] Model prediction failed, using fallback:', error);
    overallScore = calculateRulesBasedScore(features);
  }
  
  // Calculate additional predictions based on overall score
  const bookingProbability = 1 / (1 + Math.exp(-(overallScore - 60) / 15));
  
  const predictedSatisfaction = Math.min(5, Math.max(1, 
    2 + (overallScore / 100) * 3
  ));
  
  const rebookingProbability = predictedSatisfaction > 3.5 
    ? 0.6 + (predictedSatisfaction - 3.5) * 0.2
    : 0.3;
  
  const confidence = calculateConfidence(features);
  
  return {
    bookingProbability: Math.round(bookingProbability * 100),
    predictedSatisfaction: Math.round(predictedSatisfaction * 10) / 10,
    rebookingProbability: Math.round(rebookingProbability * 100),
    overallScore,
    confidence
  };
}

/**
 * Convert MLFeatures to feature vector for neural network
 */
function convertFeaturesToVector(features: MLFeatures): number[] {
  const vector = new Array(50).fill(0);
  
  // Map MLFeatures to vector indices
  vector[FEATURE_INDICES.SENIOR_NEEDS_COMPANIONSHIP] = features.senior_needs_count > 0 ? 1 : 0;
  vector[FEATURE_INDICES.SENIOR_HAS_DEMENTIA] = features.senior_has_dementia;
  vector[FEATURE_INDICES.SENIOR_HAS_MOBILITY] = features.senior_has_mobility;
  vector[FEATURE_INDICES.SENIOR_NEEDS_MEDICATION] = features.senior_needs_medication;
  vector[FEATURE_INDICES.SENIOR_CARE_HOURS] = features.senior_care_hours / 168;
  vector[FEATURE_INDICES.SENIOR_PREFERS_SAME_GENDER] = features.senior_prefers_same_gender;
  vector[FEATURE_INDICES.SENIOR_HAS_PETS] = features.senior_has_pets;
  
  vector[FEATURE_INDICES.CAREGIVER_SKILLS_COUNT] = features.caregiver_skills_count / 16;
  vector[FEATURE_INDICES.CAREGIVER_HAS_DEMENTIA_CARE] = features.caregiver_has_dementia_care;
  vector[FEATURE_INDICES.CAREGIVER_HAS_MEDICAL_TRAINING] = features.caregiver_has_medical_training;
  vector[FEATURE_INDICES.CAREGIVER_EXPERIENCE] = features.caregiver_experience / 20;
  vector[FEATURE_INDICES.CAREGIVER_RATING] = features.caregiver_rating / 5;
  vector[FEATURE_INDICES.CAREGIVER_HOURLY_RATE] = (features.caregiver_hourly_rate - 18) / 27;
  vector[FEATURE_INDICES.CAREGIVER_PET_FRIENDLY] = features.caregiver_pet_friendly;
  vector[FEATURE_INDICES.CAREGIVER_HAS_CAR] = features.caregiver_has_car;
  
  vector[FEATURE_INDICES.SKILLS_MATCH_RATIO] = features.skills_match_ratio;
  vector[FEATURE_INDICES.DISTANCE_MILES] = Math.min(features.distance_miles / 50, 1);
  vector[FEATURE_INDICES.SCHEDULE_OVERLAP] = features.schedule_overlap / 5;
  vector[FEATURE_INDICES.LANGUAGE_MATCH] = features.language_match;
  vector[FEATURE_INDICES.PRICE_FIT] = features.price_fit;
  
  return vector;
}

/**
 * Fallback rules-based scoring when ML model is not available
 */
function calculateRulesBasedScore(features: MLFeatures): number {
  const weights = {
    skills_match: 0.35,
    distance: 0.15,
    rating: 0.10,
    experience: 0.10,
    schedule: 0.08,
    other: 0.22
  };
  
  const scaledFeatures = {
    skills_match: features.skills_match_ratio,
    distance: Math.max(0, 1 - features.distance_miles / 30),
    rating: features.caregiver_rating / 5,
    experience: Math.min(1, features.caregiver_experience / 10),
    schedule: features.schedule_overlap / 4,
    other: (
      features.language_match * 0.3 +
      features.caregiver_pet_friendly * 0.2 +
      features.caregiver_has_car * 0.2 +
      features.price_fit * 0.3
    )
  };
  
  return Math.round(
    scaledFeatures.skills_match * weights.skills_match * 100 +
    scaledFeatures.distance * weights.distance * 100 +
    scaledFeatures.rating * weights.rating * 100 +
    scaledFeatures.experience * weights.experience * 100 +
    scaledFeatures.schedule * weights.schedule * 100 +
    scaledFeatures.other * weights.other * 100
  );
}

/**
 * Calculate confidence level
 */
function calculateConfidence(features: MLFeatures): 'high' | 'medium' | 'low' {
  // Check for missing or default values
  const missingFactors = [
    features.caregiver_rating === 0,
    features.caregiver_experience === 0,
    features.distance_miles === 0 && features.caregiver_has_car === 0,
    features.skills_match_ratio === 0
  ].filter(Boolean).length;
  
  if (missingFactors === 0) return 'high';
  if (missingFactors <= 2) return 'medium';
  return 'low';
}

/**
 * Calculate match score using ML-enhanced algorithm
 */
export function calculateMLMatchScore(
  caregiver: Caregiver,
  senior: Senior,
  history?: Appointment[]
): MatchScore & { mlPrediction: MLMatchPrediction } {
  // Extract features
  const features = extractFeatures(caregiver, senior, history);
  
  // Apply ML model
  const mlPrediction = applyMLModel(features);
  
  // Generate reasoning
  const reasoning = generateReasoning(caregiver, senior, features, mlPrediction);
  
  return {
    caregiverId: caregiver.id,
    overallScore: mlPrediction.overallScore,
    breakdown: {
      skillsMatch: Math.round(features.skills_match_ratio * 100),
      availabilityMatch: Math.round(features.schedule_overlap / 4 * 100),
      personalityMatch: Math.round((features.language_match * 0.6 + features.caregiver_pet_friendly * 0.4) * 100),
      distanceScore: Math.round(Math.max(0, 1 - features.distance_miles / 30) * 100),
      ratingScore: Math.round(features.caregiver_rating / 5 * 100),
      rebookingRate: mlPrediction.rebookingProbability
    },
    reasoning,
    confidence: mlPrediction.confidence,
    mlPrediction
  };
}

/**
 * Generate human-readable reasoning
 */
function generateReasoning(
  caregiver: Caregiver,
  senior: Senior,
  features: MLFeatures,
  prediction: MLMatchPrediction
): string[] {
  const reasons: string[] = [];
  
  // High-impact reasons
  if (features.skills_match_ratio >= 0.8) {
    const matchedSkill = caregiver.skills?.find(s => 
      senior.needs?.some(n => n.toLowerCase().includes(s.toLowerCase()))
    );
    reasons.push(`Expert in ${matchedSkill || 'needed care'}`);
  }
  
  if (prediction.bookingProbability >= 70) {
    reasons.push(`${prediction.bookingProbability}% likelihood of successful match`);
  }
  
  if (features.distance_miles < 5) {
    reasons.push('Lives very nearby');
  } else if (features.distance_miles < 15) {
    reasons.push('Reasonable travel distance');
  }
  
  if (caregiver.rating && caregiver.rating >= 4.7) {
    reasons.push('Top-rated by families');
  }
  
  if (prediction.rebookingProbability >= 70) {
    reasons.push('High family retention rate');
  }
  
  if (features.caregiver_experience >= 5) {
    reasons.push(`${features.caregiver_experience}+ years experience`);
  }
  
  if (features.language_match) {
    reasons.push('Speaks preferred language');
  }
  
  if (features.schedule_overlap >= 3) {
    reasons.push('Great schedule alignment');
  }
  
  // Limit to top 3
  return reasons.slice(0, 3).length > 0 
    ? reasons.slice(0, 3) 
    : ['Verified caregiver profile'];
}

/**
 * Calculate distance between two points
 */
function calculateDistance(
  lat1?: number, lng1?: number,
  lat2?: number, lng2?: number
): number {
  if (!lat1 || !lng1 || !lat2 || !lng2) return 10; // Default 10 miles
  
  const R = 3959; // Earth's radius in miles
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

/**
 * Calculate schedule overlap
 */
function calculateScheduleOverlap(
  seniorSchedule: string[],
  caregiverAvailability: any
): number {
  if (!seniorSchedule.length) return 2; // Default medium overlap
  
  let overlap = 0;
  const caregiverTimes = Object.keys(caregiverAvailability || {});
  
  for (const time of seniorSchedule) {
    const normalized = time.toLowerCase();
    if (caregiverTimes.some(ct => ct.toLowerCase().includes(normalized))) {
      overlap++;
    }
  }
  
  return overlap;
}

/**
 * Sort caregivers by ML-enhanced match score
 */
export function sortByMLMatchScore(
  caregivers: Caregiver[],
  senior: Senior,
  history?: Appointment[]
): { caregiver: Caregiver; score: MatchScore & { mlPrediction: MLMatchPrediction } }[] {
  const scored = caregivers.map(caregiver => ({
    caregiver,
    score: calculateMLMatchScore(caregiver, senior, history)
  }));
  
  return scored.sort((a, b) => b.score.overallScore - a.score.overallScore);
}

/**
 * Get top N matches with ML predictions
 */
export function getTopMLMatches(
  caregivers: Caregiver[],
  senior: Senior,
  count: number = 5,
  history?: Appointment[]
): { caregiver: Caregiver; score: MatchScore & { mlPrediction: MLMatchPrediction } }[] {
  return sortByMLMatchScore(caregivers, senior, history).slice(0, count);
}

/**
 * Process admin feedback for online learning
 * Call this when admin approves/rejects a match
 */
export async function processMatchFeedback(
  caregiver: Caregiver,
  senior: Senior,
  approved: boolean,
  adminRating?: number,
  context?: any
): Promise<void> {
  if (!mlService) {
    mlService = getMLTrainingService();
    await mlService.initialize();
  }

  // Extract features
  const features = extractFeatures(caregiver, senior, undefined);
  const featureVector = convertFeaturesToVector(features);

  // Prepare feedback for online learning
  const feedback = [{
    seniorFeatures: featureVector.slice(0, 15),
    caregiverFeatures: featureVector.slice(15, 35),
    contextFeatures: featureVector.slice(35, 50),
    approved,
    rating: adminRating
  }];

  // Update model with feedback
  await mlService.learnFromFeedback(feedback);
  
  console.log('[ML Feedback] Model updated with admin feedback:', { approved, rating: adminRating });
}

/**
 * Get current ML model status
 */
export function getMLModelStatus(): {
  isReady: boolean;
  isUsingRealModel: boolean;
  version: string;
} {
  const isReady = mlService?.isModelReady() || false;
  
  return {
    isReady,
    isUsingRealModel: isReady,
    version: isReady ? '1.0.0-tensorflow' : 'fallback-rules'
  };
}

// Fix: Add missing history parameter
let matchHistory: Appointment[] = [];
