// Snapshot fields the webapp job-application cards render.
//
// The web writer (hooks/useJobApplications.ts applyToJob) stamps these onto
// every application so the caregiver's "My Applications" card (JobBoard) and
// the client's applicant panel (PostsPage) render without extra lookups.
// Every server-side job_applications writer must include them too, or
// SMS-originated applications show blank title/location cards.
// job.location is a STRING in the web contract, but legacy docs and one-off
// repair scripts have stored an OBJECT ({ city, zipCode, lat, lng }) — and the
// webapp renders jobLocation raw in JSX, so an object here crashes the whole
// caregiver Job Board (React #31, seen live 2026-07-15). Always snapshot a string.
function locationString(job: FirebaseFirestore.DocumentData): string | null {
  const loc = job.location;
  if (typeof loc === "string" && loc) return loc;
  if (loc && typeof loc === "object") {
    const s = [loc.city ?? job.city, loc.state ?? job.state, loc.zipCode ?? job.zipCode]
      .filter((p: unknown): p is string => typeof p === "string" && p.length > 0)
      .join(", ");
    if (s) return s;
  }
  return (typeof job.city === "string" && job.city) ? job.city : null;
}

export function jobApplicationSnapshot(job: FirebaseFirestore.DocumentData): Record<string, unknown> {
  return {
    jobTitle:      job.title ?? "Care needed",
    clientName:    job.clientName ?? "An Evia family",
    jobRate:       job.rate ?? null,
    jobRateFlexible: !!job.rateFlexible,
    jobLocation:   locationString(job),
    jobCareTypes:  Array.isArray(job.careTypes) ? job.careTypes : [],
    jobFrequency:  job.jobFrequency ?? null,
    jobDaysOfWeek: Array.isArray(job.daysOfWeek) ? job.daysOfWeek : [],
  };
}
