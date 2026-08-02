import * as admin from "firebase-admin";
import * as functions from "firebase-functions/v1";
import { createHash } from "crypto";
import {
  OPERATOR_SCOPE_CHILD_SAFETY,
  requireOperatorScope,
} from "../admin/requireOperatorScope";
import { childcareOnCall } from "./appCheckPolicy";
import {
  CHILDCARE_REVIEW_SUBMISSIONS_COLLECTION,
  type ChildcareReviewState,
  type ChildcareReviewSubmissionDoc,
} from "./reviewCallables";
import { buildChildcareOperatorAuditRecord } from "./operatorAudit";

export const CHILDCARE_REVIEW_REDACTION_VERSION = "operator-redaction-v1";
export const CHILDCARE_REVIEW_PUBLIC_PROJECTION_VERSION = "childcare-review-public-v1";

export const CHILDCARE_REVIEW_REASON_CODES = [
  "moderation_queue_review",
  "approve_safe",
  "reject_child_pii",
  "reject_abuse",
  "reject_irrelevant",
  "unpublish_policy",
  "delete_retention",
] as const;

export type ChildcareReviewReasonCode = typeof CHILDCARE_REVIEW_REASON_CODES[number];
export type ChildcareReviewDecision = "published" | "rejected" | "unpublished" | "deleted";

const ALLOWED_TRANSITIONS: Record<ChildcareReviewState, ChildcareReviewDecision[]> = {
  pending: ["published", "rejected"],
  published: ["unpublished"],
  rejected: ["deleted"],
  unpublished: ["deleted"],
  deleted: [],
};

const DECISION_REASON_CODES: Record<ChildcareReviewDecision, readonly ChildcareReviewReasonCode[]> = {
  published: ["approve_safe"],
  rejected: ["reject_child_pii", "reject_abuse", "reject_irrelevant"],
  unpublished: ["unpublish_policy"],
  deleted: ["delete_retention"],
};

const PHONE_LIKE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
const EMAIL_LIKE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const EXACT_DATE = /\b(?:19|20)\d{2}[-/](?:0?[1-9]|1[0-2])[-/](?:0?[1-9]|[12]\d|3[01])\b/;
const STREET_ADDRESS = /\b\d{1,6}\s+[A-Za-z0-9.' -]{2,60}\s(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|court|ct|way|place|pl)\b/i;

function permissionDenied(): functions.https.HttpsError {
  return new functions.https.HttpsError(
    "permission-denied",
    "You do not have permission to perform this action.",
  );
}

function invalidArgument(message = "Invalid request."): functions.https.HttpsError {
  return new functions.https.HttpsError("invalid-argument", message);
}

function requireReasonCode(value: unknown): ChildcareReviewReasonCode {
  const code = String(value ?? "").trim() as ChildcareReviewReasonCode;
  if (!(CHILDCARE_REVIEW_REASON_CODES as readonly string[]).includes(code)) {
    throw invalidArgument("A valid moderation reason is required.");
  }
  return code;
}

export function assertRecipientSafeReviewComment(value: unknown): string {
  const comment = String(value ?? "").trim().slice(0, 1200);
  if (
    PHONE_LIKE.test(comment) ||
    EMAIL_LIKE.test(comment) ||
    EXACT_DATE.test(comment) ||
    STREET_ADDRESS.test(comment) ||
    /\b(?:ssn|social security|date of birth|dob)\b/i.test(comment)
  ) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Remove personal child or contact information before publishing.",
      { code: "public_comment_contains_sensitive_data" },
    );
  }
  return comment;
}

export function childcarePublicReviewProjectionId(reviewId: string, sourceVersion: number): string {
  const hash = createHash("sha256")
    .update(`childcare-review-public:${reviewId}:${sourceVersion}`)
    .digest("hex")
    .slice(0, 40);
  return `crevp_${hash}`;
}

