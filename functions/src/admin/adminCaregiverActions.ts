import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { requireAdmin } from "./requireAdmin";
import { logAudit } from "../observability/auditLog";

const db = admin.firestore();

function nowIso() {
  return new Date().toISOString();
}

/**
 * Returns whether a caregiver doc satisfies the launch bookability policy (R8):
 *   onboardingStatus === "profile_complete"  AND  verificationStatus === "approved"
 *
 * Checkr `clear` is the AUTOMATIC source of verificationStatus "approved"
 * (functions/src/checkr.ts). A manual admin approve of a Checkr `consider`
 * exception may move verificationStatus to "approved", but it must NOT fabricate
 * a Checkr `clear`, and it must NOT mark the caregiver bookable unless the full
 * policy holds. `status: "active"` is the field FindCaregivers gates on, so we
 * only flip it to active when the policy is satisfied.
 */
export function isBookable(c: {
  onboardingStatus?: string;
  verificationStatus?: string;
}): boolean {
  return (
    c.onboardingStatus === "profile_complete" &&
    c.verificationStatus === "approved"
  );
}

/**
 * admin_review_caregiver_exception — resolve a Checkr consider/exception in the
 * verification queue.
 *
 * AE8 + R8: approving an exception sets verificationStatus but MUST NOT make the
 * caregiver bookable unless the bookability policy is already satisfied. We never
 * write a synthetic Checkr `clear`; we record the manual decision separately
 * (manualReviewDecision / verificationSource: "admin_manual_review") so the
 * automatic Checkr path stays the canonical clear source.
 */
export const admin_review_caregiver_exception = functions.https.onCall(
  async (data, context) => {
    const adminUid = await requireAdmin(context);

    const caregiverId: string = data?.caregiverId;
    const decision: string = data?.decision; // "approve" | "reject" | "request_info"
    const note: string = typeof data?.note === "string" ? data.note.slice(0, 2000) : "";

    if (!caregiverId || !["approve", "reject", "request_info"].includes(decision)) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "caregiverId and a valid decision (approve | reject | request_info) are required",
      );
    }

    const ref = db.collection("caregivers").doc(caregiverId);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new functions.https.HttpsError("not-found", "Caregiver not found");
    }
    const caregiver = snap.data() ?? {};
    const now = nowIso();

    const updates: Record<string, unknown> = {
      manualReviewDecision: decision,
      manualReviewBy: adminUid,
      manualReviewAt: now,
      manualReviewNote: note || null,
      // Provenance marker so analytics / future logic can tell a manual review
      // apart from a Checkr-driven approval. We deliberately do NOT touch
      // backgroundCheckData.checkrCandidateId or set a Checkr `clear`.
      verificationSource: "admin_manual_review",
      updatedAt: now,
    };

    if (decision === "approve") {
      updates.verificationStatus = "approved";
      updates.verified = true;
      updates.approvedAt = now;
      updates.approvedBy = adminUid;
    } else if (decision === "reject") {
      updates.verificationStatus = "rejected";
      updates.verified = false;
      updates.rejectedAt = now;
      updates.rejectedBy = adminUid;
      updates.rejectionReason = note || null;
    } else {
      updates.verificationStatus = "info_requested";
      updates.infoRequestedAt = now;
      updates.infoRequestNotes = note || null;
    }

    // Bookability is policy-gated, never a side effect of the manual decision.
    // We compute the projected post-update state and only set status:"active"
    // when BOTH onboardingStatus profile_complete AND verificationStatus
    // approved hold. Otherwise the caregiver stays unbookable (AE8).
    const projected = {
      onboardingStatus: caregiver.onboardingStatus,
      verificationStatus:
        (updates.verificationStatus as string | undefined) ??
        caregiver.verificationStatus,
    };
    const bookable = decision === "approve" && isBookable(projected);
    if (bookable) {
      updates.status = "active";
    }
    // If not bookable we leave `status` untouched (do NOT force "active"); a
    // previously-active caregiver isn't demoted here, but a non-bookable one is
    // never promoted by a manual exception review.

    await ref.update(updates);

    await logAudit({
      eventType: "caregiver_exception_reviewed",
      userId: caregiverId,
      data: {
        source: "callable:admin_review_caregiver_exception",
        adminUid,
        decision,
        bookable,
        verificationStatus: projected.verificationStatus,
        onboardingStatus: caregiver.onboardingStatus ?? null,
        note: note || null,
      },
    });

    return { success: true, decision, bookable, verificationStatus: projected.verificationStatus };
  },
);

/**
 * admin_review_document — approve/reject a single uploaded caregiver document.
 *
 * Documents live as a map on the caregiver doc keyed by documentType, each
 * `{ url, status, ... }` (the shape CaregiverVerificationDashboard reads).
 */
export const admin_review_document = functions.https.onCall(
  async (data, context) => {
    const adminUid = await requireAdmin(context);

    const caregiverId: string = data?.caregiverId;
    const documentType: string = data?.documentType;
    const decision: string = data?.decision; // "approve" | "reject"
    const note: string = typeof data?.note === "string" ? data.note.slice(0, 2000) : "";

    if (!caregiverId || !documentType || !["approve", "reject"].includes(decision)) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "caregiverId, documentType, and a valid decision (approve | reject) are required",
      );
    }

    const ref = db.collection("caregivers").doc(caregiverId);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new functions.https.HttpsError("not-found", "Caregiver not found");
    }
    const caregiver = snap.data() ?? {};
    const existingDoc = (caregiver.documents ?? {})[documentType];
    if (!existingDoc) {
      throw new functions.https.HttpsError(
        "not-found",
        `No '${documentType}' document uploaded for this caregiver`,
      );
    }

    const now = nowIso();
    const newStatus = decision === "approve" ? "approved" : "rejected";

    await ref.update({
      [`documents.${documentType}.status`]: newStatus,
      [`documents.${documentType}.reviewedBy`]: adminUid,
      [`documents.${documentType}.reviewedAt`]: now,
      [`documents.${documentType}.reviewNote`]: note || null,
      updatedAt: now,
    });

    await logAudit({
      eventType: "caregiver_document_reviewed",
      userId: caregiverId,
      data: {
        source: "callable:admin_review_document",
        adminUid,
        documentType,
        decision,
        note: note || null,
      },
    });

    return { success: true, documentType, status: newStatus };
  },
);
