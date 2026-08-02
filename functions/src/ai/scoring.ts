import { cosineSimilarity } from "./embeddings";

export interface ScoredMatch {
    caregiverId: string;
    score: number;
    reasons: string[];
    redFlags: string[];
    confidence: "high" | "medium" | "low";
    source: "embedding" | "fallback";
    semanticScore: number;
    hardSkillsScore: number;
    distanceScore: number;
    availabilityScore: number;
    ratingScore: number;
    experienceScore: number;
}

export interface ScoringInput {
    caregiverId: string;
    caregiverEmbedding?: number[] | null;
    clientEmbedding?: number[] | null;
    caregiverSkills: string[];
    clientNeeds: string[];
    distanceMiles?: number;
    availabilityOverlap?: number;
    rating?: number;
    yearsExperience?: number;
    personalBoost?: number;
    // Preference signals
    clientGenderPref?: string;
    caregiverGender?: string;
    clientLanguage?: string;
    caregiverLanguages?: string[];
}

// Critical needs that carry a hard penalty when unmet
const CRITICAL_NEEDS = ["dementia", "hospice", "parkinsons", "parkinson", "alzheimer", "memory care"];

const WEIGHTS = {
    semantic: 40,
    hardSkills: 20,
    distance: 20,
    availability: 10,
    rating: 5,
    experience: 5,
};

// Max boost from feedback history
const MAX_BOOST = 5;

// Distance: 0-5 mi = 1.0, 30+ mi = 0.0
function softDistanceScore(miles: number | undefined): number {
    if (miles === undefined || miles === null) return 0.5;
    if (miles <= 5) return 1;
    if (miles >= 30) return 0;
    return Math.max(0, 1 - (miles - 5) / 25);
}

function availabilityScore(overlap: number | undefined): number {
    if (overlap === undefined || overlap === null) return 0.5;
    return Math.min(1, Math.max(0, overlap));
}

function ratingScore(rating: number | undefined): number {
    if (!rating) return 0.5;
    return Math.min(1, rating / 5);
}

function experienceScore(years: number | undefined): number {
    if (!years) return 0;
    return Math.min(1, years / 10);
}

