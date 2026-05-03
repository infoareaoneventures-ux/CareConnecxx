import { Caregiver, Senior } from '../types';

/**
 * Synthetic Training Data Generator
 * Generates 15,000 realistic caregiver-senior match scenarios
 * for training the neural network
 */

export interface TrainingSample {
  features: number[];
  label: number; // Match score 0-100
  metadata: {
    seniorId: string;
    caregiverId: string;
    scenario: string;
  };
}

// Feature indices for clarity
export const FEATURE_INDICES = {
  // Senior features (0-14)
  SENIOR_AGE: 0,
  SENIOR_HAS_DEMENTIA: 1,
  SENIOR_HAS_MOBILITY: 2,
  SENIOR_NEEDS_MEDICATION: 3,
  SENIOR_NEEDS_MEAL_PREP: 4,
  SENIOR_NEEDS_TRANSPORT: 5,
  SENIOR_NEEDS_HOUSEKEEPING: 6,
  SENIOR_NEEDS_COMPANIONSHIP: 7,
  SENIOR_NEEDS_BATHING: 8,
  SENIOR_NEEDS_OVERNIGHT: 9,
  SENIOR_CARE_HOURS: 10,
  SENIOR_PREFERS_SAME_GENDER: 11,
  SENIOR_HAS_PETS: 12,
  SENIOR_PERSONALITY_EXTRAVERT: 13,
  SENIOR_PERSONALITY_INTROVERT: 14,

  // Caregiver features (15-34)
  CAREGIVER_AGE: 15,
  CAREGIVER_EXPERIENCE: 16,
  CAREGIVER_RATING: 17,
  CAREGIVER_HOURLY_RATE: 18,
  CAREGIVER_HAS_DEMENTIA_CARE: 19,
  CAREGIVER_HAS_MEDICAL_TRAINING: 20,
  CAREGIVER_HAS_CNA: 21,
  CAREGIVER_HAS_LVN: 22,
  CAREGIVER_HAS_RN: 23,
  CAREGIVER_PET_FRIENDLY: 24,
  CAREGIVER_HAS_CAR: 25,
  CAREGIVER_SPEAKS_SPANISH: 26,
  CAREGIVER_SPEAKS_MANDARIN: 27,
  CAREGIVER_SPEAKS_TAGALOG: 28,
  CAREGIVER_SKILLS_COUNT: 29,
  CAREGIVER_PERSONALITY_CALM: 30,
  CAREGIVER_PERSONALITY_ENERGETIC: 31,
  CAREGIVER_PERSONALITY_PATIENT: 32,
  CAREGIVER_PERSONALITY_CHATTY: 33,
  CAREGIVER_CERTIFICATIONS: 34,

  // Context features (35-49)
  SKILLS_MATCH_RATIO: 35,
  DISTANCE_MILES: 36,
  SCHEDULE_OVERLAP: 37,
  LANGUAGE_MATCH: 38,
  PRICE_FIT: 39,
  URGENCY_LEVEL: 40,
  TIME_OF_DAY_MORNING: 41,
  TIME_OF_DAY_AFTERNOON: 42,
  TIME_OF_DAY_EVENING: 43,
  TIME_OF_DAY_NIGHT: 44,
  DAY_WEEKDAY: 45,
  DAY_WEEKEND: 46,
  PREVIOUS_MATCH: 47,
  PREVIOUS_RATING: 48,
  SEASONAL_FACTOR: 49
} as const;

const NEEDS_LIST = [
  'dementia', 'mobility', 'medication', 'meal_prep', 'transportation',
  'housekeeping', 'companionship', 'bathing', 'overnight'
];

const SKILLS_LIST = [
  'dementia_care', 'mobility_assistance', 'medication_management', 'meal_prep',
  'transportation', 'housekeeping', 'companionship', 'bathing_assistance',
  'overnight_care', 'cna_certified', 'lvn_licensed', 'rn_licensed',
  'first_aid', 'cpr_certified', 'parkinsons_care', 'alzheimers_care'
];

const LOCATIONS = ['Downtown', 'Suburb North', 'Suburb South', 'East Bay', 'Peninsula', 'Westside'];
const PERSONALITY_TAGS = ['Calm', 'Energetic', 'Patient', 'Chatty', 'Professional', 'Warm'];

/**
 * Generate random number in range
 */
function random(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

/**
 * Generate random integer in range
 */
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Pick random items from array
 */
function pickRandom<T>(arr: T[], count: number): T[] {
  const shuffled = [...arr].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count);
}

/**
 * Pick one random item
 */
function pickOne<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Calculate match score based on realistic rules
 * This simulates how real matches would be rated
 */
