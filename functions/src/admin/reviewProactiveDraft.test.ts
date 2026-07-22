import { describe, expect, it, vi } from "vitest";

vi.mock("firebase-admin", () => {
  const stubFs = () => ({ collection: () => ({}) });
  return { __esModule: true, default: { firestore: stubFs }, firestore: stubFs };
});
vi.mock("firebase-functions/v1", () => ({
  __esModule: true,
  https: {
    onCall: (fn: unknown) => fn,
    HttpsError: class HttpsError extends Error {
      constructor(public code: string, message: string) { super(message); }
    },
  },
  runWith: () => ({ https: { onCall: (fn: unknown) => fn } }),
  pubsub: { schedule: () => ({ timeZone: () => ({ onRun: (fn: unknown) => fn }) }) },
}));

import { applyReviewDecision, reviewedContentHash } from "./reviewProactiveDraft";

const now = new Date("2026-07-22T22:00:00Z");
const pending = { status: "pending_review", draftText: "Rosie skipped meds 3 days running — want me to flag it to Dr. Patel?" };

describe("applyReviewDecision (U8/AE23)", () => {
  it("approve stamps reviewer, timestamp, and the immutable content hash", () => {
    const u = applyReviewDecision(pending, { decision: "approve" }, "admin-1", now);
    expect(u.status).toBe("approved");
    expect(u.reviewerUid).toBe("admin-1");
    expect(u.reviewedContentHash).toBe(reviewedContentHash(pending.draftText));
    expect(u.editedByReviewer).toBeUndefined();
  });

  it("an edit replaces the text and the hash covers the EDITED text", () => {
    const u = applyReviewDecision(pending, { decision: "approve", editedText: "Softer wording here." }, "admin-1", now);
    expect(u.draftText).toBe("Softer wording here.");
    expect(u.reviewedContentHash).toBe(reviewedContentHash("Softer wording here."));
    expect(u.editedByReviewer).toBe(true);
  });

  it("reject records reviewer without any hash", () => {
    const u = applyReviewDecision(pending, { decision: "reject" }, "admin-2", now);
    expect(u).toEqual({ status: "rejected", reviewerUid: "admin-2", rejectedAt: now.toISOString() });
  });

  it("only pending_review drafts can be decided (no double-review, no reviving)", () => {
    for (const status of ["approved", "rejected", "sent", "expired", undefined]) {
      expect(() => applyReviewDecision({ status, draftText: "x" }, { decision: "approve" }, "a", now))
        .toThrow(/not pending_review/);
    }
  });

  it("rejects empty and oversized approved text", () => {
    expect(() => applyReviewDecision(pending, { decision: "approve", editedText: "  " }, "a", now)).toThrow(/1-320/);
    expect(() => applyReviewDecision(pending, { decision: "approve", editedText: "x".repeat(321) }, "a", now)).toThrow(/1-320/);
  });

  it("hash detects post-review tampering (the sender-side check contract)", () => {
    const u = applyReviewDecision(pending, { decision: "approve" }, "admin-1", now);
    expect(reviewedContentHash("tampered text")).not.toBe(u.reviewedContentHash);
    expect(reviewedContentHash(pending.draftText)).toBe(u.reviewedContentHash);
  });
});