export function normalizeToken(s: string): string {
    return s
        .toLowerCase()
        .replace(/['']/g, "")
        .replace(/[^a-z0-9 ]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

export const SKILL_ALIASES: Record<string, string[]> = {
    dementia: ["dementia", "memory care", "alzheimers", "alzheimer", "cognitive", "memory impairment"],
    medication: ["medication", "meds", "pill", "medication management"],
    mobility: ["mobility", "transfer", "walking", "ambulation"],
    "meal prep": ["meal", "cooking", "food", "feed", "meal prep", "nutrition"],
    companionship: ["companion", "social", "conversation", "companionship"],
    housekeeping: ["housekeeping", "cleaning", "laundry", "light housekeeping"],
    transportation: ["transport", "driving", "errands", "transportation"],
    "personal care": ["personal care", "bathing", "grooming", "dressing", "adl", "hygiene"],
    hospice: ["hospice", "palliative", "end of life", "end-of-life"],
    parkinsons: ["parkinson", "tremor", "parkinsons"],
    "stroke recovery": ["stroke", "stroke recovery", "hemiplegia"],
    diabetes: ["diabetes", "diabetic", "insulin", "blood sugar"],
    autism: ["autism", "autistic", "asd", "spectrum"],
};

function skillTokens(skill: string): string[] {
    const norm = normalizeToken(skill);
    const hits: string[] = [norm];
    for (const canonical of Object.keys(SKILL_ALIASES)) {
        if (SKILL_ALIASES[canonical].some((alias) => norm.includes(alias))) {
            hits.push(canonical);
        }
    }
    return hits;
}

export function overlappingSkills(
    caregiverSkills: string[],
    clientNeeds: string[]
): string[] {
    if (!caregiverSkills.length || !clientNeeds.length) return [];
    const cgTokens = new Set(caregiverSkills.flatMap(skillTokens));
    const overlaps: string[] = [];
    for (const need of clientNeeds) {
        const needTokens = skillTokens(need);
        if (needTokens.some((t) => cgTokens.has(t))) {
            overlaps.push(need);
        }
    }
    return overlaps;
}

function computeHardSkillsScore(
    caregiverSkills: string[],
    clientNeeds: string[]
): { score: number; missingCritical: string[] } {
    if (!clientNeeds.length) return { score: 1, missingCritical: [] };

    const cgTokens = new Set(caregiverSkills.flatMap(skillTokens));
    let matched = 0;
    const missingCritical: string[] = [];

    for (const need of clientNeeds) {
        const needTokens = skillTokens(need);
        const isMet = needTokens.some(t => cgTokens.has(t));
        if (isMet) {
            matched++;
        } else {
            // Check if this is a critical need
            const norm = normalizeToken(need);
            const isCritical = CRITICAL_NEEDS.some(c => norm.includes(c));
            if (isCritical) {
                missingCritical.push(need);
            }
        }
    }

    const ratio = matched / clientNeeds.length;
    return { score: ratio, missingCritical };
}

export function scoreCaregiver(input: ScoringInput): ScoredMatch {
    const hasEmbeddings =
        Array.isArray(input.caregiverEmbedding) &&
        Array.isArray(input.clientEmbedding) &&
        input.caregiverEmbedding.length > 0 &&
        input.clientEmbedding.length > 0;

    const semantic = hasEmbeddings
        ? Math.max(
              0,
              cosineSimilarity(
                  input.caregiverEmbedding as number[],
                  input.clientEmbedding as number[]
              )
          )
        : 0;

    const dist = softDistanceScore(input.distanceMiles);
    const avail = availabilityScore(input.availabilityOverlap);
    const rate = ratingScore(input.rating);
    const exp = experienceScore(input.yearsExperience);
    const { score: hardSkillsRatio, missingCritical } = computeHardSkillsScore(
        input.caregiverSkills,
        input.clientNeeds
    );

    const semanticPts    = semantic       * WEIGHTS.semantic;
    const hardSkillsPts  = hardSkillsRatio * WEIGHTS.hardSkills;
    const distancePts    = dist            * WEIGHTS.distance;
    const availPts       = avail           * WEIGHTS.availability;
    const ratingPts      = rate            * WEIGHTS.rating;
    const experiencePts  = exp             * WEIGHTS.experience;

    // personalBoost can be negative (rejected caregivers) or positive (previously hired)
    const boostPts = Math.min(MAX_BOOST, Math.max(-5, input.personalBoost || 0));

    // Small preference adjustments (not weighted, flat ±3)
    let prefAdj = 0;
    if (input.clientGenderPref && input.caregiverGender) {
        if (input.clientGenderPref !== "No Preference") {
            prefAdj += input.caregiverGender === input.clientGenderPref ? 3 : -3;
        }
    }
    if (input.clientLanguage && input.caregiverLanguages?.length) {
        const clientLang = normalizeToken(input.clientLanguage);
        const langMatch = input.caregiverLanguages.some(l => normalizeToken(l).includes(clientLang));
        if (langMatch) prefAdj += 3;
    }

    // Apply critical skill penalty AFTER base score
    const criticalPenalty = missingCritical.length * 10;

    const rawTotal = semanticPts + hardSkillsPts + distancePts + availPts + ratingPts + experiencePts + boostPts + prefAdj - criticalPenalty;
    const total = Math.round(Math.min(100, Math.max(0, rawTotal)));

    // Reasons
    const reasons: string[] = [];
    const shared = overlappingSkills(input.caregiverSkills, input.clientNeeds);
    if (shared.length) {
        reasons.push(`Skilled in: ${shared.slice(0, 3).join(", ")}`);
    }
    if (input.distanceMiles !== undefined) {
        if (input.distanceMiles <= 10)
            reasons.push(`Close to you (${Math.round(input.distanceMiles)} mi)`);
        else if (input.distanceMiles <= 25)
            reasons.push(`Within ${Math.round(input.distanceMiles)} miles`);
    }
    if (input.availabilityOverlap !== undefined && input.availabilityOverlap >= 0.75) {
        reasons.push("Available during your care hours");
    } else if (input.availabilityOverlap !== undefined && input.availabilityOverlap >= 0.4) {
        reasons.push("Partial schedule overlap");
    }
    if (input.rating && input.rating >= 4.5) {
        reasons.push(`Highly rated (${input.rating.toFixed(1)}★)`);
    }
    if (input.yearsExperience && input.yearsExperience >= 5) {
        reasons.push(`${input.yearsExperience}+ years of experience`);
    }
    if (boostPts >= 2) {
        reasons.unshift("Family has shown interest before");
    }
    if (!reasons.length) reasons.push("Available caregiver in your area");

    // Red flags
    const redFlags: string[] = [];
    for (const need of missingCritical) {
        redFlags.push(`No ${need} experience listed`);
    }
    if (input.distanceMiles !== undefined && input.distanceMiles > 25) {
        redFlags.push(`${Math.round(input.distanceMiles)} miles away`);
    }
    if (input.rating && input.rating < 4.0) {
        redFlags.push(`Below-average rating (${input.rating.toFixed(1)}★)`);
    }
    if (input.availabilityOverlap !== undefined && input.availabilityOverlap < 0.3) {
        redFlags.push("Limited schedule overlap");
    }

    // Tighter confidence thresholds
    const confidence: "high" | "medium" | "low" =
        total >= 75 ? "high" : total >= 55 ? "medium" : "low";

    return {
        caregiverId: input.caregiverId,
        score: total,
        reasons: reasons.slice(0, 4),
        redFlags,
        confidence,
        source: hasEmbeddings ? "embedding" : "fallback",
        semanticScore: Math.round(semanticPts),
        hardSkillsScore: Math.round(hardSkillsPts),
        distanceScore: Math.round(distancePts),
        availabilityScore: Math.round(availPts),
        ratingScore: Math.round(ratingPts),
        experienceScore: Math.round(experiencePts),
    };
}

interface TimeRange {
    startMin: number;
    endMin: number;
}

const DAY_KEYS = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
];

const TIME_BLOCKS: Record<string, TimeRange> = {
    morning: { startMin: 6 * 60, endMin: 12 * 60 },
    afternoon: { startMin: 12 * 60, endMin: 17 * 60 },
    evening: { startMin: 17 * 60, endMin: 22 * 60 },
    overnight: { startMin: 22 * 60, endMin: 30 * 60 },
};

function hhmmToMin(s: string): number {
    const [h, m] = s.split(":").map((n) => parseInt(n, 10));
    if (isNaN(h)) return 0;
    return h * 60 + (isNaN(m) ? 0 : m);
}

function mergeRanges(ranges: TimeRange[]): TimeRange[] {
    if (!ranges.length) return [];
    const sorted = [...ranges].sort((a, b) => a.startMin - b.startMin);
    const out: TimeRange[] = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
        const last = out[out.length - 1];
        if (sorted[i].startMin <= last.endMin) {
            last.endMin = Math.max(last.endMin, sorted[i].endMin);
        } else {
            out.push(sorted[i]);
        }
    }
    return out;
}