function calculateRealisticMatchScore(
  seniorNeeds: string[],
  caregiverSkills: string[],
  senior: any,
  caregiver: any,
  context: any
): number {
  let score = 50; // Base score

  // Skills match (most important - up to 40 points)
  const matchedSkills = seniorNeeds.filter(need =>
    caregiverSkills.some(skill =>
      skill.toLowerCase().includes(need.toLowerCase()) ||
      need.toLowerCase().includes(skill.toLowerCase())
    )
  );
  const skillsMatchRatio = seniorNeeds.length > 0 ? matchedSkills.length / seniorNeeds.length : 0.5;
  score += skillsMatchRatio * 40;

  // Distance penalty (up to -15 points)
  const distance = context.distance || random(1, 30);
  if (distance < 5) score += 10;
  else if (distance < 10) score += 5;
  else if (distance < 20) score += 0;
  else score -= 10;

  // Rating bonus (up to 15 points)
  const rating = caregiver.rating || 4;
  score += (rating - 3) * 7.5;

  // Experience bonus (up to 10 points)
  const experience = caregiver.experience || 3;
  score += Math.min(experience * 2, 10);

  // Schedule overlap (up to 10 points)
  const scheduleOverlap = context.scheduleOverlap || randomInt(1, 5);
  score += (scheduleOverlap / 5) * 10;

  // Language match (up to 5 points)
  if (context.languageMatch) score += 5;

  // Price fit (up to 5 points)
  if (context.priceFit) score += 5;

  // Personality compatibility
  if (senior.personality === 'Introvert' && caregiver.personalityTags?.includes('Calm')) {
    score += 3;
  }
  if (senior.personality === 'Extrovert' && caregiver.personalityTags?.includes('Chatty')) {
    score += 3;
  }

  // Dementia care match
  if (seniorNeeds.includes('dementia') && caregiverSkills.includes('dementia_care')) {
    score += 5;
  }

  // Urgency bonus for good matches
  if (context.urgency === 'high' && score > 70) {
    score += 3;
  }

  // Clamp to 0-100
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Generate a single synthetic training sample
 */
function generateSample(index: number): TrainingSample {
  // Generate senior profile
  const seniorAge = randomInt(65, 95);
  const numNeeds = randomInt(1, 5);
  const seniorNeeds = pickRandom(NEEDS_LIST, numNeeds);
  const seniorPersonality = pickOne(['Introvert', 'Extrovert', 'Neutral']);
  const seniorLocation = pickOne(LOCATIONS);
  const seniorGender = pickOne(['Male', 'Female']);
  const seniorPrefersSameGender = Math.random() < 0.3;
  const seniorHasPets = Math.random() < 0.4;

  // Generate caregiver profile
  const caregiverAge = randomInt(25, 70);
  const caregiverExperience = randomInt(0, 20);
  const caregiverRating = random(3.0, 5.0);
  const caregiverHourlyRate = random(18, 45);
  const numSkills = randomInt(2, 8);
  const caregiverSkills = pickRandom(SKILLS_LIST, numSkills);
  const caregiverLocation = pickOne(LOCATIONS);
  const caregiverGender = pickOne(['Male', 'Female']);
  const caregiverLanguages = pickRandom(['English', 'Spanish', 'Mandarin', 'Tagalog', 'Korean'], randomInt(1, 3));

  // Generate context
  const distance = random(0.5, 40);
  const scheduleOverlap = randomInt(0, 5);
  const languageMatch = Math.random() < 0.8;
  const priceFit = caregiverHourlyRate < 30 || Math.random() < 0.6;
  const urgency = pickOne(['low', 'medium', 'high']);

  // Create feature vector (50 features)
  const features: number[] = new Array(50).fill(0);

  // Senior features (0-14)
  features[FEATURE_INDICES.SENIOR_AGE] = (seniorAge - 65) / 30; // Normalize 0-1
  features[FEATURE_INDICES.SENIOR_HAS_DEMENTIA] = seniorNeeds.includes('dementia') ? 1 : 0;
  features[FEATURE_INDICES.SENIOR_HAS_MOBILITY] = seniorNeeds.includes('mobility') ? 1 : 0;
  features[FEATURE_INDICES.SENIOR_NEEDS_MEDICATION] = seniorNeeds.includes('medication') ? 1 : 0;
  features[FEATURE_INDICES.SENIOR_NEEDS_MEAL_PREP] = seniorNeeds.includes('meal_prep') ? 1 : 0;
  features[FEATURE_INDICES.SENIOR_NEEDS_TRANSPORT] = seniorNeeds.includes('transportation') ? 1 : 0;
  features[FEATURE_INDICES.SENIOR_NEEDS_HOUSEKEEPING] = seniorNeeds.includes('housekeeping') ? 1 : 0;
  features[FEATURE_INDICES.SENIOR_NEEDS_COMPANIONSHIP] = seniorNeeds.includes('companionship') ? 1 : 0;
  features[FEATURE_INDICES.SENIOR_NEEDS_BATHING] = seniorNeeds.includes('bathing') ? 1 : 0;
  features[FEATURE_INDICES.SENIOR_NEEDS_OVERNIGHT] = seniorNeeds.includes('overnight') ? 1 : 0;
  features[FEATURE_INDICES.SENIOR_CARE_HOURS] = random(10, 168) / 168; // Normalize
  features[FEATURE_INDICES.SENIOR_PREFERS_SAME_GENDER] = seniorPrefersSameGender ? 1 : 0;
  features[FEATURE_INDICES.SENIOR_HAS_PETS] = seniorHasPets ? 1 : 0;
  features[FEATURE_INDICES.SENIOR_PERSONALITY_EXTRAVERT] = seniorPersonality === 'Extrovert' ? 1 : 0;
  features[FEATURE_INDICES.SENIOR_PERSONALITY_INTROVERT] = seniorPersonality === 'Introvert' ? 1 : 0;

  // Caregiver features (15-34)
  features[FEATURE_INDICES.CAREGIVER_AGE] = (caregiverAge - 25) / 45;
  features[FEATURE_INDICES.CAREGIVER_EXPERIENCE] = caregiverExperience / 20;
  features[FEATURE_INDICES.CAREGIVER_RATING] = caregiverRating / 5;
  features[FEATURE_INDICES.CAREGIVER_HOURLY_RATE] = (caregiverHourlyRate - 18) / 27;
  features[FEATURE_INDICES.CAREGIVER_HAS_DEMENTIA_CARE] = caregiverSkills.includes('dementia_care') ? 1 : 0;
  features[FEATURE_INDICES.CAREGIVER_HAS_MEDICAL_TRAINING] = caregiverSkills.some(s =>
    ['medication_management', 'cna_certified', 'lvn_licensed', 'rn_licensed'].includes(s)
  ) ? 1 : 0;
  features[FEATURE_INDICES.CAREGIVER_HAS_CNA] = caregiverSkills.includes('cna_certified') ? 1 : 0;
  features[FEATURE_INDICES.CAREGIVER_HAS_LVN] = caregiverSkills.includes('lvn_licensed') ? 1 : 0;
  features[FEATURE_INDICES.CAREGIVER_HAS_RN] = caregiverSkills.includes('rn_licensed') ? 1 : 0;
  features[FEATURE_INDICES.CAREGIVER_PET_FRIENDLY] = Math.random() < 0.8 ? 1 : 0;
  features[FEATURE_INDICES.CAREGIVER_HAS_CAR] = Math.random() < 0.7 ? 1 : 0;
  features[FEATURE_INDICES.CAREGIVER_SPEAKS_SPANISH] = caregiverLanguages.includes('Spanish') ? 1 : 0;
  features[FEATURE_INDICES.CAREGIVER_SPEAKS_MANDARIN] = caregiverLanguages.includes('Mandarin') ? 1 : 0;
  features[FEATURE_INDICES.CAREGIVER_SPEAKS_TAGALOG] = caregiverLanguages.includes('Tagalog') ? 1 : 0;
  features[FEATURE_INDICES.CAREGIVER_SKILLS_COUNT] = numSkills / SKILLS_LIST.length;
  
  const caregiverPersonality = pickOne(PERSONALITY_TAGS);
  features[FEATURE_INDICES.CAREGIVER_PERSONALITY_CALM] = caregiverPersonality === 'Calm' ? 1 : 0;
  features[FEATURE_INDICES.CAREGIVER_PERSONALITY_ENERGETIC] = caregiverPersonality === 'Energetic' ? 1 : 0;
  features[FEATURE_INDICES.CAREGIVER_PERSONALITY_PATIENT] = caregiverPersonality === 'Patient' ? 1 : 0;
  features[FEATURE_INDICES.CAREGIVER_PERSONALITY_CHATTY] = caregiverPersonality === 'Chatty' ? 1 : 0;
  
  const numCerts = caregiverSkills.filter(s =>
    ['cna_certified', 'lvn_licensed', 'rn_licensed', 'first_aid', 'cpr_certified'].includes(s)
  ).length;
  features[FEATURE_INDICES.CAREGIVER_CERTIFICATIONS] = numCerts / 5;

  // Context features (35-49)
  features[FEATURE_INDICES.SKILLS_MATCH_RATIO] = seniorNeeds.filter(n =>
    caregiverSkills.some(s => s.toLowerCase().includes(n.toLowerCase()))
  ).length / Math.max(seniorNeeds.length, 1);
  features[FEATURE_INDICES.DISTANCE_MILES] = Math.min(distance / 50, 1);
  features[FEATURE_INDICES.SCHEDULE_OVERLAP] = scheduleOverlap / 5;
  features[FEATURE_INDICES.LANGUAGE_MATCH] = languageMatch ? 1 : 0;
  features[FEATURE_INDICES.PRICE_FIT] = priceFit ? 1 : 0;
  features[FEATURE_INDICES.URGENCY_LEVEL] = urgency === 'high' ? 1 : urgency === 'medium' ? 0.5 : 0;
  
  const timeOfDay = pickOne(['morning', 'afternoon', 'evening', 'night']);
  features[FEATURE_INDICES.TIME_OF_DAY_MORNING] = timeOfDay === 'morning' ? 1 : 0;
  features[FEATURE_INDICES.TIME_OF_DAY_AFTERNOON] = timeOfDay === 'afternoon' ? 1 : 0;
  features[FEATURE_INDICES.TIME_OF_DAY_EVENING] = timeOfDay === 'evening' ? 1 : 0;
  features[FEATURE_INDICES.TIME_OF_DAY_NIGHT] = timeOfDay === 'night' ? 1 : 0;
  
  const dayType = pickOne(['weekday', 'weekend']);
  features[FEATURE_INDICES.DAY_WEEKDAY] = dayType === 'weekday' ? 1 : 0;
  features[FEATURE_INDICES.DAY_WEEKEND] = dayType === 'weekend' ? 1 : 0;
  
  features[FEATURE_INDICES.PREVIOUS_MATCH] = Math.random() < 0.2 ? 1 : 0;
  features[FEATURE_INDICES.PREVIOUS_RATING] = features[FEATURE_INDICES.PREVIOUS_MATCH] ? random(3, 5) / 5 : 0;
  features[FEATURE_INDICES.SEASONAL_FACTOR] = random(0.8, 1.2) / 1.2;

  // Calculate realistic label
  const label = calculateRealisticMatchScore(
    seniorNeeds,
    caregiverSkills,
    { age: seniorAge, personality: seniorPersonality },
    { experience: caregiverExperience, rating: caregiverRating },
    { distance, scheduleOverlap, languageMatch, priceFit, urgency }
  );

  return {
    features,
    label,
    metadata: {
      seniorId: `senior_${index}`,
      caregiverId: `caregiver_${index}`,
      scenario: `${seniorNeeds.length} needs, ${caregiverSkills.length} skills, ${Math.round(distance)}mi`
    }
  };
}

/**
 * Generate all 15,000 training samples
 */
export function generateTrainingData(count: number = 15000): TrainingSample[] {
  console.log(`[Training Data] Generating ${count} synthetic training samples...`);
  
  const samples: TrainingSample[] = [];
  
  for (let i = 0; i < count; i++) {
    samples.push(generateSample(i));
    
    if ((i + 1) % 5000 === 0) {
      console.log(`[Training Data] Generated ${i + 1}/${count} samples...`);
    }
  }

  // Log distribution
  const scoreRanges = {
    '0-20': 0, '21-40': 0, '41-60': 0, '61-80': 0, '81-100': 0
  };
  samples.forEach(s => {
    if (s.label <= 20) scoreRanges['0-20']++;
    else if (s.label <= 40) scoreRanges['21-40']++;
    else if (s.label <= 60) scoreRanges['41-60']++;
    else if (s.label <= 80) scoreRanges['61-80']++;
    else scoreRanges['81-100']++;
  });

  console.log('[Training Data] Distribution:', scoreRanges);
  console.log(`[Training Data] Generated ${samples.length} samples successfully`);

  return samples;
}

/**
 * Split data into training and validation sets
 */
export function splitData(
  samples: TrainingSample[],
  trainRatio: number = 0.8
): { train: TrainingSample[]; validation: TrainingSample[] } {
  const shuffled = [...samples].sort(() => 0.5 - Math.random());
  const splitIndex = Math.floor(shuffled.length * trainRatio);
  
  return {
    train: shuffled.slice(0, splitIndex),
    validation: shuffled.slice(splitIndex)
  };
}

/**
 * Export data for TensorFlow
 */
export function exportForTensorFlow(samples: TrainingSample[]): {
  features: number[][];
  labels: number[];
} {
  return {
    features: samples.map(s => s.features),
    labels: samples.map(s => s.label / 100) // Normalize to 0-1
  };
}

/**
 * Pre-exported 15,000 samples for immediate use
 */
export const TRAINING_DATA_15K = generateTrainingData(15000);

/**
 * Get pre-generated training data
 */
export function getTrainingData(): TrainingSample[] {
  return TRAINING_DATA_15K;
}

// Statistics
export const TRAINING_STATS = {
  totalSamples: 15000,
  features: 50,
  trainSplit: 0.8,
  validationSplit: 0.2,
  generatedAt: new Date().toISOString()
};
