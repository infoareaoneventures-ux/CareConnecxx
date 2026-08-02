// U8 childcare review tests (plan 2026-07-22-002, R44/KTD15).
//
// Scenarios: review before completion rejected; participants only; once per
// reviewer+booking (duplicate idempotent — AE15); the STORED doc carries the
// pinned recipient-safe key set and NO child fields; moderation state present;
// flags-off fails closed.

import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();
  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
    set: async (data: any, opts?: any) => {
      docs.set(path, opts?.merge ? { ...(docs.get(path) ?? {}), ...data } : { ...data });
    },
    update: async (data: any) => {
      docs.set(path, { ...(docs.get(path) ?? {}), ...data });
    },
  });
  const db = {
    collection: (p: string) => ({ doc: (id: string) => makeDocRef(`${p}/${id}`) }),
    runTransaction: async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => void ref.set(data, opts),
        update: (ref: any, data: any) => void ref.update(data),
      }),
  };
  return { docs, db, reset: () => docs.clear() };
});

vi.mock("firebase-admin", () => {
  const firestore: any = () => hoisted.db;
  return { __esModule: true, default: { firestore, apps: [{}] }, firestore, apps: [{}] };
});
vi.mock("../observability/auditLog", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("./requireAppCheck", () => ({ requireAppCheck: vi.fn(() => ({ verified: true, mode: "monitor" })) }));
vi.mock("../rateLimit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));
const flagsMock = vi.hoisted(() => vi.fn(async () => ({ enabled: true, writesEnabled: true })));
// childcareOnCall (appCheckPolicy) reads getChildcareAppCheckConfig on every
// wrapped callable invocation, so the mock must export it too.
vi.mock("../config/featureFlags", () => ({
  getChildcareFlags: flagsMock,
  getChildcareAppCheckConfig: vi.fn(async () => ({
    mode: "monitor",
    source: "default",
    transitionRecorded: false,
    transitionAt: null,
    providerRegistrationVerified: false,
    debugTokensAllowed: false,
    verifiedDomains: [],
  })),
}));

import {
  submitChildcareReview as _submit,
  childcareReviewDocId,
  CHILDCARE_REVIEW_PRIVATE_KEYS,
  CHILDCARE_REVIEW_SUBMISSIONS_COLLECTION,
} from "./reviewCallables";

/* eslint-disable @typescript-eslint/no-explicit-any */
const submitReview = _submit as any;

const FAMILY = "family-1";
const CG = "cg-1";
const BOOKING = "cbook_rev1";

function ctx(uid: string): any {
  return { auth: { uid }, app: { appId: "test-app" } };
}

function seedBooking(status = "completed") {
  hoisted.docs.set(`booking_requests/${BOOKING}`, {
    careVertical: "child",
    bookingId: BOOKING,
    clientId: FAMILY,
    caregiverId: CG,
    childIds: ["child-a"],
    recipientLabel: "M.",
    householdId: "hh_family-1",
    status,
  });
}

beforeEach(() => {
  hoisted.reset();
  flagsMock.mockResolvedValue({ enabled: true, writesEnabled: true } as any);
});

describe("submitChildcareReview (R44 — server-only, booking-bound)", () => {
  it("rejects a review BEFORE verified completion", async () => {
    seedBooking("in_progress");
    await expect(
      submitReview({ bookingId: BOOKING, rating: 5, comment: "great" }, ctx(FAMILY)),
    ).rejects.toMatchObject({ details: { code: "booking_not_completed" } });
  });

  it("participants only — a non-participant adult is denied (enumeration-safe)", async () => {
    seedBooking();
    await expect(
      submitReview({ bookingId: BOOKING, rating: 5, comment: "x" }, ctx("stranger-1")),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("a senior booking can never be reviewed through the childcare callable", async () => {
    hoisted.docs.set(`booking_requests/${BOOKING}`, {
      bookingId: BOOKING, clientId: FAMILY, caregiverId: CG, status: "completed",
    });
    await expect(
      submitReview({ bookingId: BOOKING, rating: 5, comment: "x" }, ctx(FAMILY)),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("family review: raw content is private and pending with no public projection", async () => {
    seedBooking();
    const res = await submitReview({ bookingId: BOOKING, rating: 5, comment: "Wonderful care" }, ctx(FAMILY));
    expect(res).toMatchObject({
      success: true,
      created: true,
      duplicate: false,
      moderationState: "pending",
    });
    expect(res.reviewId).toBe(childcareReviewDocId(BOOKING, FAMILY));

    const doc = hoisted.docs.get(`${CHILDCARE_REVIEW_SUBMISSIONS_COLLECTION}/${res.reviewId}`);
    expect(Object.keys(doc).sort()).toEqual([...CHILDCARE_REVIEW_PRIVATE_KEYS].sort());
    expect(doc).toMatchObject({
      careVertical: "child",
      childcareBookingId: BOOKING,
      caregiverId: CG,
      clientId: FAMILY,
      reviewerUid: FAMILY,
      reviewerRole: "family",
      rating: 5,
      moderationState: "pending",
      stateVersion: 1,
      sourceVersion: 1,
      publishedProjectionId: null,
    });
    expect(hoisted.docs.has(`reviews/${res.reviewId}`)).toBe(false);
    for (const banned of ["childIds", "recipientLabel", "householdId", "recipientRef", "childName"]) {
      expect(doc[banned]).toBeUndefined();
    }
  });

  it("provider review: the assigned caregiver may review the family once", async () => {
    seedBooking();
    const res = await submitReview({ bookingId: BOOKING, rating: 4, comment: "Kind family" }, ctx(CG));
    expect(res.created).toBe(true);
    expect(
      hoisted.docs.get(`${CHILDCARE_REVIEW_SUBMISSIONS_COLLECTION}/${res.reviewId}`).reviewerRole,
    ).toBe("provider");
  });

  it("duplicate review is IDEMPOTENT — one doc per reviewer+booking (AE15)", async () => {
    seedBooking();
    const first = await submitReview({ bookingId: BOOKING, rating: 5, comment: "a" }, ctx(FAMILY));
    const second = await submitReview({ bookingId: BOOKING, rating: 1, comment: "changed my mind" }, ctx(FAMILY));
    expect(second).toMatchObject({ created: false, duplicate: true, reviewId: first.reviewId });
    // The original review is untouched (no silent overwrite).
    expect(
      hoisted.docs.get(`${CHILDCARE_REVIEW_SUBMISSIONS_COLLECTION}/${first.reviewId}`).rating,
    ).toBe(5);
    // Family and provider reviews are distinct docs.
    const provider = await submitReview({ bookingId: BOOKING, rating: 4, comment: "b" }, ctx(CG));
    expect(provider.reviewId).not.toBe(first.reviewId);
    expect(
      [...hoisted.docs.keys()].filter((p) =>
        p.startsWith(`${CHILDCARE_REVIEW_SUBMISSIONS_COLLECTION}/`)),
    ).toHaveLength(2);
    expect([...hoisted.docs.keys()].filter((p) => p.startsWith("reviews/"))).toHaveLength(0);
  });

  it("validates rating bounds and booking id", async () => {
    seedBooking();
    for (const rating of [0, 6, 4.5, NaN]) {
      await expect(
        submitReview({ bookingId: BOOKING, rating, comment: "x" }, ctx(FAMILY)),
      ).rejects.toMatchObject({ code: "invalid-argument" });
    }
    await expect(submitReview({ bookingId: "", rating: 5 }, ctx(FAMILY))).rejects.toMatchObject({
      code: "invalid-argument",
    });
  });

  it("fails closed when childcare writes are disabled (R61)", async () => {
    seedBooking();
    flagsMock.mockResolvedValue({ enabled: true, writesEnabled: false } as any);
    await expect(
      submitReview({ bookingId: BOOKING, rating: 5, comment: "x" }, ctx(FAMILY)),
    ).rejects.toMatchObject({ details: { code: "childcare_disabled" } });
  });
});
