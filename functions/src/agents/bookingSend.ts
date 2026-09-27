// agents/bookingSend.ts — the website's "Send Booking Request" write, server-side.
//
// 2026-09-17: Evia's fresh booking used to travel a path the website never
// had — createBookingTask staged an `agent_tasks` doc, executeBookings wrote
// `booking_requests` with an `agentTaskId`, texted the caregiver a YES/NO
// shift offer, and a caregiver YES wrote the shifts itself (writeConfirmedShifts)
// plus a recurring-schedule follow-up and a payment nudge. None of that exists
// on the site. This module is the ONE booking write for both channels — it
// mirrors PostsPage.tsx's handleSendBooking exactly:
//
//   booking_requests.add({ ...bookingData, status: 'pending', isResend: false, createdAt })
//   hire_decisions.add({ decision: 'hire', ... })
//   job_applications (caregiverId + jobId) → status 'accepted'
//
// Everything downstream is the site's own machinery: onBookingRequestWrite
// notifies the caregiver (in-app + text: "Check the app to respond"), the
// caregiver accepts on their My Bookings page, onBookingAccepted
// (shiftGenerator.ts) generates the real shifts, and onBookingRequestWrite
// texts the family that it was accepted. No agent_tasks, no shift offers.
import * as admin from "firebase-admin";
import { isCaregiverBookable } from "../utils/caregiverEligibility";
import { logAudit } from "../observability/auditLog";

const db = admin.firestore();

export interface SiteBookingSchedule {
  days:          string[];
  startDate:     string | null;
  endDate:       string | null;
  ongoing:       boolean;
  dayShiftTimes: Record<string, Array<{ start: string; end: string }>>;
}

export interface SendBookingRequestInput {
  clientId:             string;
  caregiverId:          string;
  caregiverName:        string;
  jobId?:               string | null;
  jobTitle?:            string;
  interviewId?:         string | null;
  applicationId?:       string;
  address:              string;
  rate:                 number | null;
  careNeeds:            string[];
  careRecipients:       Array<Record<string, unknown>>;
  lifestylePreferences: string[];
  emergencyContact:     { name: string; phone: string; relationship?: string } | null;
  schedule:             SiteBookingSchedule;
  notes:                string | null;
}

export type SendBookingRequestResult =
  | { ok: true;  bookingRequestId: string }
  // Only profile_complete + approved caregivers are bookable (the site never
  // lists anyone else) — same gate the retired createBookingTask applied.
  | { ok: false; reason: "caregiver_not_bookable"; daysInReview: number }
  // handleSendBooking's own duplicate guard: a pending request for the same
  // caregiver + job/interview pairing, or an accepted one that still has a
  // scheduled shift, blocks a second doc.
  | { ok: false; reason: "already_pending" | "already_active"; bookingRequestId: string };

function pairingKey(caregiverId: string, jobId?: string | null, interviewId?: string | null): string {
  return `${caregiverId}_${jobId || interviewId || ""}`;
}

function tsMs(v: unknown): number {
  if (!v) return -Infinity;
  if (typeof v === "string") { const n = Date.parse(v); return Number.isFinite(n) ? n : -Infinity; }
  if (typeof (v as { toMillis?: () => number }).toMillis === "function") return (v as { toMillis: () => number }).toMillis();
  if (v instanceof Date) return v.getTime();
  return -Infinity;
}

/**
 * The site's own guard (PostsPage.tsx handleSendBooking): the latest request
 * for this caregiver + job/interview pairing must not be pending, and an
 * accepted one blocks only while it still has a scheduled shift
 * (activeBookingIds). Exported so the flow can re-check at commit time.
 */
export async function findBlockingBookingRequest(
  clientId: string, caregiverId: string, jobId?: string | null, interviewId?: string | null,
): Promise<{ reason: "already_pending" | "already_active"; bookingRequestId: string } | null> {
  const key = pairingKey(caregiverId, jobId, interviewId);
  const snap = await db.collection("booking_requests")
    .where("clientId", "==", clientId)
    .where("caregiverId", "==", caregiverId)
    .get();
  const matching = snap.docs
    .filter((d) => {
      const b = d.data() as { jobId?: string | null; interviewId?: string | null };
      return pairingKey(caregiverId, b.jobId, b.interviewId) === key;
    })
    .sort((a, b) => {
      const ad = a.data(), bd = b.data();
      return tsMs(bd.updatedAt ?? bd.createdAt) - tsMs(ad.updatedAt ?? ad.createdAt);
    });
  const latest = matching[0];
  if (!latest) return null;
  const status = latest.data().status as string | undefined;
  if (status === "pending") return { reason: "already_pending", bookingRequestId: latest.id };
  if (status === "accepted") {
    const shiftSnap = await db.collection("shifts")
      .where("bookingRequestId", "==", latest.id)
      .where("status", "==", "scheduled")
      .limit(1)
      .get();
    if (!shiftSnap.empty) return { reason: "already_active", bookingRequestId: latest.id };
  }
  return null;
}

