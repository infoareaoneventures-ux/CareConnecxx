import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();
  const makeSnapshot = (path: string) => ({
    exists: docs.has(path),
    data: () => docs.get(path),
  });
  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => makeSnapshot(path),
  });
  const db: any = {
    collection: (path: string) => ({
      doc: (id: string) => makeDocRef(`${path}/${id}`),
    }),
    runTransaction: async (fn: any) => fn({
      get: async (ref: any) => ref.get(),
      set: (ref: any, data: any, opts?: any) => {
        docs.set(ref.path, opts?.merge ? { ...(docs.get(ref.path) ?? {}), ...data } : { ...data });
      },
      update: (ref: any, data: any) => {
        docs.set(ref.path, { ...(docs.get(ref.path) ?? {}), ...data });
      },
      delete: (ref: any) => {
        docs.delete(ref.path);
      },
    }),
  };
  return { docs, db };
});

vi.mock("firebase-admin", () => {
  const firestore: any = () => hoisted.db;
  firestore.Timestamp = { fromMillis: (millis: number) => ({ millis }) };
  firestore.FieldPath = { documentId: () => "__name__" };
  return {
    __esModule: true,
    default: { firestore, apps: [{}] },
    firestore,
    apps: [{}],
  };
});
vi.mock("../admin/requireOperatorScope", () => ({
  OPERATOR_SCOPE_CHILD_SAFETY: "childSafetyOperator",
  requireOperatorScope: vi.fn(async () => "operator-1"),
}));
vi.mock("./requireAppCheck", () => ({
  requireAppCheck: vi.fn(() => ({ verified: true, mode: "enforce" })),
}));

import {
  CHILDCARE_REVIEW_PUBLIC_PROJECTION_VERSION,
  childcarePublicReviewProjectionId,
  moderateChildcareReviewCore,
} from "./reviewModerationCallables";
import {
  CHILDCARE_REVIEW_SCHEMA_VERSION,
  CHILDCARE_REVIEW_SUBMISSIONS_COLLECTION,
} from "./reviewCallables";

const REVIEW_ID = "crev_review1";
const PRIVATE_PATH = `${CHILDCARE_REVIEW_SUBMISSIONS_COLLECTION}/${REVIEW_ID}`;

function seedPending(): void {
  hoisted.docs.set(PRIVATE_PATH, {
    schemaVersion: CHILDCARE_REVIEW_SCHEMA_VERSION,
    careVertical: "child",
    childcareBookingId: "booking-1",
    caregiverId: "caregiver-1",
    clientId: "family-1",
    reviewerUid: "family-1",
    reviewerRole: "family",
    rating: 5,
    comment: "Attentive and reliable",
    moderationState: "pending",
    stateVersion: 1,
    sourceVersion: 1,
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    publishedProjectionId: null,
    moderatedByUid: null,
    moderatedAt: null,
    moderationReasonCode: null,
    redactionVersion: null,
    lastDecisionId: null,
    publicComment: null,
  });
}

beforeEach(() => {
  hoisted.docs.clear();
  seedPending();
});

describe("childcare review moderation state machine", () => {
  it("publishes a separate deterministic projection and atomic audit", async () => {
    const result = await moderateChildcareReviewCore({
      reviewId: REVIEW_ID,
      expectedVersion: 1,
      decision: "published",
      reasonCode: "approve_safe",
      publicComment: "Attentive and reliable",
    }, "operator-1", { db: hoisted.db, now: new Date("2026-07-25T01:00:00.000Z") });

    const projectionId = childcarePublicReviewProjectionId(REVIEW_ID, 1);
    expect(result).toMatchObject({
      moderationState: "published",
      stateVersion: 2,
      projectionId,
      replayed: false,
    });
    expect(hoisted.docs.get(`reviews/${projectionId}`)).toMatchObject({
      schemaVersion: CHILDCARE_REVIEW_PUBLIC_PROJECTION_VERSION,
      careVertical: "child",
      sourceReviewId: REVIEW_ID,
      sourceStateVersion: 2,
      comment: "Attentive and reliable",
      isPublic: true,
      date: "2026-07-25T00:00:00.000Z",
    });
    expect(hoisted.docs.get(PRIVATE_PATH)).toMatchObject({
      moderationState: "published",
      stateVersion: 2,
      publishedProjectionId: projectionId,
      moderatedByUid: "operator-1",
    });
    expect(
      [...hoisted.docs.entries()].find(([path]) => path.startsWith("agent_audit_log/"))?.[1],
    ).toMatchObject({
      eventType: "childcare_review_moderated",
      userId: "operator-1",
    });
  });

  it("replays the exact decision without a second state transition", async () => {
    const input = {
      reviewId: REVIEW_ID,
      expectedVersion: 1,
      decision: "published" as const,
      reasonCode: "approve_safe" as const,
      publicComment: "Attentive and reliable",
    };
    await moderateChildcareReviewCore(input, "operator-1", { db: hoisted.db });
    const replay = await moderateChildcareReviewCore(input, "operator-1", { db: hoisted.db });
    expect(replay).toMatchObject({ replayed: true, stateVersion: 2 });
  });

  it("rejects stale versions, mismatched reasons, and recipient-sensitive text", async () => {
    await expect(moderateChildcareReviewCore({
      reviewId: REVIEW_ID,
      expectedVersion: 2,
      decision: "published",
      reasonCode: "approve_safe",
      publicComment: "Safe text",
    }, "operator-1", { db: hoisted.db })).rejects.toMatchObject({ code: "aborted" });

    await expect(moderateChildcareReviewCore({
      reviewId: REVIEW_ID,
      expectedVersion: 1,
      decision: "published",
      reasonCode: "reject_irrelevant",
      publicComment: "Safe text",
    }, "operator-1", { db: hoisted.db })).rejects.toMatchObject({ code: "invalid-argument" });

    await expect(moderateChildcareReviewCore({
      reviewId: REVIEW_ID,
      expectedVersion: 1,
      decision: "published",
      reasonCode: "approve_safe",
      publicComment: "Call 415-555-1212",
    }, "operator-1", { db: hoisted.db })).rejects.toMatchObject({
      code: "failed-precondition",
      details: { code: "public_comment_contains_sensitive_data" },
    });
  });

  it("unpublishes and then terminally deletes private content", async () => {
    const published = await moderateChildcareReviewCore({
      reviewId: REVIEW_ID,
      expectedVersion: 1,
      decision: "published",
      reasonCode: "approve_safe",
      publicComment: "Attentive and reliable",
    }, "operator-1", { db: hoisted.db });
    await moderateChildcareReviewCore({
      reviewId: REVIEW_ID,
      expectedVersion: 2,
      decision: "unpublished",
      reasonCode: "unpublish_policy",
    }, "operator-1", { db: hoisted.db });
    expect(hoisted.docs.has(`reviews/${published.projectionId}`)).toBe(false);

    await moderateChildcareReviewCore({
      reviewId: REVIEW_ID,
      expectedVersion: 3,
      decision: "deleted",
      reasonCode: "delete_retention",
    }, "operator-1", { db: hoisted.db });
    expect(hoisted.docs.get(PRIVATE_PATH)).toMatchObject({
      moderationState: "deleted",
      stateVersion: 4,
      comment: "",
      rating: 0,
      publishedProjectionId: null,
    });
  });
});
