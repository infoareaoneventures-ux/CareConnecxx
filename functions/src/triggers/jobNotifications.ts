import * as admin from "firebase-admin";

// Family-side job_posts writers only (2026-09-27). Everything caregiver-facing
// that used to live here — the new-job fan-out to nearby caregivers
// (notifyAreaCaregivers), the texted yes/no job invite and its 48h reply
// handler (handleJobResponse / handleAvailabilityConfirmation), the
// skills-overlap match score, and the job_notifications collection — was
// removed: the website has no job alerts and no yes/no apply flow. A caregiver
// finds jobs the way the site's Jobs board and dashboard "Nearby Jobs" do
// (browse_job_board / get_job_details / start_apply_flow in mcp/server.ts).

const db = admin.firestore();

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
