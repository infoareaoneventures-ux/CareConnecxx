// U8 childcare payment policy tests (plan 2026-07-22-002, R39/R40/R57).
//
// Scenarios: pricing refs unset → payment setup refuses (fail closed, R40);
// missing/malformed pricing config docs fail closed; NO senior fee fallback on
// any path; cancellation/refund windows + percentages are policy-resolved;
// Stripe metadata key sets are pinned EXACTLY and child-PII-free by
// construction.

import { describe, it, expect } from "vitest";
import { makeFakeDb } from "./__tests__/fakeFirestore";
import {
  resolveChildcarePricingSnapshot,
  childcarePlatformFeeCents,
  childcareFeeCentsForShift,
  evaluateChildcareCancellation,
  evaluateChildcareRefundRequest,
  childcareSetupMetadata,
  assertChildSafeStripeMetadata,
  ChildcarePaymentPolicyError,
  CHILDCARE_SETUP_METADATA_KEYS,
  CHILDCARE_CHARGE_METADATA_KEYS,
  CHILDCARE_REFUND_METADATA_KEYS,
  CHILDCARE_PRICING_CONFIGS_COLLECTION,
  type ChildcarePricingSnapshot,
} from "./paymentPolicy";
import { CA_PILOT_POLICY_SEED, type JurisdictionCarePolicy } from "./jurisdictionPolicy";

const NOW = new Date("2026-07-23T18:00:00.000Z");

function populatedPolicy(): JurisdictionCarePolicy {
  return {
    ...CA_PILOT_POLICY_SEED,
    pricing: {
      familyEntitlementRef: "fam-ent-1",
      caregiverFeeRef: "cg-fee-1",
      screeningFeeRef: "screen-fee-1",
      siblingPolicyRef: "sibling-1",
      cancellationPolicyRef: "cancel-1",
      refundPolicyRef: "refund-1",
    },
  };
}

function seedConfigs(db: ReturnType<typeof makeFakeDb>) {
  db.seed(`${CHILDCARE_PRICING_CONFIGS_COLLECTION}/cg-fee-1`, {
    kind: "caregiver_fee",
    currency: "usd",
    platformFeeRate: 0.05,
    platformFeeMinCents: 100,
  });
  db.seed(`${CHILDCARE_PRICING_CONFIGS_COLLECTION}/cancel-1`, {
    kind: "cancellation_policy",
    windows: [
      { hoursBeforeStart: 24, refundPercent: 50 },
      { hoursBeforeStart: 48, refundPercent: 100 },
    ],
    providerNoShowRefundPercent: 100,
  });
  db.seed(`${CHILDCARE_PRICING_CONFIGS_COLLECTION}/refund-1`, {
    kind: "refund_policy",
    windowHours: 72,
    allowPartial: true,
    maxPercent: 100,
  });
}

async function resolveWith(
  policy: Partial<JurisdictionCarePolicy> | null,
  seed = true,
): Promise<ChildcarePricingSnapshot> {
  const fake = makeFakeDb();
  if (seed) seedConfigs(fake);
  return resolveChildcarePricingSnapshot({ state: "CA", db: fake.db as never, now: NOW, policy });
}

