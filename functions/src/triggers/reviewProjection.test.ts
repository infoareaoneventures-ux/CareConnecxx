// U8 review-projection routing tests (plan 2026-07-22-002, R45).
//
// The reviews collection is partitioned by vertical across two triggers:
// index.ts onReviewWritten (senior aggregate — skips childcare rows) and this
// trigger (childcare projection — skips senior rows). Both directions pinned.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("firebase-functions/v1", () => ({
  __esModule: true,
  default: {},
  firestore: {
    document: () => ({
      onWrite: (h: any) => h,
      onUpdate: (h: any) => h,
      onCreate: (h: any) => h,
    }),
  },
  pubsub: {
    schedule: () => ({
      onRun: (h: any) => h,
    }),
  },
}));

const recomputeMock = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../childcare/reputationProjection", () => ({
  recomputeChildcareCaregiverReputation: recomputeMock,
}));
const notifyMock = vi.hoisted(() => vi.fn(async () => ({ written: true })));
vi.mock("../notifications/userNotification", () => ({ writeUserNotification: notifyMock }));
const opsAlertMock = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../observability/caraOpsAlerts", () => ({
  createCaraOpsAlert: opsAlertMock,
}));
vi.mock("../childcare/reviewModerationCallables", () => ({
  CHILDCARE_REVIEW_PUBLIC_PROJECTION_VERSION: "childcare-review-public-v1",
  childcarePublicReviewProjectionId: (reviewId: string, sourceVersion: number) =>
    `projection_${reviewId}_${sourceVersion}`,
}));
vi.mock("../childcare/reviewCallables", () => ({
  CHILDCARE_REVIEW_SUBMISSIONS_COLLECTION: "childcare_review_submissions",
}));

import {
  onChildcareReviewWritten,
  reconcileChildcareReviewProjectionsCore,
} from "./reviewProjection";

/* eslint-disable @typescript-eslint/no-explicit-any */
const handler = onChildcareReviewWritten as any;

const change = (before: any, after: any) => ({
  before: { exists: before !== null, data: () => before },
  after: { exists: after !== null, data: () => after },
});
const ctx = { params: { reviewId: "r1" }, eventId: "evt-1" };

beforeEach(() => {
  recomputeMock.mockClear();
  notifyMock.mockClear();
  opsAlertMock.mockClear();
});

