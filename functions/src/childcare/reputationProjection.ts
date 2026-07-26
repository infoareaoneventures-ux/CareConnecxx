// ── Childcare reputation projection (plan 2026-07-22-002, U8 / R45, KTD15) ───
//
// Per-vertical caregiver reputation aggregates for the CHILD vertical:
// rating, reliability (completion/cancellation), response, and repeat-booking
// signals — computed EXCLUSIVELY from childcare reviews and childcare
// bookings. Senior reviews/outcomes can never enter these aggregates and the
// childcare aggregates never touch the senior fields (caregivers.rating /
// reviewCount / caregiver_reputation's unprefixed fields) — both directions
// are pinned by tests.
//
// Storage:
//   • caregiver_reputation/{uid}: child-prefixed aggregate fields (the U6
//     home for U8 outcome writers) — merge-only, never the senior fields.
//   • caregivers/{uid}.childcareReputationSummary: a SIBLING parent field
//     (deliberately not nested inside the U5 `childcareProvider` summary,
//     which recomputeChildcareProviderVisibility rewrites wholesale). The
//     caregivers onWrite projection then exposes a per-vertical label block
//     on publicCaregiverProfiles via the extended allowlist — only while the
//     provider is childcare-visible.

import * as admin from "firebase-admin";

export const CHILDCARE_REPUTATION_VERSION = "childcare-reputation-2026-07-23.1";

/** Sibling parent field on caregivers/{uid} (public projection source). */
export const CHILDCARE_REPUTATION_SUMMARY_FIELD = "childcareReputationSummary";

type Db = Pick<admin.firestore.Firestore, "collection" | "runTransaction">;

export interface ChildcareReputationAggregates {
  childRatingAvg: number;
  childRatingCount: number;
  childCompletedBookingCount: number;
  childProviderCancelCount: number;
  childFamilyCancelCount: number;
  childRepeatFamilyCount: number;
  childRespondedRequestCount: number;
  childRequestCount: number;
  /** completed / (completed + provider cancels); 1 when no history. */
  childCompletionRate: number;
  /** responded (accepted or declined) / requests seen; 1 when no history. */
  childResponseRate: number;
  childReputationVersion: string;
  childReputationUpdatedAt: string;
}

interface ReviewRowLike {
  careVertical?: unknown;
  rating?: unknown;
  moderationState?: unknown;
}