function decisionId(params: {
  reviewId: string;
  expectedVersion: number;
  decision: ChildcareReviewDecision;
  operatorUid: string;
  reasonCode: ChildcareReviewReasonCode;
}): string {
  return createHash("sha256")
    .update([
      params.reviewId,
      params.expectedVersion,
      params.decision,
      params.operatorUid,
      params.reasonCode,
    ].join("|"))
    .digest("hex");
}

interface QueueCursor {
  createdAt: string;
  reviewId: string;
}

function encodeCursor(cursor: QueueCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: unknown): QueueCursor | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8")) as QueueCursor;
    if (!decoded.createdAt || !decoded.reviewId) return null;
    return decoded;
  } catch {
    throw invalidArgument("Invalid cursor.");
  }
}

export const listChildcareReviewModerationQueue = childcareOnCall("listChildcareReviewModerationQueue", async (data, context) => {
  const reasonCode = requireReasonCode(data?.reasonCode);
  if (reasonCode !== "moderation_queue_review") throw invalidArgument("Invalid queue reason.");
  await requireOperatorScope(context, OPERATOR_SCOPE_CHILD_SAFETY, {
    recentAuth: true,
    access: {
      action: "childcare_review_queue_read",
      objectRef: "pending",
      reason: reasonCode,
    },
  });

  const pageSize = Math.max(1, Math.min(50, Number(data?.pageSize) || 25));
  const cursor = decodeCursor(data?.cursor);
  let query: FirebaseFirestore.Query = admin.firestore()
    .collection(CHILDCARE_REVIEW_SUBMISSIONS_COLLECTION)
    .where("moderationState", "==", "pending")
    .orderBy("createdAt", "asc")
    .orderBy(admin.firestore.FieldPath.documentId(), "asc")
    .limit(pageSize + 1);
  if (cursor) query = query.startAfter(cursor.createdAt, cursor.reviewId);

  const snap = await query.get();
  const docs = snap.docs.slice(0, pageSize);
  const rows = docs.map((doc) => {
    const row = doc.data() as ChildcareReviewSubmissionDoc;
    return {
      reviewId: doc.id,
      bookingId: row.childcareBookingId,
      caregiverId: row.caregiverId,
      reviewerRole: row.reviewerRole,
      rating: row.rating,
      comment: row.comment,
      createdAt: row.createdAt,
      stateVersion: row.stateVersion,
    };
  });
  const last = docs[docs.length - 1];
  return {
    rows,
    nextCursor: snap.docs.length > pageSize && last
      ? encodeCursor({ createdAt: String(last.data().createdAt), reviewId: last.id })
      : null,
  };
});

