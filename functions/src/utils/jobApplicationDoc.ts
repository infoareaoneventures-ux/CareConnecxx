// Snapshot fields the webapp job-application cards render.
//
// The web writer (hooks/useJobApplications.ts applyToJob) stamps these onto
// every application so the caregiver's "My Applications" card (JobBoard) and
// the client's applicant panel (PostsPage) render without extra lookups.
// Every server-side job_applications writer must include them too, or
// SMS-originated applications show blank title/location cards.
export function jobApplicationSnapshot(job: FirebaseFirestore.DocumentData): Record<string, unknown> {
  return {
    jobTitle:      job.title ?? "Care needed",
    clientName:    job.clientName ?? "An Evia family",
    jobRate:       job.rate ?? null,
    jobLocation:   job.location || job.city || null,
    jobCareTypes:  Array.isArray(job.careTypes) ? job.careTypes : [],
    jobFrequency:  job.jobFrequency ?? null,
    jobDaysOfWeek: Array.isArray(job.daysOfWeek) ? job.daysOfWeek : [],
  };
}
