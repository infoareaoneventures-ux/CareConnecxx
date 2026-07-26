// Private-first childcare review submission. Raw rating/comment content is
// server-only until an operator publishes a separate recipient-safe projection.

import * as admin from "firebase-admin";
import * as functions from "firebase-functions/v1";
import { createHash } from "crypto";
import { checkRateLimit, type RateLimitConfig } from "../rateLimit";
import { getChildcareFlags } from "../config/featureFlags";
import { logAudit } from "../observability/auditLog";
import { childcareOnCall } from "./appCheckPolicy";
import type { ChildcareBookingDoc } from "./bookingPolicy";

export const CHILDCARE_REVIEW_SUBMISSIONS_COLLECTION = "childcare_review_submissions";
export const CHILDCARE_REVIEW_SCHEMA_VERSION = "childcare-review-private-v1";

const REVIEW_MUTATION_RATE: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 5,
  keyPrefix: "rl:childcare:review:mut:",
};

type Db = Pick<admin.firestore.Firestore, "collection" | "runTransaction">;

export type ChildcareReviewState =
  | "pending"
  | "published"
  | "rejected"
  | "unpublished"
  | "deleted";
export type ChildcareReviewerRole = "family" | "provider";

export interface ChildcareReviewSubmissionDoc {
  schemaVersion: typeof CHILDCARE_REVIEW_SCHEMA_VERSION;
  careVertical: "child";
  childcareBookingId: string;
  caregiverId: string;
  clientId: string;
  reviewerUid: string;
  reviewerRole: ChildcareReviewerRole;
  rating: number;
  comment: string;
  moderationState: ChildcareReviewState;
  stateVersion: number;
  sourceVersion: number;
  createdAt: string;
  updatedAt: string;
  publishedProjectionId: string | null;
  moderatedByUid: string | null;
  moderatedAt: string | null;
  moderationReasonCode: string | null;
  redactionVersion: string | null;
  lastDecisionId: string | null;
  publicComment: string | null;
}

export const CHILDCARE_REVIEW_PRIVATE_KEYS = [
  "schemaVersion",
  "careVertical",
  "childcareBookingId",
  "caregiverId",
  "clientId",
  "reviewerUid",
  "reviewerRole",
  "rating",
  "comment",
  "moderationState",
  "stateVersion",
  "sourceVersion",
  "createdAt",
  "updatedAt",
  "publishedProjectionId",
  "moderatedByUid",
  "moderatedAt",
  "moderationReasonCode",
  "redactionVersion",
  "lastDecisionId",
  "publicComment",
] as const;

/** One private submission per booking and reviewer. */
export function childcareReviewDocId(bookingId: string, reviewerUid: string): string {
  const sha = createHash("sha256")
    .update(`childcare-review:${bookingId}:${reviewerUid}`)
    .digest("hex")
    .slice(0, 40);
  return `crev_${sha}`;
}

function requireAuth(context: functions.https.CallableContext): string {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Must be signed in.");
  return context.auth.uid;
}

function permissionDenied(): functions.https.HttpsError {
  return new functions.https.HttpsError(
    "permission-denied",
    "You do not have access to this resource.",
  );
}

function invalidArgument(): functions.https.HttpsError {
  return new functions.https.HttpsError("invalid-argument", "Invalid request.");
}

export async function submitChildcareReviewCore(
  uid: string,
  input: { bookingId: string; rating: number; comment: string },
  opts: { db?: Db; now?: Date } = {},
): Promise<{ success: true; reviewId: string; created: boolean; duplicate: boolean; moderationState: "pending" }> {
  const db = opts.db ?? admin.firestore();
  const now = opts.now ?? new Date();
  const bookingId = String(input.bookingId ?? "").trim();
  const rating = Number(input.rating);
  const comment = String(input.comment ?? "").trim().slice(0, 2000);
  if (!bookingId || bookingId.length > 128) throw invalidArgument();
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw invalidArgument();

  const bookingSnap = await db.collection("booking_requests").doc(bookingId).get();
  const booking = (bookingSnap.data() ?? {}) as ChildcareBookingDoc;
  if (!bookingSnap.exists || booking.careVertical !== "child") throw permissionDenied();

  let reviewerRole: ChildcareReviewerRole;
  if (booking.clientId === uid) reviewerRole = "family";
  else if (booking.caregiverId === uid) reviewerRole = "provider";
  else throw permissionDenied();
  if (booking.status !== "completed") {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Reviews can be left after the booking is completed.",
      { code: "booking_not_completed" },
    );
  }

  const reviewId = childcareReviewDocId(bookingId, uid);
  const reviewRef = db.collection(CHILDCARE_REVIEW_SUBMISSIONS_COLLECTION).doc(reviewId);
  const ts = now.toISOString();
  const doc: ChildcareReviewSubmissionDoc = {
    schemaVersion: CHILDCARE_REVIEW_SCHEMA_VERSION,
    careVertical: "child",
    childcareBookingId: bookingId,
    caregiverId: booking.caregiverId,
    clientId: booking.clientId,
    reviewerUid: uid,
    reviewerRole,
    rating,
    comment,
    moderationState: "pending",
    stateVersion: 1,
    sourceVersion: 1,
    createdAt: ts,
    updatedAt: ts,
    publishedProjectionId: null,
    moderatedByUid: null,
    moderatedAt: null,
    moderationReasonCode: null,
    redactionVersion: null,
    lastDecisionId: null,
    publicComment: null,
  };

  const created = await db.runTransaction(async (tx) => {
    const existing = await tx.get(reviewRef);
    if (existing.exists) return false;
    tx.set(reviewRef, doc);
    return true;
  });

  if (created) {
    await logAudit({
      eventType: "childcare_review_submitted",
      userId: uid,
      data: { reviewId, reviewerRole },
    }).catch(() => {});
  }
  return { success: true, reviewId, created, duplicate: !created, moderationState: "pending" };
}

export const submitChildcareReview = childcareOnCall("submitChildcareReview", async (data, context) => {
  const uid = requireAuth(context);
  const flags = await getChildcareFlags();
  if (!flags.writesEnabled) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Childcare features are not available yet.",
      { code: "childcare_disabled" },
    );
  }
  const rate = await checkRateLimit(`submitChildcareReview:${uid}`, REVIEW_MUTATION_RATE);
  if (!rate.allowed) {
    throw new functions.https.HttpsError(
      "resource-exhausted",
      "Too many requests. Please wait a moment and try again.",
    );
  }
  return submitChildcareReviewCore(uid, {
    bookingId: String(data?.bookingId ?? ""),
    rating: Number(data?.rating),
    comment: String(data?.comment ?? ""),
  });
});
