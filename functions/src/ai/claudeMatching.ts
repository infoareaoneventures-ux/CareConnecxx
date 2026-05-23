import { getSharedClient } from "../utils/claudeClient";

/**
 * Shared Claude-powered scoring engine.
 * Used by both runAiMatching (coordinator-triggered batch)
 * and runMatchingForClient (Cara SMS matching flow).
 */

const BASE_DOMAIN_KNOWLEDGE = `You are an expert home care coordinator matching caregivers to seniors. Score each candidate on how well they fit the senior's specific needs.

DOMAIN KNOWLEDGE (distilled from 15,000 validated matching scenarios):
- CRITICAL: Dementia / Alzheimer's / memory care needs → caregiver MUST have dementia care certification. Without it: major red flag, cap overall score at 45.
- CRITICAL: Medical needs (medication management, wound care, catheter care, feeding tube) → requires CNA, LVN, or RN credential. Without it: cap score at 50.
- Skills coverage below 50%: overall score must not exceed 55 regardless of other signals.
- Schedule overlap below 30%: disqualifying — score below 40.
- Distance ≤ 5 miles: strong reliability signal.
- Distance > 20 miles: schedule reliability risk, factor down.
- Rating ≥ 4.5 with ≥ 10 reviews: strong quality signal.
- Experience ≥ 3 years for complex care (dementia, medical, mobility): important positive signal.
- Personality match: calm/patient caregiver + anxious or dementia senior; energetic/chatty caregiver + companionship-focused or extrovert senior.
- Language match when family specified preference: strong positive signal (+8–12 pts).
- Verified caregiver status: meaningful trust signal.
- Retention rate ≥ 75%: families rebook — reliable long-term fit.
- Prior positive feedback (hired before): strong positive signal. Prior rejection: strong negative signal.

Return ONLY a valid JSON array — no markdown fences, no explanation outside the JSON.
Each element: { "caregiverId": "...", "overallScore": 0-100, "confidence": "high|medium|low", "reasoning": ["...", "...", "..."], "redFlags": ["..."], "factors": { "skillsMatch": 0-100, "availability": 0-100, "distance": 0-100, "experience": 0-100, "personalityFit": 0-100, "languageMatch": 0-100 } }`;

export function buildMatchingSystemPrompt(outcomePatterns: string): string {
  if (!outcomePatterns) return BASE_DOMAIN_KNOWLEDGE;
  return `${BASE_DOMAIN_KNOWLEDGE}\n\nREAL PLATFORM DATA — weight these patterns when scoring:\n${outcomePatterns}`;
}

export interface ClaudeScoredMatch {
  caregiverId: string;
  overallScore: number;
  confidence: "high" | "medium" | "low";
  reasoning: string[];
  redFlags: string[];
  factors: {
    skillsMatch: number;
    availability: number;
    distance: number;
    experience: number;
    personalityFit: number;
    languageMatch: number;
  };
}

export interface CandidateSignals {
  caregiverId: string;
  name: string;
  distanceMiles?: number;
  skillsCoveragePercent?: number;
  scheduleOverlapPercent?: number;
  rating?: number;
  reviewCount?: number;
  yearsExperience?: number;
  isVerified?: boolean;
  certifications?: string[];
  languages?: string[];
  personalityTags?: string[];
  hourlyRate?: number;
  reliabilityScore?: number;
  retentionRate?: number;
  hasDementiaCert?: boolean;
  hasMedicalCred?: boolean;
  feedbackSummary?: string;
  // Extra context from rule-based pre-scorer
  ruleScore?: number;
}

export interface SeniorContext {
  needs: string[];
  adls?: string[];
  personality?: string;
  genderPreference?: string;
  languagePreference?: string;
  hasPets?: boolean;
  scheduleNeeded?: string[];
  name?: string;
  age?: number;
}

function stripFences(text: string): string {
  return text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "");
}

/**
 * Score a batch of candidates against a senior profile using Claude Sonnet.
 * Returns a map of caregiverId → ClaudeScoredMatch.
 * Throws on API failure so callers can fall back to rule-based scoring.
 */
export async function scoreWithClaude(
  candidates: CandidateSignals[],
  senior: SeniorContext,
  systemPrompt: string,
  maxTokens = 4000
): Promise<Map<string, ClaudeScoredMatch>> {
  if (candidates.length === 0) return new Map();

  const userMessage = `Score these candidates for the senior profile:\n${JSON.stringify({
    seniorProfile: senior,
    candidates,
  })}`;

  const response = await getSharedClient().messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  const text = (response.content[0] as { text: string }).text ?? "";
  const parsed: any[] = JSON.parse(stripFences(text));

  const resultMap = new Map<string, ClaudeScoredMatch>();
  for (const item of parsed) {
    if (!item.caregiverId) continue;
    const score = Math.max(0, Math.min(100, Math.round(Number(item.overallScore) || 50)));
    const confidence: "high" | "medium" | "low" =
      ["high", "medium", "low"].includes(item.confidence)
        ? item.confidence
        : score >= 80 ? "high" : score >= 60 ? "medium" : "low";
    const f = item.factors ?? {};
    resultMap.set(item.caregiverId, {
      caregiverId: item.caregiverId,
      overallScore: score,
      confidence,
      reasoning: Array.isArray(item.reasoning) ? item.reasoning.slice(0, 4) : [],
      redFlags: Array.isArray(item.redFlags) ? item.redFlags : [],
      factors: {
        skillsMatch:    Math.max(0, Math.min(100, Math.round(Number(f.skillsMatch)    || 50))),
        availability:   Math.max(0, Math.min(100, Math.round(Number(f.availability)   || 50))),
        distance:       Math.max(0, Math.min(100, Math.round(Number(f.distance)       || 50))),
        experience:     Math.max(0, Math.min(100, Math.round(Number(f.experience)     || 50))),
        personalityFit: Math.max(0, Math.min(100, Math.round(Number(f.personalityFit) || 50))),
        languageMatch:  Math.max(0, Math.min(100, Math.round(Number(f.languageMatch)  || 50))),
      },
    });
  }
  return resultMap;
}

/** Compute whether a skill list covers a list of care needs (0-100). */
export function computeSkillsCoverage(skills: string[], needs: string[]): number {
  if (!needs.length) return 70;
  if (!skills.length) return 0;
  const matched = needs.filter(n =>
    skills.some(s =>
      s.toLowerCase().includes(n.toLowerCase()) ||
      n.toLowerCase().includes(s.toLowerCase())
    )
  ).length;
  return Math.round((matched / needs.length) * 100);
}

/** Check whether any skill indicates dementia care certification. */
export function detectDementiaCert(skills: string[]): boolean {
  return skills.some(s =>
    /dementia|alzheimer|memory care/i.test(s)
  );
}

/** Check whether any skill indicates a medical credential (CNA/LVN/RN). */
export function detectMedicalCred(skills: string[]): boolean {
  return skills.some(s => /\bcna\b|\blvn\b|\brn\b|nurse/i.test(s));
}