function intersectMinutes(a: TimeRange[], b: TimeRange[]): number {
    let total = 0;
    for (const r1 of a) {
        for (const r2 of b) {
            const start = Math.max(r1.startMin, r2.startMin);
            const end = Math.min(r1.endMin, r2.endMin);
            if (end > start) total += end - start;
        }
    }
    return total;
}

function caregiverDayRanges(
    weeklyAvailability: any,
    day: string
): TimeRange[] {
    if (!weeklyAvailability || typeof weeklyAvailability !== "object") return [];
    const slots = weeklyAvailability[day] || weeklyAvailability[day.toLowerCase()];
    if (!Array.isArray(slots)) return [];
    const ranges: TimeRange[] = [];
    for (const slot of slots) {
        if (!slot?.start || !slot?.end) continue;
        const s = hhmmToMin(String(slot.start));
        const e = hhmmToMin(String(slot.end));
        if (e > s) ranges.push({ startMin: s, endMin: e });
    }
    return mergeRanges(ranges);
}

function clientDayRanges(schedule: any, day: string): TimeRange[] {
    if (!schedule || typeof schedule !== "object") return [];
    const cap = day.charAt(0).toUpperCase() + day.slice(1);
    const blocks = schedule[day] || schedule[day.toLowerCase()] || schedule[cap];
    if (!Array.isArray(blocks)) return [];
    const ranges: TimeRange[] = [];
    for (const id of blocks) {
        const block = TIME_BLOCKS[String(id).toLowerCase()];
        if (block) ranges.push({ ...block });
    }
    return mergeRanges(ranges);
}