interface BookingRowLike {
  careVertical?: unknown;
  status?: unknown;
  clientId?: unknown;
  cancelActor?: unknown;
  lastTransition?: { event?: unknown } | null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Pure per-vertical aggregate computation. Defensive: any row that is not
 * explicitly careVertical:"child" is EXCLUDED (a senior row reaching this
 * function is a caller bug, and it still cannot contaminate the aggregate).
 */
export function computeChildcareReputation(
  reviews: ReviewRowLike[],
  bookings: BookingRowLike[],
  now: Date,
): ChildcareReputationAggregates {
  const childReviews = reviews.filter(
    (r) =>
      r.careVertical === "child" &&
      r.moderationState !== "removed" &&
      typeof r.rating === "number" &&
      Number.isFinite(r.rating) &&
      (r.rating as number) >= 1 &&
      (r.rating as number) <= 5,
  );
  const ratingCount = childReviews.length;
  const ratingAvg = ratingCount
    ? round1(childReviews.reduce((s, r) => s + (r.rating as number), 0) / ratingCount)
    : 0;

  const childBookings = bookings.filter((b) => b.careVertical === "child");
  let completed = 0;
  let providerCancels = 0;
  let familyCancels = 0;
  let responded = 0;
  const completedByFamily = new Map<string, number>();
  for (const b of childBookings) {
    const status = String(b.status ?? "");
    if (status === "completed") {
      completed++;
      const family = String(b.clientId ?? "");
      if (family) completedByFamily.set(family, (completedByFamily.get(family) ?? 0) + 1);
    } else if (status === "canceled") {
      if (b.cancelActor === "provider") providerCancels++;
      else familyCancels++;
    }
    // "Responded" = the request left the requested state via a provider
    // decision or later lifecycle (accepted/declined/confirmed/…).
    if (status !== "requested") responded++;
  }
  const repeatFamilies = [...completedByFamily.values()].filter((n) => n >= 2).length;
  const requestCount = childBookings.length;

  return {
    childRatingAvg: ratingAvg,
    childRatingCount: ratingCount,
    childCompletedBookingCount: completed,
    childProviderCancelCount: providerCancels,
    childFamilyCancelCount: familyCancels,
    childRepeatFamilyCount: repeatFamilies,
    childRespondedRequestCount: responded,
    childRequestCount: requestCount,
    childCompletionRate:
      completed + providerCancels > 0 ? round2(completed / (completed + providerCancels)) : 1,
    childResponseRate: requestCount > 0 ? round2(responded / requestCount) : 1,
    childReputationVersion: CHILDCARE_REPUTATION_VERSION,
    childReputationUpdatedAt: now.toISOString(),
  };
}

/** The public per-vertical label block (numbers only — no evidence claims). */
export interface ChildcareReputationSummary {
  ratingAvg: number;
  ratingCount: number;
  completedBookings: number;
  repeatFamilies: number;
  updatedAt: string;
}

export function toChildcareReputationSummary(
  agg: ChildcareReputationAggregates,
): ChildcareReputationSummary {
  return {
    ratingAvg: agg.childRatingAvg,
    ratingCount: agg.childRatingCount,
    completedBookings: agg.childCompletedBookingCount,
    repeatFamilies: agg.childRepeatFamilyCount,
    updatedAt: agg.childReputationUpdatedAt,
  };
}

/**
 * Recompute + persist a caregiver's CHILD-vertical reputation. Reads ONLY
 * childcare-stamped reviews (Q40) and childcare bookings (Q34); writes ONLY
 * child-prefixed caregiver_reputation fields plus the sibling caregivers
 * summary field. Never throws into a trigger; a failure never blocks the
 * review write itself.
 */
export async function recomputeChildcareCaregiverReputation(
  caregiverUid: string,
  opts: { db?: Db; now?: Date } = {},
): Promise<ChildcareReputationAggregates | null> {
  try {
    const db = opts.db ?? (admin.firestore() as Db);
    const now = opts.now ?? new Date();
    if (!caregiverUid) return null;

    const [reviewSnap, bookingSnap] = await Promise.all([
      db
        .collection("reviews")
        .where("careVertical", "==", "child")
        .where("caregiverId", "==", caregiverUid)
        .get(),
      db
        .collection("booking_requests")
        .where("careVertical", "==", "child")
        .where("caregiverId", "==", caregiverUid)
        .get(),
    ]);

    const aggregates = computeChildcareReputation(
      reviewSnap.docs.map((d: FirebaseFirestore.QueryDocumentSnapshot) => d.data() as ReviewRowLike),
      bookingSnap.docs.map((d: FirebaseFirestore.QueryDocumentSnapshot) => d.data() as BookingRowLike),
      now,
    );

    // caregiver_reputation: child-prefixed fields ONLY (merge — the senior
    // unprefixed fields are never present in this write).
    await db
      .collection("caregiver_reputation")
      .doc(caregiverUid)
      .set({ ...aggregates }, { merge: true });

    // Sibling summary on the parent caregiver doc — only when the caregiver
    // exists (never materialize a phantom caregiver doc).
    const cgRef = db.collection("caregivers").doc(caregiverUid);
    const cgSnap = await cgRef.get();
    if (cgSnap.exists) {
      await cgRef.set(
        { [CHILDCARE_REPUTATION_SUMMARY_FIELD]: toChildcareReputationSummary(aggregates) },
        { merge: true },
      );
    }
    return aggregates;
  } catch (err) {
    console.error(
      "[childcare/reputationProjection] recompute failed (review write unaffected):",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