export async function sendBookingRequest(
  input: SendBookingRequestInput,
  opts: { source: string },
): Promise<SendBookingRequestResult> {
  const cgSnap = await db.collection("caregivers").doc(input.caregiverId).get();
  const cg = (cgSnap.data() ?? {}) as Record<string, unknown>;
  if (!isCaregiverBookable(cgSnap.data())) {
    const submittedAt = (cg.backgroundCheckData as { submittedAt?: string } | undefined)?.submittedAt;
    const daysInReview = submittedAt
      ? Math.ceil((Date.now() - new Date(submittedAt).getTime()) / (1000 * 60 * 60 * 24))
      : 0;
    return { ok: false, reason: "caregiver_not_bookable", daysInReview };
  }

  const blocking = await findBlockingBookingRequest(input.clientId, input.caregiverId, input.jobId, input.interviewId);
  if (blocking) return { ok: false, ...blocking };

  // clientName / clientPhotoURL: the site reads Firebase Auth's displayName /
  // photoURL and falls back to the users doc. Server-side, the users doc is
  // the only source — an Evia-onboarded client has firstName/lastName, a
  // web-signup client may carry displayName/name.
  const userSnap = await db.collection("users").doc(input.clientId).get();
  const u = (userSnap.data() ?? {}) as Record<string, unknown>;
  const clientName =
    (typeof u.displayName === "string" && u.displayName.trim()) ||
    [u.firstName, u.lastName].filter(Boolean).join(" ") ||
    (typeof u.name === "string" ? u.name : "") || "";
  const clientPhotoURL = (u.photoURL || u.photo || u.profilePhoto || u.imageUrl || null) as string | null;
  const caregiverPhotoURL = (cg.photo || cg.photoURL || null) as string | null;

  const now = admin.firestore.FieldValue.serverTimestamp();
  const bookingData = {
    clientId:             input.clientId,
    clientName,
    clientPhotoURL,
    caregiverId:          input.caregiverId,
    caregiverName:        input.caregiverName,
    caregiverPhotoURL,
    jobId:                input.jobId || null,
    jobTitle:             input.jobTitle ?? "",
    address:              input.address,
    rate:                 input.rate ?? null,
    // Cash/Venmo/Zelle removed platform-wide (2026-08-23) — same as the site.
    paymentMethod:        "credit",
    careNeeds:            input.careNeeds,
    careRecipients:       input.careRecipients,
    lifestylePreferences: input.lifestylePreferences,
    emergencyContact:     input.emergencyContact ?? null,
    schedule:             input.schedule,
    notes:                input.notes && input.notes.trim() ? input.notes.trim() : null,
    interviewId:          input.interviewId || null,
  };

  const ref = await db.collection("booking_requests").add({
    ...bookingData,
    status:    "pending",
    isResend:  false,
    createdAt: now,
  });


  await db.collection("hire_decisions").add({
    clientId:      input.clientId,
    clientName,
    caregiverId:   input.caregiverId,
    caregiverName: input.caregiverName,
    decision:      "hire",
    createdAt:     now,
  }).catch((err) => console.error("[bookingSend] hire_decisions add failed", err));

  // Mark the caregiver's application accepted — the site looks it up by
  // caregiverId + jobId; fall back to a known applicationId when no jobId.
  try {
    if (input.jobId) {
      const appSnap = await db.collection("job_applications")
        .where("caregiverId", "==", input.caregiverId)
        .where("jobId", "==", input.jobId)
        .limit(1)
        .get();
      if (!appSnap.empty) {
        await appSnap.docs[0].ref.update({ status: "accepted", acceptedAt: now });
      }
    } else if (input.applicationId) {
      await db.collection("job_applications").doc(input.applicationId).update({ status: "accepted", acceptedAt: now });
    }
  } catch { /* non-critical — same as the site */ }

  logAudit({
    eventType: "booking_created", userId: input.clientId,
    data: { source: opts.source, bookingRequestId: ref.id, caregiverId: input.caregiverId },
  }).catch(() => {});

  return { ok: true, bookingRequestId: ref.id };
}
