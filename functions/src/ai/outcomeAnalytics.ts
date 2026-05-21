import * as admin from "firebase-admin";

/**
 * Queries real hire/pass outcomes from Firestore and computes platform-wide
 * pattern statistics. These patterns are injected into Claude's matching prompt
 * so it has evidence from actual results on this platform — not just generic rules.
 *
 * Cache: 1 hour in-memory. Computed on first use, refreshed hourly.
 */

interface OutcomeCache {
  summary: string;
  generatedAt: number;
}

let _cache: OutcomeCache | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000;

interface CaregiverProfile {
  certifications?: string[];
  medicalSkills?: string[];
  skills?: string[];
  rating?: number;
  experience?: number;
  yearsExperience?: number;
  latitude?: number;
  longitude?: number;
}

function hasDementiaCert(profile: CaregiverProfile): boolean {
  const all = [
    ...(profile.certifications ?? []),
    ...(profile.medicalSkills ?? []),
    ...(profile.skills ?? []),
  ].map(s => s.toLowerCase());
  return all.some(s => s.includes("dementia") || s.includes("alzheimer") || s.includes("memory care"));
}

function hasMedicalCred(profile: CaregiverProfile): boolean {
  const all = [
    ...(profile.certifications ?? []),
    ...(profile.medicalSkills ?? []),
  ].map(s => s.toLowerCase());
  return all.some(s => s.includes("cna") || s.includes("lvn") || s.includes("rn") || s.includes("nurse"));
}

function ratingBand(rating?: number): "top" | "good" | "low" | "unknown" {
  if (!rating) return "unknown";
  if (rating >= 4.8) return "top";
  if (rating >= 4.5) return "good";
  return "low";
}

function expBand(exp?: number): "senior" | "mid" | "junior" {
  const years = exp ?? 0;
  if (years >= 5) return "senior";
  if (years >= 3) return "mid";
  return "junior";
}

function pct(num: number, denom: number): number {
  if (denom === 0) return 0;
  return Math.round((num / denom) * 100);
}

function fmt(label: string, hired: number, total: number): string {
  if (total < 3) return "";
  return `${label}: ${pct(hired, total)}% hired (${total} matches)`;
}

