// U8 per-vertical reputation tests (plan 2026-07-22-002, R45/KTD15, AE11).
//
// Cross-vertical isolation BOTH directions: childcare aggregates never include
// senior reviews; the childcare recompute never touches the senior
// caregivers.rating/reviewCount or the unprefixed caregiver_reputation fields.
// Plus reliability/repeat-booking math and the public summary shape.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeDb } from "./__tests__/fakeFirestore";

vi.mock("firebase-admin", () => {
  const firestore: any = () => { throw new Error("tests must inject db"); };
  return { __esModule: true, default: { firestore, apps: [{}] }, firestore, apps: [{}] };
});

import {
  computeChildcareReputation,
  recomputeChildcareCaregiverReputation,
  toChildcareReputationSummary,
  CHILDCARE_REPUTATION_SUMMARY_FIELD,
  CHILDCARE_REPUTATION_VERSION,
} from "./reputationProjection";

const NOW = new Date("2026-07-23T18:00:00.000Z");
const CG = "cg-1";

const childReview = (rating: number, extra: Record<string, unknown> = {}) => ({
  careVertical: "child" as const,
  caregiverId: CG,
  rating,
  moderationState: "published",
  ...extra,
});
const seniorReview = (rating: number) => ({ caregiverId: CG, rating });

const childBooking = (status: string, extra: Record<string, unknown> = {}) => ({
  careVertical: "child" as const,
  caregiverId: CG,
  status,
  clientId: "family-1",
  ...extra,
});

describe("computeChildcareReputation (pure — R45 both directions)", () => {
  it("aggregates ONLY childcare reviews; senior rows are structurally excluded", () => {
    const agg = computeChildcareReputation(
      [childReview(5), childReview(4), seniorReview(1) as never, { careVertical: "senior", rating: 1 } as never],
      [],
      NOW,
    );
    expect(agg.childRatingCount).toBe(2);
    expect(agg.childRatingAvg).toBe(4.5);
  });

  it("excludes removed-moderation reviews and invalid ratings", () => {
    const agg = computeChildcareReputation(
      [childReview(5), childReview(1, { moderationState: "removed" }), childReview(99 as never)],
      [],
      NOW,
    );
    expect(agg.childRatingCount).toBe(1);
    expect(agg.childRatingAvg).toBe(5);
  });

  it("computes reliability, response, and repeat-booking from childcare bookings only", () => {
    const agg = computeChildcareReputation(
      [],
      [
        childBooking("completed", { clientId: "family-1" }),
        childBooking("completed", { clientId: "family-1" }),
        childBooking("completed", { clientId: "family-2" }),
        childBooking("canceled", { cancelActor: "provider" }),
        childBooking("canceled", { cancelActor: "family" }),
        childBooking("requested"),
        { caregiverId: CG, status: "completed", clientId: "family-9" } as never, // senior booking — excluded
      ],
      NOW,
    );
    expect(agg.childCompletedBookingCount).toBe(3);
    expect(agg.childProviderCancelCount).toBe(1);
    expect(agg.childFamilyCancelCount).toBe(1);
    expect(agg.childRepeatFamilyCount).toBe(1); // family-1 completed twice
    expect(agg.childRequestCount).toBe(6);
    expect(agg.childRespondedRequestCount).toBe(5);
    expect(agg.childCompletionRate).toBe(0.75); // 3 / (3 + 1)
    expect(agg.childResponseRate).toBe(0.83);
    expect(agg.childReputationVersion).toBe(CHILDCARE_REPUTATION_VERSION);
  });

  it("no history means neutral rates (1) and zero counts", () => {
    const agg = computeChildcareReputation([], [], NOW);
    expect(agg.childCompletionRate).toBe(1);
    expect(agg.childResponseRate).toBe(1);
    expect(agg.childRatingAvg).toBe(0);
  });

  it("the public summary carries numbers only", () => {
    const agg = computeChildcareReputation([childReview(5)], [childBooking("completed")], NOW);
    expect(toChildcareReputationSummary(agg)).toEqual({
      ratingAvg: 5,
      ratingCount: 1,
      completedBookings: 1,
      repeatFamilies: 0,
      updatedAt: NOW.toISOString(),
    });
  });
});

describe("recomputeChildcareCaregiverReputation (Firestore writes — R45 isolation)", () => {
  let fake: ReturnType<typeof makeFakeDb>;
  beforeEach(() => {
    fake = makeFakeDb();
  });

  it("writes ONLY child-prefixed fields; senior aggregate fields are never touched", async () => {
    fake.seed(`caregivers/${CG}`, { name: "Pat", rating: 4.9, reviewCount: 12 });
    fake.seed(`caregiver_reputation/${CG}`, { score: 3.2, lastOutcomeAt: 111, hireCount: 4, passCount: 1 });
    fake.seed("reviews/r1", childReview(4, { childcareBookingId: "cbook_1" }));
    fake.seed("reviews/r2", seniorReview(1)); // senior review for the SAME caregiver
    fake.seed("booking_requests/b1", childBooking("completed"));

    const agg = await recomputeChildcareCaregiverReputation(CG, { db: fake.db as never, now: NOW });
    expect(agg?.childRatingCount).toBe(1);
    expect(agg?.childRatingAvg).toBe(4); // senior review r2 excluded (AE11)

    const rep = fake.get(`caregiver_reputation/${CG}`)!;
    // Senior unprefixed fields byte-identical.
    expect(rep.score).toBe(3.2);
    expect(rep.lastOutcomeAt).toBe(111);
    expect(rep.hireCount).toBe(4);
    // Child-prefixed aggregates merged in.
    expect(rep.childRatingAvg).toBe(4);
    expect(rep.childCompletedBookingCount).toBe(1);

    const cg = fake.get(`caregivers/${CG}`)!;
    // Senior public aggregate untouched; sibling summary added.
    expect(cg.rating).toBe(4.9);
    expect(cg.reviewCount).toBe(12);
    expect(cg[CHILDCARE_REPUTATION_SUMMARY_FIELD]).toMatchObject({ ratingAvg: 4, ratingCount: 1 });
  });

  it("never materializes a phantom caregiver doc", async () => {
    fake.seed("reviews/r1", childReview(5));
    await recomputeChildcareCaregiverReputation(CG, { db: fake.db as never, now: NOW });
    expect(fake.get(`caregivers/${CG}`)).toBeUndefined();
    expect(fake.get(`caregiver_reputation/${CG}`)?.childRatingAvg).toBe(5);
  });

  it("fails soft (returns null, never throws into a trigger)", async () => {
    const broken = { collection: () => { throw new Error("boom"); } };
    await expect(
      recomputeChildcareCaregiverReputation(CG, { db: broken as never, now: NOW }),
    ).resolves.toBeNull();
  });
});
