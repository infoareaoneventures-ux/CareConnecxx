import * as admin from "firebase-admin";
import { buildWebJobPostDoc } from "../agents/jobPostContract";

// Family-side job_posts writers only (2026-09-27). Everything caregiver-facing
// that used to live here — the new-job fan-out to nearby caregivers
// (notifyAreaCaregivers), the texted yes/no job invite and its 48h reply
// handler (handleJobResponse / handleAvailabilityConfirmation), the
// skills-overlap match score, and the job_notifications collection — was
// removed: the website has no job alerts and no yes/no apply flow. A caregiver
// finds jobs the way the site's Jobs board and dashboard "Nearby Jobs" do
// (browse_job_board / get_job_details / start_apply_flow in mcp/server.ts).

const db = admin.firestore();

// ── createJobPost ─────────────────────────────────────────────────────────────

export async function createJobPost(
  intakeId: string,
  intakeData: any,
  clientId: string
): Promise<void> {
  try {
    let lat = intakeData.lat ?? intakeData.latitude ?? intakeData.location?.latitude ?? intakeData.location?.lat ?? null;
    let lng = intakeData.lng ?? intakeData.longitude ?? intakeData.location?.longitude ?? intakeData.location?.lng ?? null;
    const city = intakeData.city ?? intakeData.location?.city ?? undefined;
    const careTypes: string[] = intakeData.careTypes ?? [];

    // Geocode fallback (parity with buildAndSaveJobPost): an intake with only a
    // city/zip used to produce a coordless job here — radius notifications dead.
    if (lat == null || lng == null) {
      const { geocodeCityOrZip } = await import("../utils/geocode");
      const coords = await geocodeCityOrZip(
        city as string | undefined,
        (intakeData.zipCode ?? intakeData.location?.zipCode) as string | undefined,
        (intakeData.state ?? intakeData.location?.state) as string | undefined,
      ).catch(() => null);
      if (coords) { lat = coords.lat; lng = coords.lng; }
    }

    // Web JobPost contract via the shared builder — the caregiver Job Board
    // renders title/location-string/rate/date; the old hand-rolled shape here
    // (summary + location OBJECT + Timestamp createdAt) rendered blank and
    // could crash the board's JSX. Merge-write: Evia's post-payment
    // buildAndSaveJobPost targets the same job_posts/{uid} doc.
    const recipientFirst = (intakeData.recipientFirstName ?? intakeData.recipientName ?? "") as string;
    const daysPerWeek    = Number(intakeData.daysPerWeek ?? 0);
    const timeOfDay      = typeof intakeData.timeOfDay === "string" && intakeData.timeOfDay
      ? [intakeData.timeOfDay as string]
      : (Array.isArray(intakeData.timeOfDay) ? intakeData.timeOfDay as string[] : []);
    await db.collection("job_posts").doc(intakeId).set(buildWebJobPostDoc({
      clientId,
      source:      "intake_trigger",
      title:       `Care for ${recipientFirst.split(" ")[0] || "a Loved One"}`,
      clientName:  ((intakeData.contactName ?? intakeData.firstName ?? "") as string) || undefined,
      careTypes,
      startDate:   (intakeData.startDate ?? undefined) as string | undefined,
      frequency:   daysPerWeek >= 5 ? "full_time" : daysPerWeek >= 3 ? "part_time" : daysPerWeek > 0 ? "occasional" : undefined,
      daysPerWeek,
      timeOfDay,
      hourlyRate:  Number(intakeData.budgetMax ?? 0) || Number(intakeData.budgetMin ?? 0) || "flexible",
      city,
      zipCode:     (intakeData.zipCode ?? undefined) as string | undefined,
      lat,
      lng,
      recipientsCount: Number(intakeData.recipientsCount ?? 0) || undefined,
      phone:       (intakeData.phone ?? undefined) as string | undefined,
      intakeId,
    }), { merge: true });

    if (!lat || !lng) {
      console.warn(`[createJobPost] Intake ${intakeId} has no coordinates — caregivers will not be notified`);
    }
  } catch (err) {
    console.error("[createJobPost] failed:", err);
  }
}

// ── closeJobPost ──────────────────────────────────────────────────────────────

export async function closeJobPost(clientId: string): Promise<void> {
  try {
    const snap = await db.collection("job_posts")
      .where("clientId", "==", clientId)
      .where("status",   "==", "open")
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();

    if (snap.empty) return;

    await snap.docs[0].ref.update({
      status:   "closed",
      closedAt: new Date().toISOString(),
    });

    console.log(`[closeJobPost] Closed job post ${snap.docs[0].id} for client ${clientId}`);
  } catch (err) {
    console.error("[closeJobPost] failed:", err);
  }
}