export function availabilityOverlap(
    caregiverWeekly: any,
    clientSchedule: any
): number | undefined {
    if (!caregiverWeekly && !clientSchedule) return undefined;

    let clientNeededMin = 0;
    let overlapMin = 0;
    for (const day of DAY_KEYS) {
        const clientRanges = clientDayRanges(clientSchedule, day);
        if (!clientRanges.length) continue;
        for (const r of clientRanges) clientNeededMin += r.endMin - r.startMin;
        const cgRanges = caregiverDayRanges(caregiverWeekly, day);
        if (!cgRanges.length) continue;
        overlapMin += intersectMinutes(clientRanges, cgRanges);
    }
    if (clientNeededMin === 0) return undefined;
    return Math.min(1, overlapMin / clientNeededMin);
}

// ── Childcare scoring (plan 2026-07-22-002 U6 — R34/R45) ────────────────────
//
// A SEPARATE scoring path for childcare candidates. It consumes ONLY the
// approved childcare features listed in CHILDCARE_APPROVED_SCORING_FEATURES:
//   • age-band coverage and service-category coverage (provider capability vs
//     the job's typed child requirement projection — never child data),
//   • distance to the job's APPROXIMATE area,
//   • availability overlap, childcare-specific experience, and the
//     per-vertical childcare rating (U8 reputation projection).
//
// STRUCTURALLY EXCLUDED (R45): cross-vertical hire/pass reputation
// (ai/caregiverReputation senior boost), per-client senior feedback boosts,
// senior ratings, and embeddings built from senior profiles. The input type
// simply has no field for them; scoring.childcare.test.ts pins that unknown
// extra keys (personalBoost, reputationBoost, rating, …) cannot move the score.
//
// scoreCaregiver() above is the SENIOR path and is byte-identical to its
// pre-U6 behavior (characterization-pinned in scoring.childcare.test.ts).

export const CHILDCARE_APPROVED_SCORING_FEATURES = [
    "ageBandCoverage",
    "categoryCoverage",
    "distanceMiles",
    "availabilityOverlap",
    "yearsChildcareExperience",
    "childcareRating",
] as const;

export interface ChildcareScoringInput {
    caregiverId: string;
    /** Age bands the JOB requires (typed projection — bands only, R33). */
    jobAgeBands: string[];
    /** Age bands the provider's childcare vertical profile supports. */
    providerAgeBands: string[];
    /** Enableable service categories the job requires. */
    jobCategories: string[];
    /** Enableable service categories the provider offers. */
    providerServices: string[];
    /** Distance between provider and the job's APPROXIMATE area. */
    distanceMiles?: number;
    /** 0..1 overlap between provider availability and the job schedule. */
    availabilityOverlap?: number;
    /** Childcare-specific experience (vertical profile) — never senior years. */
    yearsChildcareExperience?: number;
    /** Per-vertical childcare rating ONLY (U8 projection) — never senior rating. */
    childcareRating?: number;
}

