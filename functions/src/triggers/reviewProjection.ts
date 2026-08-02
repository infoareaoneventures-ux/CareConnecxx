// ── Childcare review projection trigger (plan 2026-07-22-002, U8 / R45) ──────
//
// Routes CHILDCARE review writes into the per-vertical reputation projection.
// The senior aggregation stays where it always was (index.ts onReviewWritten,
// which now explicitly skips childcare rows) — this trigger is the childcare
// half of the isolation: a childcare review recomputes ONLY the child-vertical
// aggregates and never the senior caregivers.rating/reviewCount fields; a
// senior review is a no-op here.

import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { recomputeChildcareCaregiverReputation } from "../childcare/reputationProjection";
import { writeUserNotification } from "../notifications/userNotification";
import { createCaraOpsAlert } from "../observability/caraOpsAlerts";
import {
  CHILDCARE_REVIEW_PUBLIC_PROJECTION_VERSION,
  childcarePublicReviewProjectionId,
} from "../childcare/reviewModerationCallables";
import {
  CHILDCARE_REVIEW_SUBMISSIONS_COLLECTION,
  type ChildcareReviewSubmissionDoc,
} from "../childcare/reviewCallables";

export const onChildcareReviewWritten = functions.firestore
  .document("reviews/{reviewId}")
  .onWrite(async (change, context) => {
    const after = change.after.exists ? change.after.data() : null;
    const before = change.before.exists ? change.before.data() : null;
    const row = after ?? before;
    // Vertical guard FIRST: senior reviews never enter the childcare
    // projection (R45 — both directions).
    if (!row || row.careVertical !== "child") return null;
    const caregiverId = String(row.caregiverId ?? "");
    if (!caregiverId) return null;

    // Generic child-safe notice on true creation (parity with the senior
    // review_created notice, which skips childcare rows). Idempotent via the
    // eventId-keyed notification writer.
    if (!before && after) {
      try {
        await writeUserNotification({
          sourcePath: `reviews/${context.params.reviewId}`,
          eventId: context.eventId,
          recipientId: caregiverId,
          transitionType: "review_created",
          type: "review_received",
          title: "New Review",
          body: "You received a new childcare review. Open the app to read it.",
          data: { reviewId: context.params.reviewId },
        });
      } catch (err) {
        console.error(
          "[onChildcareReviewWritten] notification error:",
          err instanceof Error ? err.name : "Error",
        );
      }
    }

    await recomputeChildcareCaregiverReputation(caregiverId);
    return null;
  });

export async function reconcileChildcareReviewProjectionsCore(
  opts: { db?: admin.firestore.Firestore; now?: Date; limit?: number } = {},
): Promise<{ repaired: number; pendingSlaMisses: number }> {
  const db = opts.db ?? admin.firestore();
  const now = opts.now ?? new Date();
  const limit = Math.max(1, Math.min(200, opts.limit ?? 100));
  const published = await db
    .collection(CHILDCARE_REVIEW_SUBMISSIONS_COLLECTION)
    .where("moderationState", "==", "published")
    .limit(limit)
    .get();
  let repaired = 0;
  const caregiverIds = new Set<string>();
  for (const doc of published.docs) {
    const row = doc.data() as ChildcareReviewSubmissionDoc;
    if (!row.publicComment || row.careVertical !== "child") continue;
    const projectionId =
      row.publishedProjectionId ??
      childcarePublicReviewProjectionId(doc.id, row.sourceVersion);
    const projectionRef = db.collection("reviews").doc(projectionId);
    const projection = await projectionRef.get();
    if (!projection.exists) {
      await projectionRef.set({
        schemaVersion: CHILDCARE_REVIEW_PUBLIC_PROJECTION_VERSION,
        careVertical: "child",
        sourceReviewId: doc.id,
        sourceVersion: row.sourceVersion,
        sourceStateVersion: row.stateVersion,
        caregiverId: row.caregiverId,
        reviewerRole: row.reviewerRole,
        rating: row.rating,
        comment: row.publicComment,
        moderationState: "published",
        isPublic: true,
        createdAt: row.createdAt,
        date: row.createdAt,
        publishedAt: row.moderatedAt ?? row.updatedAt,
      });
      await doc.ref.set({ publishedProjectionId: projectionId }, { merge: true });
      repaired++;
      caregiverIds.add(row.caregiverId);
    }
  }

  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const overdue = await db
    .collection(CHILDCARE_REVIEW_SUBMISSIONS_COLLECTION)
    .where("moderationState", "==", "pending")
    .where("createdAt", "<=", cutoff)
    .limit(limit)
    .get();
  if (!overdue.empty) {
    await createCaraOpsAlert({
      type: "childcare_review_moderation_sla",
      severity: "high",
      source: "reviewProjection",
      message: "Childcare review moderation has pending work older than 24 hours.",
      context: { count: overdue.size, window: "24h" },
    });
  }
  for (const caregiverId of caregiverIds) {
    await recomputeChildcareCaregiverReputation(caregiverId, { db, now });
  }
  return { repaired, pendingSlaMisses: overdue.size };
}

export const reconcileChildcareReviewProjections = functions.pubsub
  .schedule("every 30 minutes")
  .onRun(async () => reconcileChildcareReviewProjectionsCore());