describe("resolveChildcarePricingSnapshot — R40 fail closed", () => {
  it("REFUSES when pricing refs are unset (the CA seed ships all-null)", async () => {
    await expect(resolveWith(CA_PILOT_POLICY_SEED)).rejects.toMatchObject({ code: "pricing_unset" });
  });

  it("refuses when the policy document is absent entirely", async () => {
    await expect(resolveWith(null)).rejects.toMatchObject({ code: "policy_unavailable" });
  });

  it("refuses FILL_IN placeholder refs (jurisdictionPolicy unpopulated convention)", async () => {
    const policy = populatedPolicy();
    policy.pricing.caregiverFeeRef = "FILL_IN_LATER";
    await expect(resolveWith(policy)).rejects.toMatchObject({ code: "pricing_unset" });
  });

  it("refuses when a referenced config doc does not exist", async () => {
    await expect(resolveWith(populatedPolicy(), false)).rejects.toMatchObject({
      code: "pricing_config_missing",
    });
  });

  it("refuses a config doc of the wrong kind", async () => {
    const fake = makeFakeDb();
    seedConfigs(fake);
    fake.seed(`${CHILDCARE_PRICING_CONFIGS_COLLECTION}/cg-fee-1`, {
      kind: "refund_policy",
      platformFeeRate: 0.05,
      platformFeeMinCents: 100,
      currency: "usd",
    });
    await expect(
      resolveChildcarePricingSnapshot({ state: "CA", db: fake.db as never, now: NOW, policy: populatedPolicy() }),
    ).rejects.toMatchObject({ code: "pricing_config_invalid" });
  });

  it.each([
    ["platformFeeRate out of range", { platformFeeRate: 0.9 }],
    ["platformFeeRate missing", { platformFeeRate: undefined }],
    ["platformFeeMinCents negative", { platformFeeMinCents: -1 }],
    ["platformFeeMinCents non-integer", { platformFeeMinCents: 1.5 }],
    ["wrong currency", { currency: "eur" }],
  ])("refuses a malformed caregiver_fee config (%s)", async (_label, overrides) => {
    const fake = makeFakeDb();
    seedConfigs(fake);
    fake.seed(`${CHILDCARE_PRICING_CONFIGS_COLLECTION}/cg-fee-1`, {
      kind: "caregiver_fee",
      currency: "usd",
      platformFeeRate: 0.05,
      platformFeeMinCents: 100,
      ...overrides,
    });
    await expect(
      resolveChildcarePricingSnapshot({ state: "CA", db: fake.db as never, now: NOW, policy: populatedPolicy() }),
    ).rejects.toMatchObject({ code: "pricing_config_invalid" });
  });

  it("refuses empty cancellation windows and malformed refund policies", async () => {
    const fake = makeFakeDb();
    seedConfigs(fake);
    fake.seed(`${CHILDCARE_PRICING_CONFIGS_COLLECTION}/cancel-1`, {
      kind: "cancellation_policy",
      windows: [],
      providerNoShowRefundPercent: 100,
    });
    await expect(
      resolveChildcarePricingSnapshot({ state: "CA", db: fake.db as never, now: NOW, policy: populatedPolicy() }),
    ).rejects.toMatchObject({ code: "pricing_config_invalid" });
  });

  it("resolves a fully populated policy into a validated snapshot (windows sorted descending)", async () => {
    const snapshot = await resolveWith(populatedPolicy());
    expect(snapshot.platformFeeRate).toBe(0.05);
    expect(snapshot.platformFeeMinCents).toBe(100);
    expect(snapshot.currency).toBe("usd");
    expect(snapshot.cancellation.windows.map((w) => w.hoursBeforeStart)).toEqual([48, 24]);
    expect(snapshot.refund).toEqual({ windowHours: 72, allowPartial: true, maxPercent: 100 });
    expect(snapshot.refs.caregiverFeeRef).toBe("cg-fee-1");
    expect(snapshot.policyVersion).toBe(CA_PILOT_POLICY_SEED.policyVersion);
  });
});

describe("childcare platform fee — policy snapshot only, never senior constants", () => {
  it("computes the fee from the FROZEN snapshot (5% here, not the senior 1.5%)", () => {
    // gross $100.00 → 5% = $5.00. The senior fee constants would give $1.50 —
    // if a fallback ever appeared, this assertion catches it.
    expect(childcarePlatformFeeCents(10000, { platformFeeRate: 0.05, platformFeeMinCents: 100 })).toBe(500);
  });

  it("applies the policy fee floor", () => {
    expect(childcarePlatformFeeCents(1000, { platformFeeRate: 0.05, platformFeeMinCents: 100 })).toBe(100);
  });

  it("THROWS on a missing snapshot instead of falling back (R40 fail closed)", () => {
    expect(() => childcarePlatformFeeCents(10000, null)).toThrow(ChildcarePaymentPolicyError);
    expect(() => childcarePlatformFeeCents(10000, {})).toThrow(ChildcarePaymentPolicyError);
    expect(() =>
      childcareFeeCentsForShift({ careVertical: "child", childcarePricing: undefined }, 10000),
    ).toThrow(ChildcarePaymentPolicyError);
  });

  it("childcareFeeCentsForShift rejects a non-childcare row (caller bug, fail closed)", () => {
    expect(() =>
      childcareFeeCentsForShift(
        { careVertical: undefined, childcarePricing: { platformFeeRate: 0.05, platformFeeMinCents: 100 } },
        10000,
      ),
    ).toThrow(ChildcarePaymentPolicyError);
  });
});

