// Audited proactive-draft review callable (plan 2026-07-18-001 U8, R44/AE23,
// KTD15).
//
// Approve/reject/edit decisions go through THIS callable — server-verified
// admin (live users-doc role via requireAdmin, never a custom claim alone),
// transactional status transition, and an immutable reviewed-content hash
// stamped at approval. The draft sender re-verifies that hash at claim time
// (proactiveDraftSender), so content edited or tampered after review can
// never reach a family (AE23). Replaces the frontend's direct Firestore
// review writes (services/api.ts migration tracked in the source manifest).

import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { createHash } from "crypto";
import { requireAdmin } from "./requireAdmin";
import { logAudit } from "../observability/auditLog";

export function reviewedContentHash(draftText: string): string {
  return createHash("sha256").update(draftText).digest("hex");
}

export interface ReviewDecisionInput {
  decision: "approve" | "reject";
  editedText?: string;
}

/** Pure transition: validates and returns the update map, or throws. */
export function applyReviewDecision(
  existing: { status?: string; draftText?: string },
  input: ReviewDecisionInput,
  reviewerUid: string,
  now: Date,
): Record<string, unknown> {
  if (existing.status !== "pending_review") {
    throw new functions.https.HttpsError("failed-precondition", `Draft is ${existing.status ?? "missing"}, not pending_review.`);
  }
  if (input.decision === "reject") {
    return { status: "rejected", reviewerUid, rejectedAt: now.toISOString() };
  }
  const finalText = (input.editedText ?? existing.draftText ?? "").trim();
  if (!finalText || finalText.length > 320) {
    throw new functions.https.HttpsError("invalid-argument", "Approved draft text must be 1-320 chars.");
  }
  return {
    status: "approved",
    draftText: finalText,
    reviewedContentHash: reviewedContentHash(finalText),
    reviewerUid,
    approvedAt: now.toISOString(),
    ...(input.editedText !== undefined ? { editedByReviewer: true } : {}),
  };
}

export const reviewProactiveDraft = functions.https.onCall(async (data, context) => {
  const reviewerUid = await requireAdmin(context);
  const draftId = typeof data?.draftId === "string" ? data.draftId : "";
  const decision = data?.decision === "approve" || data?.decision === "reject" ? data.decision : null;
  const editedText = typeof data?.editedText === "string" ? data.editedText : undefined;
  if (!draftId || !decision) {
    throw new functions.https.HttpsError("invalid-argument", "draftId and decision (approve|reject) are required.");
  }

  const db = admin.firestore();
  const ref = db.collection("proactive_drafts").doc(draftId);
  const update = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new functions.https.HttpsError("not-found", "Draft not found.");
    const u = applyReviewDecision(snap.data() as { status?: string; draftText?: string }, { decision, editedText }, reviewerUid, new Date());
    tx.update(ref, u);
    return u;
  });

  logAudit({
    eventType: decision === "approve" ? "proactive_draft_approved" : "proactive_draft_rejected",
    userId: reviewerUid,
    data: { draftId, edited: editedText !== undefined },
  }).catch(() => {});

  return { ok: true, status: update.status };
});
