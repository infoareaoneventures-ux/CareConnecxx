import { JobPost, Caregiver } from '../types';

export interface JobMatch {
  job: JobPost;
  matchScore: number;
  matchReasons: string[];
}

/**
 * Score a single job against a caregiver's profile.
 * Returns a JobMatch with a 0–100 score and plain-English reasons.
 */
export async function scoreJobForCaregiver(job: JobPost, caregiver: Caregiver): Promise<JobMatch> {
  const reasons: string[] = [];
  let score = 50; // Base score

  // 1. Rate compatibility (30 points max)
  const jobRate = job.rate;
  const myRate = caregiver.hourlyRate;
  if (jobRate >= myRate) {
    score += 30;
    reasons.push('Rate meets your minimum');
  } else if (jobRate >= myRate * 0.9) {
    score += 20;
    reasons.push('Rate is slightly below your rate');
  } else if (jobRate >= myRate * 0.8) {
    score += 10;
    reasons.push('Rate is negotiable');
  } else {
    score -= 10;
    reasons.push('Rate is below your usual rate');
  }

  // 2. Skills match (25 points max)
  const jobSkills = extractSkillsFromJob(job);
  const mySkills = [
    ...(caregiver.skills || []),
    ...(caregiver.medicalSkills || []),
    ...(caregiver.certifications || []),
  ];
  const matchedSkills = jobSkills.filter(skill =>
    mySkills.some(s =>
      s.toLowerCase().includes(skill.toLowerCase()) ||
      skill.toLowerCase().includes(s.toLowerCase())
    )
  );
  if (matchedSkills.length > 0) {
    score += Math.min(matchedSkills.length * 8, 25);
    reasons.push(`Skills match: ${matchedSkills.slice(0, 2).join(', ')}`);
  }

  // 3. Location / distance (20 points max)
  if (caregiver.location && job.location) {
    const cLoc = caregiver.location.toLowerCase();
    const jLoc = job.location.toLowerCase();
    const normalize = (s: string) => s.replace(/[^a-z0-9]/g, '');
    if (jLoc.includes(cLoc) || cLoc.includes(jLoc)) {
      score += 20;
      reasons.push('Location is convenient');
    } else if (normalize(jLoc) === normalize(cLoc)) {
      score += 15;
      reasons.push('Location is a close match');
    } else {
      const cWords = cLoc.split(/[\s,]+/).filter(w => w.length > 2);
      const jWords = jLoc.split(/[\s,]+/).filter(w => w.length > 2);
      if (cWords.some(w => jWords.includes(w))) {
        score += 10;
        reasons.push('Location might be nearby');
      }
    }
  }

  // 4. Experience bonus (15 points max)
  if ((caregiver.experience || 0) >= 5) {
    score += 15;
    reasons.push('Your experience is a great fit');
  } else if ((caregiver.experience || 0) >= 2) {
    score += 10;
    reasons.push('Good experience match');
  }

  // 5. Verification bonus (10 points)
  if (caregiver.verified) {
    score += 10;
    reasons.push('Your verification helps');
  }

  return {
    job,
    matchScore: Math.min(100, Math.max(0, score)),
    matchReasons: reasons,
  };
}

/**
 * Extract relevant skill keywords from a job posting's title + description.
 */
export function extractSkillsFromJob(job: JobPost): string[] {
  const skills: string[] = [];
  const text = `${job.title} ${job.description}`.toLowerCase();

  const SKILL_KEYWORDS: Record<string, string[]> = {
    'driving':           ['drive', 'driver', 'transportation', 'car', 'vehicle'],
    'meal preparation':  ['meal', 'cook', 'cooking', 'food', 'kitchen'],
    'medical assistance':['medical', 'medication', 'medicine', 'health'],
    'mobility support':  ['mobility', 'transfer', 'hoyer', 'lift', 'wheelchair'],
    'personal care':     ['bathing', 'grooming', 'hygiene', 'toileting'],
    'dementia care':     ['dementia', 'alzheimer', 'memory', 'confusion'],
    'companionship':     ['companion', 'social', 'conversation', 'company'],
    'overnight care':    ['overnight', 'night', 'sleep', '24-hour'],
  };

  for (const [skill, keywords] of Object.entries(SKILL_KEYWORDS)) {
    if (keywords.some(k => text.includes(k))) skills.push(skill);
  }
  return skills;
}
