// The Jobs page's "Submit Application" — one write, shared by Evia's Apply flow
// (caregiverJobFlows.ts) — the only way Evia applies — so the document is the site's
// (hooks/useJobApplications.ts applyToJob) field for field, whoever submits.
import * as admin from "firebase-admin";
import { logAudit } from "../observability/auditLog";
import { jobApplicationSnapshot } from "../utils/jobApplicationDoc";
import { caregiverBlockReason, jobRequiresTransport, CaregiverGateReason } from "./caregiverAccessGate";

const db = admin.firestore();

export type SubmitJobApplicationResult =
  | { ok: true; applicationId: string; jobTitle: string }
  | { ok: false; code: "NOT_FOUND" | "CLOSED" | "DUPLICATE" | "GATED"; message: string; gate?: CaregiverGateReason };

export async function submitJobApplication(input: {
  caregiverId: string; jobId: string; coverLetter?: string; source: string;
}): Promise<SubmitJobApplicationResult> {
  const { caregiverId, jobId, source } = input;
  const jobSnap = await db.collection("job_posts").doc(jobId).get();
  if (!jobSnap.exists) return { ok: false, code: "NOT_FOUND", message: "Job post not found" };
  const job = jobSnap.data()!;
  if (job.status !== "open") return { ok: false, code: "CLOSED", message: "This job post is no longer accepting applications" };

  const applicantSnap = await db.collection("caregivers").doc(caregiverId).get().catch(() => null);
  const applicant = (applicantSnap?.exists ? applicantSnap.data()! : {}) as Record<string, unknown>;
  // JobBoard.tsx: the gate button stands in for Apply (transport-aware for transport jobs).
  const gate = caregiverBlockReason(applicant, { transport: jobRequiresTransport(job) });
  if (gate) return { ok: false, code: "GATED", message: "Blocked by the site's gate", gate };

  const dup = await db.collection("job_applications").where("jobId", "==", jobId).where("caregiverId", "==", caregiverId).limit(1).get();
  if (!dup.empty) return { ok: false, code: "DUPLICATE", message: "You have already applied to this job" };

  const appRef = await db.collection("job_applications").add({
    jobId, caregiverId, clientId: job.clientId,
    caregiverName:  (applicant.name as string) ?? "",
    caregiverPhoto: (applicant.photo as string) || (applicant.imageUrl as string) || "",
    experience:     typeof applicant.experience === "number" ? applicant.experience : (Number(applicant.experience) || 0),
    rating:         typeof applicant.rating === "number" ? applicant.rating : null,
    skills:         Array.isArray(applicant.skills) ? applicant.skills : [],
    ...jobApplicationSnapshot(job),
    coverLetter:    (input.coverLetter ?? "").trim(),
    proposedRate:   null,
    status: "pending", appliedAt: new Date().toISOString(), source: "cara_sms",
  });
  // onJobApplicationCreate (notificationTriggers.ts) tells the family — the one text for this event.
  logAudit({ eventType: "job_application_submitted", userId: caregiverId, data: { source, jobId, applicationId: appRef.id } }).catch(() => {});
  return { ok: true, applicationId: appRef.id, jobTitle: (job.title as string) ?? "Care needed" };
}
