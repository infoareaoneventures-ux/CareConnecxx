// Heuristic-based predictive matching (v1.0)

export interface PredictiveFactors {
  successProbability: number;
  similarSeniorsScore: number;
  acceptanceLikelihood: number;
  retentionProbability: number;
  factors: string[];
  retentionScore?: number;
  acceptanceProbability?: number;
  confidence?: number;
}

export async function getPredictiveFactors(
  caregiver: any,
  senior: any,
  date?: string,
  time?: string
): Promise<PredictiveFactors> {
  let score = 50; // Base score
  const factors: string[] = [];
  
  // 1. Experience vs Needs
  const needs = senior?.needs || [];
  const skills = caregiver?.skills || [];
  let matchingSkills = 0;
  needs.forEach((need: string) => {
      if (skills.some((skill: string) => skill.toLowerCase().includes(need.toLowerCase()))) {
          matchingSkills++;
      }
  });

  if (needs.length > 0 && matchingSkills >= needs.length / 2) {
      score += 15;
      factors.push('Strong overlap with requested care needs');
  } else if (needs.length > 0) {
      score -= 10;
      factors.push('Missing some specific requested skills');
  }

  // 2. Experience level
  if ((caregiver?.yearsExperience || 0) > 3) {
      score += 10;
      factors.push('High overall experience level');
  }

  // 3. Ratings
  if ((caregiver?.rating || 0) >= 4.8) {
      score += 15;
      factors.push('Exceptional community rating');
  } else if ((caregiver?.rating || 0) < 4.0) {
      score -= 10;
      factors.push('Lower community rating');
  }

  // Cap scores between 0 and 100
  score = Math.max(0, Math.min(100, score));

  return {
    successProbability: score,
    similarSeniorsScore: score - 5, // Approximate
    acceptanceLikelihood: 85, // Placeholder for historical acceptance rate
    retentionProbability: score + 5, // Approximate
    factors: factors.length > 0 ? factors : ['Meets basic requirements']
  };
}

export async function getBatchPredictiveFactors(
  caregivers: any[],
  senior: any,
  date?: string,
  time?: string
): Promise<Map<string, PredictiveFactors>> {
  const result = new Map<string, PredictiveFactors>();
  for (const cg of caregivers) {
      result.set(cg.id, await getPredictiveFactors(cg, senior, date, time));
  }
  return result;
}

export function generatePredictiveReasoning(
  factors: PredictiveFactors,
  caregiverName: string
): string {
  if (factors.factors.length === 0) return `${caregiverName} meets the basic requirements for this care request.`;
  return `${caregiverName} was highlighted due to: ${factors.factors.join(', ')}. Estimated match quality is ${factors.successProbability}%.`;
}
