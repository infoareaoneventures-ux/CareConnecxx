import * as admin from "firebase-admin";

const db = admin.firestore();

export interface JobRecommendation {
  jobId: string;
  clientName: string;
  careTypes: string[];
  schedule: string;
  rate: number;
  matchScore: number;      // 0-100
  matchReasons: string[];  // e.g. ["skills match", "available Monday-Wednesday"]
}

export async function getJobRecommendationsForCaregiver(
  caregiverId: string,
  limit = 5
): Promise<JobRecommendation[]> {
  const [cgSnap, jobsSnap] = await Promise.all([
    db.collection("caregivers").doc(caregiverId).get(),
    db.collection("job_posts").where("status", "==", "open").limit(20).get(),
  ]);

  if (!cgSnap.exists || jobsSnap.empty) return [];
  const cg = cgSnap.data()!;
  const cgSkills: string[] = cg.skills ?? [];
  const cgAvailDays: string[] = Object.entries(cg.weeklyAvailability ?? {})
    .filter(([, slots]) => Array.isArray(slots) && (slots as any[]).length > 0)
    .map(([day]) => day);
  const cgRate: number = cg.hourlyRate ?? 20;

  const scored: Array<JobRecommendation & { _score: number }> = [];

  for (const doc of jobsSnap.docs) {
    const job = doc.data();
    let score = 0;
    const reasons: string[] = [];

    // Skills match
    const jobNeeds: string[] = job.careTypes ?? job.careNeeds ?? [];
    const skillOverlap = jobNeeds.filter((need: string) =>
      cgSkills.some(s =>
        s.toLowerCase().includes(need.toLowerCase()) ||
        need.toLowerCase().includes(s.toLowerCase())
      )
    );
    if (skillOverlap.length) {
      score += Math.min(40, skillOverlap.length * 15);
      reasons.push(`${skillOverlap.length} skill${skillOverlap.length > 1 ? "s" : ""} match`);
    }

    // Availability match
    const jobDays: string[] = (job.daysOfWeek ?? []).map((d: string) => d.toLowerCase());
    const dayOverlap = jobDays.filter(d => cgAvailDays.includes(d));
    if (jobDays.length > 0 && dayOverlap.length === jobDays.length) {
      score += 30;
      reasons.push("available all required days");
    } else if (dayOverlap.length > 0) {
      score += 15;
      reasons.push(`available ${dayOverlap.length} of ${jobDays.length} required days`);
    }

    // Rate match
    const jobRate: number = job.hourlyRate ?? job.rate ?? 20;
    if (jobRate >= cgRate) {
      score += 20;
      reasons.push("rate meets your preference");
    } else if (jobRate >= cgRate * 0.85) {
      score += 10;
      reasons.push("rate close to your preference");
    }

    // Location bonus (if both have zipCode)
    if (cg.zipCode && job.zipCode && cg.zipCode === job.zipCode) {
      score += 10;
      reasons.push("same zip code");
    }

    scored.push({
      jobId: doc.id,
      clientName: job.clientName ?? "A family",
      careTypes: jobNeeds,
      schedule: jobDays.join(", "),
      rate: jobRate,
      matchScore: Math.min(100, score),
      matchReasons: reasons,
      _score: score,
    });
  }

  return scored
    .sort((a, b) => b._score - a._score)
    .slice(0, limit)
    .map(({ _score, ...rest }) => rest);
}