describe("reconcileChildcareReviewProjectionsCore", () => {
  function reconciliationDb(params: {
    published?: any[];
    pending?: any[];
    projectionExists?: boolean;
  }) {
    // Typed param so `projectionSet.mock.calls[0][0]` is the written document.
    const projectionSet = vi.fn(async (_data?: Record<string, unknown>, _opts?: Record<string, unknown>) => undefined);
    const privateSet = vi.fn(async () => undefined);
    const publishedDocs = (params.published ?? []).map((data, index) => ({
      id: data.id ?? `private-${index + 1}`,
      data: () => data,
      ref: { set: privateSet },
    }));
    const pendingDocs = (params.pending ?? []).map((data, index) => ({
      id: data.id ?? `pending-${index + 1}`,
      data: () => data,
      ref: { set: privateSet },
    }));
    const db: any = {
      collection: (name: string) => {
        if (name === "reviews") {
          return {
            doc: () => ({
              get: async () => ({ exists: params.projectionExists === true }),
              set: projectionSet,
            }),
          };
        }
        let state = "";
        const query: any = {
          where: (field: string, _op: string, value: string) => {
            if (field === "moderationState") state = value;
            return query;
          },
          limit: () => query,
          get: async () => {
            const docs = state === "published" ? publishedDocs : pendingDocs;
            return { docs, empty: docs.length === 0, size: docs.length };
          },
        };
        return query;
      },
    };
    return { db, projectionSet, privateSet };
  }

  it("repairs only an already-published projection and recomputes once", async () => {
    const row = {
      id: "private-review-1",
      careVertical: "child",
      moderationState: "published",
      stateVersion: 2,
      sourceVersion: 1,
      publishedProjectionId: null,
      caregiverId: "caregiver-1",
      reviewerRole: "family",
      rating: 5,
      comment: "raw private text",
      publicComment: "Approved public text",
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T01:00:00.000Z",
      moderatedAt: "2026-07-24T01:00:00.000Z",
    };
    const fake = reconciliationDb({ published: [row] });
    const now = new Date("2026-07-25T02:00:00.000Z");
    const result = await reconcileChildcareReviewProjectionsCore({ db: fake.db, now });

    expect(result).toEqual({ repaired: 1, pendingSlaMisses: 0 });
    expect(fake.projectionSet).toHaveBeenCalledWith(expect.objectContaining({
      sourceReviewId: "private-review-1",
      sourceStateVersion: 2,
      comment: "Approved public text",
      date: "2026-07-24T00:00:00.000Z",
    }));
    expect(JSON.stringify(fake.projectionSet.mock.calls[0][0])).not.toContain("raw private text");
    expect(fake.privateSet).toHaveBeenCalledWith(
      expect.objectContaining({ publishedProjectionId: expect.any(String) }),
      { merge: true },
    );
    expect(recomputeMock).toHaveBeenCalledWith("caregiver-1", { db: fake.db, now });
  });

  it("never promotes pending content and alerts on the overdue queue", async () => {
    const pending = [{
      id: "pending-review-1",
      careVertical: "child",
      moderationState: "pending",
      comment: "unmoderated private text",
    }];
    const fake = reconciliationDb({ pending });
    const result = await reconcileChildcareReviewProjectionsCore({
      db: fake.db,
      now: new Date("2026-07-25T02:00:00.000Z"),
    });

    expect(result).toEqual({ repaired: 0, pendingSlaMisses: 1 });
    expect(fake.projectionSet).not.toHaveBeenCalled();
    expect(recomputeMock).not.toHaveBeenCalled();
    expect(opsAlertMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "childcare_review_moderation_sla",
      context: { count: 1, window: "24h" },
    }));
  });
});

describe("onChildcareReviewWritten (R45 — childcare half of the vertical partition)", () => {
  it("a childcare review CREATE recomputes the childcare projection and notifies generically", async () => {
    await handler(
      change(null, { careVertical: "child", caregiverId: "cg-1", rating: 5, comment: "x" }),
      ctx,
    );
    expect(recomputeMock).toHaveBeenCalledWith("cg-1");
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const payload = (notifyMock.mock.calls[0] as unknown[])[0] as any;
    expect(payload.recipientId).toBe("cg-1");
    // Generic child-safe body — no reviewer name, no child data, no comment text.
    expect(payload.body).not.toContain("x");
    expect(JSON.stringify(payload)).not.toContain("child-a");
  });

  it("a SENIOR review is a structural no-op here (isolation direction 1)", async () => {
    await handler(change(null, { caregiverId: "cg-1", rating: 5, clientName: "Ann" }), ctx);
    await handler(change(null, { careVertical: "senior", caregiverId: "cg-1", rating: 5 }), ctx);
    expect(recomputeMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("a childcare review DELETE still recomputes (aggregates shrink) without a notification", async () => {
    await handler(change({ careVertical: "child", caregiverId: "cg-1", rating: 5 }, null), ctx);
    expect(recomputeMock).toHaveBeenCalledWith("cg-1");
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("a notification failure never blocks the projection recompute", async () => {
    notifyMock.mockRejectedValueOnce(new Error("boom"));
    await handler(change(null, { careVertical: "child", caregiverId: "cg-1", rating: 4 }), ctx);
    expect(recomputeMock).toHaveBeenCalledWith("cg-1");
  });
});

describe("index.ts onReviewWritten (senior half — source characterization)", () => {
  it("skips childcare rows entirely and filters them out of the senior aggregate", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "index.ts"),
      "utf8",
    );
    // Guard 1: childcare rows return before any senior work.
    expect(src).toContain("(after ?? before)?.careVertical === 'child'");
    // Guard 2: the senior recompute filters childcare rows from the result set
    // (a senior review write for a dual-vertical caregiver must not fold
    // childcare ratings into caregivers.rating — isolation direction 2).
    expect(src).toContain(".filter(r => r.careVertical !== 'child')");
  });
});