describe("cancellation/refund policy evaluation — windows are configuration", () => {
  const snapshot = {
    cancellation: {
      windows: [
        { hoursBeforeStart: 48, refundPercent: 100 },
        { hoursBeforeStart: 24, refundPercent: 50 },
      ],
      providerNoShowRefundPercent: 100,
    },
  };
  const startMs = Date.parse("2026-08-10T17:00:00.000Z");

  it("matches the largest satisfied window", () => {
    const r = evaluateChildcareCancellation(snapshot, startMs, startMs - 72 * 3600_000);
    expect(r.refundPercent).toBe(100);
    expect(r.matchedWindowHours).toBe(48);
  });

  it("falls to the inner window with less notice", () => {
    const r = evaluateChildcareCancellation(snapshot, startMs, startMs - 30 * 3600_000);
    expect(r.refundPercent).toBe(50);
  });

  it("less notice than every window still resolves to the smallest window's percent", () => {
    const r = evaluateChildcareCancellation(snapshot, startMs, startMs - 3600_000);
    expect(r.refundPercent).toBe(50);
    expect(r.matchedWindowHours).toBeNull();
  });

  const refundPolicy = { refund: { windowHours: 72, allowPartial: false, maxPercent: 80 } };
  const checkoutMs = Date.parse("2026-08-10T21:00:00.000Z");

  it("refuses a refund request after the policy window closes", () => {
    const r = evaluateChildcareRefundRequest(refundPolicy, {
      chargedCents: 10000,
      requestedCents: null,
      checkoutMs,
      nowMs: checkoutMs + 73 * 3600_000,
    });
    expect(r).toMatchObject({ allowed: false, reasonCode: "refund_window_closed" });
  });

  it("caps refunds at the policy max percent and enforces allowPartial", () => {
    const over = evaluateChildcareRefundRequest(refundPolicy, {
      chargedCents: 10000,
      requestedCents: 9000,
      checkoutMs,
      nowMs: checkoutMs + 3600_000,
    });
    expect(over).toMatchObject({ allowed: false, reasonCode: "exceeds_policy_max", maxRefundableCents: 8000 });

    const partial = evaluateChildcareRefundRequest(refundPolicy, {
      chargedCents: 10000,
      requestedCents: 1000,
      checkoutMs,
      nowMs: checkoutMs + 3600_000,
    });
    expect(partial).toMatchObject({ allowed: false, reasonCode: "partial_not_allowed" });

    const full = evaluateChildcareRefundRequest(refundPolicy, {
      chargedCents: 10000,
      requestedCents: 8000,
      checkoutMs,
      nowMs: checkoutMs + 3600_000,
    });
    expect(full).toMatchObject({ allowed: true, reasonCode: "ok" });
  });
});

describe("Stripe metadata contract — pinned key sets, opaque IDs only (R57)", () => {
  it("the three key sets are pinned EXACTLY (a new key is a deliberate contract change)", () => {
    expect([...CHILDCARE_SETUP_METADATA_KEYS]).toEqual(["childcareBookingId", "householdId"]);
    expect([...CHILDCARE_CHARGE_METADATA_KEYS]).toEqual([
      "appointmentId",
      "shiftHoursId",
      "paymentGeneration",
      "careVertical",
      "childcareBookingId",
      "childcareShiftId",
    ]);
    expect([...CHILDCARE_REFUND_METADATA_KEYS]).toEqual([
      "requestId",
      "clientId",
      "appointmentId",
      "paymentGeneration",
      "careVertical",
      "childcareBookingId",
    ]);
  });

  it("no pinned key can carry child data by name (structural review of the sets)", () => {
    const all = [
      ...CHILDCARE_SETUP_METADATA_KEYS,
      ...CHILDCARE_CHARGE_METADATA_KEYS,
      ...CHILDCARE_REFUND_METADATA_KEYS,
    ].join(" ").toLowerCase();
    for (const banned of ["name", "dob", "birth", "address", "allergy", "custody", "pickup", "health", "phone"]) {
      expect(all).not.toContain(banned);
    }
  });

  it("childcareSetupMetadata emits exactly the pinned keys", () => {
    expect(childcareSetupMetadata("cbook_1", "hh_1")).toEqual({
      childcareBookingId: "cbook_1",
      householdId: "hh_1",
    });
  });

  it("assertChildSafeStripeMetadata rejects extra keys, missing keys, and non-opaque values", () => {
    expect(() =>
      assertChildSafeStripeMetadata(
        { childcareBookingId: "b", householdId: "h", childName: "M." },
        CHILDCARE_SETUP_METADATA_KEYS,
        "test",
      ),
    ).toThrow(/metadata keys/);
    expect(() =>
      assertChildSafeStripeMetadata({ childcareBookingId: "b" }, CHILDCARE_SETUP_METADATA_KEYS, "test"),
    ).toThrow(/metadata keys/);
    expect(() =>
      assertChildSafeStripeMetadata(
        { childcareBookingId: "b", householdId: 42 as unknown as string },
        CHILDCARE_SETUP_METADATA_KEYS,
        "test",
      ),
    ).toThrow(/opaque ID/);
  });
});