export async function getOutcomePatternSummary(
  db: FirebaseFirestore.Firestore
): Promise<string> {
  if (_cache && Date.now() - _cache.generatedAt < CACHE_TTL_MS) {
    return _cache.summary;
  }

  try {
    // Query last 400 match outcomes
    const outcomesSnap = await db
      .collection("match_outcomes")
      .orderBy("timestamp", "desc")
      .limit(400)
      .get();

    if (outcomesSnap.empty) {
      return ""; // No data yet — don't inject empty patterns
    }

    // Build map: caregiverId → { hired, total }
    const cgStats = new Map<string, { hired: number; total: number }>();
    for (const doc of outcomesSnap.docs) {
      const d = doc.data();
      const cgId = d.caregiverId as string;
      const isHired = (d.outcome as string) === "hired";
      if (!cgId) continue;
      const prev = cgStats.get(cgId) ?? { hired: 0, total: 0 };
      cgStats.set(cgId, { hired: prev.hired + (isHired ? 1 : 0), total: prev.total + 1 });
    }

    // Batch-load caregiver profiles for all IDs that appear
    const cgIds = [...cgStats.keys()];
    const profileMap = new Map<string, CaregiverProfile>();

    // Firestore `in` supports up to 30 at a time
    for (let i = 0; i < cgIds.length; i += 30) {
      const batch = cgIds.slice(i, i + 30);
      const snap = await db.collection("caregivers")
        .where(admin.firestore.FieldPath.documentId(), "in", batch)
        .get();
      for (const d of snap.docs) profileMap.set(d.id, d.data() as CaregiverProfile);
    }

    // Aggregate by certification / credential / rating / experience
    type Bucket = { hired: number; total: number };
    const buckets: Record<string, Bucket> = {
      dementiaWith: { hired: 0, total: 0 },
      dementiaWithout: { hired: 0, total: 0 },
      medicalCredWith: { hired: 0, total: 0 },
      medicalCredWithout: { hired: 0, total: 0 },
      ratingTop: { hired: 0, total: 0 },
      ratingGood: { hired: 0, total: 0 },
      ratingLow: { hired: 0, total: 0 },
      expSenior: { hired: 0, total: 0 },
      expMid: { hired: 0, total: 0 },
      expJunior: { hired: 0, total: 0 },
    };

    for (const [cgId, stats] of cgStats.entries()) {
      const profile = profileMap.get(cgId);
      if (!profile) continue;

      const dementia = hasDementiaCert(profile);
      const medical = hasMedicalCred(profile);
      const rating = ratingBand(profile.rating);
      const exp = expBand(profile.experience ?? profile.yearsExperience);

      const addTo = (key: string) => {
        buckets[key].hired += stats.hired;
        buckets[key].total += stats.total;
      };

      addTo(dementia ? "dementiaWith" : "dementiaWithout");
      addTo(medical ? "medicalCredWith" : "medicalCredWithout");
      if (rating === "top") addTo("ratingTop");
      else if (rating === "good") addTo("ratingGood");
      else if (rating === "low") addTo("ratingLow");
      addTo(exp === "senior" ? "expSenior" : exp === "mid" ? "expMid" : "expJunior");
    }

    const totalOutcomes = outcomesSnap.size;
    const lines: string[] = [
      `Platform hire patterns (from ${totalOutcomes} real outcomes):`,
    ];

    const dWith = fmt("Dementia/memory cert", buckets.dementiaWith.hired, buckets.dementiaWith.total);
    const dWithout = fmt("Without dementia cert", buckets.dementiaWithout.hired, buckets.dementiaWithout.total);
    if (dWith) lines.push(`- ${dWith}`);
    if (dWithout) lines.push(`- ${dWithout}`);

    const mWith = fmt("CNA/LVN/RN credential", buckets.medicalCredWith.hired, buckets.medicalCredWith.total);
    const mWithout = fmt("Without medical cred", buckets.medicalCredWithout.hired, buckets.medicalCredWithout.total);
    if (mWith) lines.push(`- ${mWith}`);
    if (mWithout) lines.push(`- ${mWithout}`);

    const rTop = fmt("Rating 4.8+ (10+ reviews)", buckets.ratingTop.hired, buckets.ratingTop.total);
    const rGood = fmt("Rating 4.5–4.79", buckets.ratingGood.hired, buckets.ratingGood.total);
    const rLow = fmt("Rating below 4.5", buckets.ratingLow.hired, buckets.ratingLow.total);
    if (rTop) lines.push(`- ${rTop}`);
    if (rGood) lines.push(`- ${rGood}`);
    if (rLow) lines.push(`- ${rLow}`);

    const eSenior = fmt("5+ years experience", buckets.expSenior.hired, buckets.expSenior.total);
    const eMid = fmt("3–4 years experience", buckets.expMid.hired, buckets.expMid.total);
    const eJunior = fmt("<3 years experience", buckets.expJunior.hired, buckets.expJunior.total);
    if (eSenior) lines.push(`- ${eSenior}`);
    if (eMid) lines.push(`- ${eMid}`);
    if (eJunior) lines.push(`- ${eJunior}`);

    // Only return summary if there's meaningful content (>1 line)
    const summary = lines.length > 2 ? lines.join("\n") : "";

    _cache = { summary, generatedAt: Date.now() };
    return summary;
  } catch (err) {
    console.error("[outcomeAnalytics] Failed to compute patterns:", err);
    return "";
  }
}

/** Force-clear the in-memory cache (called after new outcomes are recorded). */
export function invalidateOutcomeCache(): void {
  _cache = null;
}