export interface ChildcareScoredMatch {
    caregiverId: string;
    score: number;
    /** Sanitized, allowlisted explanation strings — no restricted fields. */
    reasons: string[];
    confidence: "high" | "medium" | "low";
    coverageScore: number;
    distanceScore: number;
    availabilityScore: number;
    experienceScore: number;
    ratingScore: number;
}

const CHILDCARE_WEIGHTS = {
    coverage: 40, // age bands + categories (hard-filtered upstream; this grades margin)
    distance: 25,
    availability: 20,
    experience: 10,
    rating: 5,
};

function coverageRatio(required: string[], offered: string[]): number {
    if (!required.length) return 1;
    const have = new Set(offered.map((s) => s.toLowerCase().trim()));
    const met = required.filter((r) => have.has(r.toLowerCase().trim())).length;
    return met / required.length;
}

/**
 * Score an ALREADY hard-eligible childcare candidate (KTD11: eligibility runs
 * before this — scoring never rescues an ineligible provider). Pure.
 */
export function scoreChildcareCandidate(input: ChildcareScoringInput): ChildcareScoredMatch {
    const bandCov = coverageRatio(input.jobAgeBands ?? [], input.providerAgeBands ?? []);
    const catCov = coverageRatio(input.jobCategories ?? [], input.providerServices ?? []);
    const coverage = (bandCov + catCov) / 2;

    const dist = softDistanceScore(input.distanceMiles);
    const avail = availabilityScore(input.availabilityOverlap);
    const exp = experienceScore(input.yearsChildcareExperience);
    const rate = ratingScore(input.childcareRating);

    const coveragePts = coverage * CHILDCARE_WEIGHTS.coverage;
    const distancePts = dist * CHILDCARE_WEIGHTS.distance;
    const availPts = avail * CHILDCARE_WEIGHTS.availability;
    const expPts = exp * CHILDCARE_WEIGHTS.experience;
    const ratingPts = rate * CHILDCARE_WEIGHTS.rating;

    const total = Math.round(
        Math.min(100, Math.max(0, coveragePts + distancePts + availPts + expPts + ratingPts)),
    );

    // R33/R57-safe explanations: fixed allowlisted phrases built ONLY from
    // provider capability + coarse job facts. Never a child fact, never a
    // screening/internal reason.
    const reasons: string[] = [];
    if (bandCov >= 1 && (input.jobAgeBands?.length ?? 0) > 0) {
        reasons.push("Supports all requested age groups");
    }
    if (catCov >= 1 && (input.jobCategories?.length ?? 0) > 0) {
        reasons.push("Offers all requested care types");
    }
    if (input.distanceMiles !== undefined && input.distanceMiles <= 10) {
        reasons.push("Close to the job area");
    }
    if (input.availabilityOverlap !== undefined && input.availabilityOverlap >= 0.75) {
        reasons.push("Available during the requested hours");
    }
    if ((input.yearsChildcareExperience ?? 0) >= 3) {
        reasons.push(`${input.yearsChildcareExperience}+ years of childcare experience`);
    }
    if ((input.childcareRating ?? 0) >= 4.5) {
        reasons.push("Highly rated for childcare");
    }
    if (!reasons.length) reasons.push("Eligible childcare provider in your area");

    const confidence: "high" | "medium" | "low" =
        total >= 75 ? "high" : total >= 55 ? "medium" : "low";

    return {
        caregiverId: input.caregiverId,
        score: total,
        reasons: reasons.slice(0, 4),
        confidence,
        coverageScore: Math.round(coveragePts),
        distanceScore: Math.round(distancePts),
        availabilityScore: Math.round(availPts),
        experienceScore: Math.round(expPts),
        ratingScore: Math.round(ratingPts),
    };
}

export function haversineMiles(
    lat1?: number,
    lon1?: number,
    lat2?: number,
    lon2?: number
): number | undefined {
    if (
        lat1 === undefined ||
        lon1 === undefined ||
        lat2 === undefined ||
        lon2 === undefined
    ) {
        return undefined;
    }
    const R = 3958.8;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) *
            Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}