export async function moderateChildcareReviewCore(
  input: {
    reviewId: string;
    expectedVersion: number;
    decision: ChildcareReviewDecision;
    reasonCode: ChildcareReviewReasonCode;
    publicComment?: string;
  },
  operatorUid: string,
  opts: { db?: admin.firestore.Firestore; now?: Date } = {},
): Promise<{
  success: true;
  reviewId: string;
  moderationState: ChildcareReviewState;
  stateVersion: number;
  projectionId: string | null;
  replayed: boolean;
}> {
  const db = opts.db ?? admin.firestore();
  const now = opts.now ?? new Date();
  const reviewId = String(input.reviewId ?? "").trim();
  const expectedVersion = Number(input.expectedVersion);
  if (!reviewId || reviewId.length > 128 || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw invalidArgument();
  }
  if (!["published", "rejected", "unpublished", "deleted"].includes(input.decision)) {
    throw invalidArgument();
  }
  const reasonCode = requireReasonCode(input.reasonCode);
  if (!DECISION_REASON_CODES[input.decision]?.includes(reasonCode)) {
    throw invalidArgument("The moderation reason does not match the requested decision.");
  }
  const idempotencyKey = decisionId({
    reviewId,
    expectedVersion,
    decision: input.decision,
    operatorUid,
    reasonCode,
  });
  const privateRef = db.collection(CHILDCARE_REVIEW_SUBMISSIONS_COLLECTION).doc(reviewId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(privateRef);
    if (!snap.exists) throw permissionDenied();
    const current = snap.data() as ChildcareReviewSubmissionDoc;
    if (current.careVertical !== "child") throw permissionDenied();
    if (current.lastDecisionId === idempotencyKey) {
      return {
        success: true as const,
        reviewId,
        moderationState: current.moderationState,
        stateVersion: current.stateVersion,
        projectionId: current.publishedProjectionId,
        replayed: true,
      };
    }
    if (current.stateVersion !== expectedVersion) {
      throw new functions.https.HttpsError(
        "aborted",
        "This review changed. Refresh the queue and try again.",
        { code: "stale_review_version" },
      );
    }
    if (!ALLOWED_TRANSITIONS[current.moderationState]?.includes(input.decision)) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "This moderation transition is no longer available.",
        { code: "invalid_moderation_transition" },
      );
    }

    const ts = now.toISOString();
    const nextVersion = current.stateVersion + 1;
    let projectionId = current.publishedProjectionId;
    let publicComment = current.publicComment;
    if (input.decision === "published") {
      publicComment = assertRecipientSafeReviewComment(input.publicComment ?? current.comment);
      projectionId = childcarePublicReviewProjectionId(reviewId, current.sourceVersion);
      tx.set(db.collection("reviews").doc(projectionId), {
        schemaVersion: CHILDCARE_REVIEW_PUBLIC_PROJECTION_VERSION,
        careVertical: "child",
        sourceReviewId: reviewId,
        sourceVersion: current.sourceVersion,
        sourceStateVersion: nextVersion,
        caregiverId: current.caregiverId,
        reviewerRole: current.reviewerRole,
        rating: current.rating,
        comment: publicComment,
        moderationState: "published",
        isPublic: true,
        createdAt: current.createdAt,
        date: current.createdAt,
        publishedAt: ts,
      });
    } else if (projectionId) {
      tx.delete(db.collection("reviews").doc(projectionId));
      projectionId = null;
    }

    const next: Partial<ChildcareReviewSubmissionDoc> = {
      moderationState: input.decision,
      stateVersion: nextVersion,
      updatedAt: ts,
      publishedProjectionId: projectionId,
      moderatedByUid: operatorUid,
      moderatedAt: ts,
      moderationReasonCode: reasonCode,
      redactionVersion:
        input.decision === "published" ? CHILDCARE_REVIEW_REDACTION_VERSION : current.redactionVersion,
      lastDecisionId: idempotencyKey,
      publicComment,
      ...(input.decision === "deleted" ? { comment: "", rating: 0 } : {}),
    };
    tx.update(privateRef, next);

    const auditRef = db.collection("agent_audit_log").doc(`review_${idempotencyKey}`);
    tx.set(auditRef, buildChildcareOperatorAuditRecord({
      eventType: "childcare_review_moderated",
      actorUid: operatorUid,
      objectRef: reviewId,
      reasonCode,
      details: {
        fromState: current.moderationState,
        toState: input.decision,
        sourceVersion: current.sourceVersion,
        stateVersion: nextVersion,
        redactionVersion:
          input.decision === "published" ? CHILDCARE_REVIEW_REDACTION_VERSION : null,
      },
      now,
    }));

    return {
      success: true as const,
      reviewId,
      moderationState: input.decision,
      stateVersion: nextVersion,
      projectionId,
      replayed: false,
    };
  });
}

export const moderateChildcareReview = childcareOnCall("moderateChildcareReview", async (data, context) => {
  const reasonCode = requireReasonCode(data?.reasonCode);
  const reviewId = String(data?.reviewId ?? "").trim();
  const operatorUid = await requireOperatorScope(context, OPERATOR_SCOPE_CHILD_SAFETY, {
    recentAuth: true,
    access: {
      action: `childcare_review_${String(data?.decision ?? "unknown")}`,
      objectRef: reviewId,
      reason: reasonCode,
    },
  });
  return moderateChildcareReviewCore({
    reviewId,
    expectedVersion: Number(data?.expectedVersion),
    decision: String(data?.decision ?? "") as ChildcareReviewDecision,
    reasonCode,
    publicComment: typeof data?.publicComment === "string" ? data.publicComment : undefined,
  }, operatorUid);
});
