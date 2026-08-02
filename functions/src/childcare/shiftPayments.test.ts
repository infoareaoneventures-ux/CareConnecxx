// U8 childcare shift-payment tests (plan 2026-07-22-002, R7/R37-R40, AE14-AE16).
//
// Scenarios (plan U8 list): pricing refs unset → payment setup refuses;
// guardian-without-payment-scope → explicit pending-payer state; payer-not-
// guardian can authorize but receives NO child data; validated hours by
// assigned vs unassigned provider; completion revalidates booking state +
// frozen pricing (fail closed, no charge without policy pricing); duplicate
// completion converges to ONE billable row (AE15); recurring occurrence
// completes its own row; hours clamped to the scheduled window; overdue
// late/no-show policy states (never wall-clock completion, no charge);
// policy-driven refund requests into the EXISTING refundRequests machine;
// dispute/chargeback payout holds.

import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  const docs = new Map<string, any>();

  const valueAt = (doc: any, path: string): unknown =>
    path.split(".").reduce<any>((acc, part) => (acc == null ? undefined : acc[part]), doc);

  const matches = (doc: any, f: { field: string; op: string; value: any }): boolean => {
    const v = valueAt(doc, f.field);
    if (f.op === "==") return v === f.value;
    if (f.op === "in") return Array.isArray(f.value) && f.value.includes(v);
    if (f.op === "array-contains") return Array.isArray(v) && v.includes(f.value);
    if (f.op === "<=") return typeof v === "string" && v <= f.value;
    return false;
  };

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({
      exists: docs.has(path),
      id: path.split("/").pop(),
      data: () => docs.get(path),
      ref: makeDocRef(path),
    }),
    set: async (data: any, opts?: any) => {
      docs.set(path, opts?.merge ? { ...(docs.get(path) ?? {}), ...data } : { ...data });
    },
    update: async (data: any) => {
      if (!docs.has(path)) {
        const err: any = new Error(`5 NOT_FOUND: ${path}`);
        err.code = 5;
        throw err;
      }
      docs.set(path, { ...(docs.get(path) ?? {}), ...data });
    },
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });

  const makeQuery = (collPath: string, filters: any[] = [], lim?: number): any => ({
    where: (field: string, op: string, value: any) =>
      makeQuery(collPath, [...filters, { field, op, value }], lim),
    orderBy: () => makeQuery(collPath, filters, lim),
    limit: (n: number) => makeQuery(collPath, filters, n),
    get: async () => {
      let rows = [...docs.entries()]
        .filter(
          ([p]) =>
            p.startsWith(`${collPath}/`) &&
            p.split("/").length === collPath.split("/").length + 1,
        )
        .map(([p, d]) => ({ id: p.split("/").pop()!, data: () => d, ref: makeDocRef(p), _raw: d }))
        .filter((r) => filters.every((f) => matches(r._raw, f)));
      if (lim !== undefined) rows = rows.slice(0, lim);
      return { empty: rows.length === 0, size: rows.length, docs: rows };
    },
  });

  const makeCollRef = (path: string): any => {
    const q = makeQuery(path);
    return {
      doc: (id?: string) => makeDocRef(`${path}/${id ?? `auto-${docs.size}`}`),
      add: async (data: any) => {
        const ref = makeDocRef(`${path}/auto-${docs.size}`);
        await ref.set(data);
        return ref;
      },
      where: q.where,
      limit: q.limit,
      get: q.get,
    };
  };

  const db = {
    collection: (p: string) => makeCollRef(p),
    runTransaction: async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => void ref.set(data, opts),
        update: (ref: any, data: any) => {
          docs.set(ref.path, { ...(docs.get(ref.path) ?? {}), ...data });
        },
      }),
  };

  const stripeApi = {
    setupIntents: {
      create: vi.fn(async () => ({ id: "seti_1", status: "succeeded" })),
    },
    customers: {
      retrieve: vi.fn(async () => ({ invoice_settings: { default_payment_method: "pm_1" } })),
    },
  };
  function StripeClass(this: any) { return stripeApi; }

  return {
    docs,
    db,
    stripeApi,
    StripeClass,
    reset: () => {
      docs.clear();
      stripeApi.setupIntents.create.mockClear();
      stripeApi.setupIntents.create.mockResolvedValue({ id: "seti_1", status: "succeeded" } as any);
      stripeApi.customers.retrieve.mockClear();
      stripeApi.customers.retrieve.mockResolvedValue({
        invoice_settings: { default_payment_method: "pm_1" },
      } as any);
    },
  };
});

vi.mock("firebase-admin", () => {
  const firestore: any = () => hoisted.db;
  return { __esModule: true, default: { firestore, apps: [{}] }, firestore, apps: [{}] };
});
vi.mock("stripe", () => ({ __esModule: true, default: hoisted.StripeClass }));
vi.mock("../observability/auditLog", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("./requireAppCheck", () => ({ requireAppCheck: vi.fn(() => ({ verified: true, mode: "monitor" })) }));
vi.mock("../rateLimit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));

const flagsMock = vi.hoisted(() => vi.fn(async () => ({
  enabled: true,
  writesEnabled: true,
  discoveryEnabled: true,
  proactiveEnabled: true,
})));
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

// checkAuthority mock: scope grants keyed `${uid}|${childId}|${scope}`.
const authorityGrants = vi.hoisted(() => new Set<string>());
vi.mock("./guardianAuthority", () => ({
  checkAuthority: vi.fn(async (uid: string, childId: string, scope: string) => ({
    allowed: authorityGrants.has(`${uid}|${childId}|${scope}`),
    reason: "granted",
    accessVersion: 1,
    authorityId: `${childId}__${uid}`,
  })),
}));

const recordAuthMock = vi.hoisted(() =>
  vi.fn(async (params: any) => ({
    booking: { status: "accepted", paymentAuthorization: { state: params.state } },
    confirmed: params.state === "authorized",
  })),
);
vi.mock("./bookingCallables", () => ({
  recordChildcareBookingPaymentAuthorization: recordAuthMock,
}));
vi.mock("./matchingEligibility", () => ({
  assertChildSafeOutboundPayload: vi.fn((payload: Record<string, unknown>) => {
    // Real contract in spirit: any obviously child-flavored key fails here.
    const banned = ["childName", "recipientLabel", "childIds", "allergies", "custody"];
    for (const key of Object.keys(payload)) {
      if (banned.includes(key)) throw new Error(`child-unsafe payload key ${key}`);
    }
  }),
}));
vi.mock("./signupIngress", () => ({ CHILDCARE_PILOT_STATE: "CA" }));

import {
  setupChildcareBookingPayment as _setup,
  requestChildcareRefund as _refund,
  createChildcareValidatedShiftHoursForToday,
  handleOverdueChildcareVisit,
  evaluateAndRecordChildcareCancellation,
  holdChildcareShiftPayout,
  hasPaymentScopeForBooking,
  CHILDCARE_BILLING_AUTHORITY,
} from "./shiftPayments";
import { CHILDCARE_PRICING_CONFIGS_COLLECTION } from "./paymentPolicy";

/* eslint-disable @typescript-eslint/no-explicit-any */
const setupPayment = _setup as any;
const requestRefund = _refund as any;

const FAMILY = "family-1";
const PAYER = "payer-1";
const CG = "cg-1";
const BOOKING = "cbook_test1";
const NOW = new Date("2026-08-10T16:00:00.000Z"); // 09:00 PT on 2026-08-10

function ctx(uid: string): any {
  return { auth: { uid }, app: { appId: "test-app" } };
}

const PRICING_SNAPSHOT = {
  policyVersion: "CA-2026-07-22.1",
  currency: "usd" as const,
  platformFeeRate: 0.05,
  platformFeeMinCents: 100,
  cancellation: {
    windows: [
      { hoursBeforeStart: 48, refundPercent: 100 },
      { hoursBeforeStart: 24, refundPercent: 50 },
    ],
    providerNoShowRefundPercent: 100,
  },
  refund: { windowHours: 72, allowPartial: true, maxPercent: 100 },
  refs: {
    familyEntitlementRef: "fam-ent-1",
    caregiverFeeRef: "cg-fee-1",
    screeningFeeRef: "screen-fee-1",
    siblingPolicyRef: "sibling-1",
    cancellationPolicyRef: "cancel-1",
    refundPolicyRef: "refund-1",
  },
  resolvedAt: NOW.toISOString(),
};

function seedBooking(overrides: Record<string, unknown> = {}) {
  hoisted.docs.set(`booking_requests/${BOOKING}`, {
    careVertical: "child",
    bookingId: BOOKING,
    clientId: FAMILY,
    caregiverId: CG,
    caregiverName: "Pat Provider",
    householdId: "hh_family-1",
    childIds: ["child-a"],
    recipientLabel: "M.",
    status: "accepted",
    stateVersion: 2,
    schedule: { dates: [{ date: "2026-08-10", startTime: "09:00", endTime: "13:00" }], recurring: null },
    hourlyRate: 28,
    paymentAuthorization: { state: "none", correlationId: null, updatedAt: NOW.toISOString() },
    paymentSetup: {
      pendingPayer: false,
      payerUid: PAYER,
      stripeCustomerId: "cus_1",
      paymentMethodId: "pm_1",
      setupIntentId: "seti_1",
      pricingSnapshot: PRICING_SNAPSHOT,
      updatedAt: NOW.toISOString(),
    },
    ...overrides,
  });
}

function seedJurisdictionPolicy(pricingPopulated = true) {
  hoisted.docs.set("jurisdiction_care_policies/CA", {
    state: "CA",
    status: "configured",
    policyVersion: "CA-2026-07-22.1",
    pricing: pricingPopulated
      ? {
          familyEntitlementRef: "fam-ent-1",
          caregiverFeeRef: "cg-fee-1",
          screeningFeeRef: "screen-fee-1",
          siblingPolicyRef: "sibling-1",
          cancellationPolicyRef: "cancel-1",
          refundPolicyRef: "refund-1",
        }
      : {
          familyEntitlementRef: null,
          caregiverFeeRef: null,
          screeningFeeRef: null,
          siblingPolicyRef: null,
          cancellationPolicyRef: null,
          refundPolicyRef: null,
        },
  });
  if (pricingPopulated) {
    hoisted.docs.set(`${CHILDCARE_PRICING_CONFIGS_COLLECTION}/cg-fee-1`, {
      kind: "caregiver_fee",
      currency: "usd",
      platformFeeRate: 0.05,
      platformFeeMinCents: 100,
    });
    hoisted.docs.set(`${CHILDCARE_PRICING_CONFIGS_COLLECTION}/cancel-1`, {
      kind: "cancellation_policy",
      windows: [
        { hoursBeforeStart: 48, refundPercent: 100 },
        { hoursBeforeStart: 24, refundPercent: 50 },
      ],
      providerNoShowRefundPercent: 100,
    });
    hoisted.docs.set(`${CHILDCARE_PRICING_CONFIGS_COLLECTION}/refund-1`, {
      kind: "refund_policy",
      windowHours: 72,
      allowPartial: true,
      maxPercent: 100,
    });
  }
}

function grantPayment(uid: string, childId = "child-a") {
  authorityGrants.add(`${uid}|${childId}|payment`);
}

beforeEach(() => {
  hoisted.reset();
  authorityGrants.clear();
  recordAuthMock.mockClear();
  flagsMock.mockResolvedValue({
    enabled: true, writesEnabled: true, discoveryEnabled: true, proactiveEnabled: true,
  } as any);
});

// ── setupChildcareBookingPayment ─────────────────────────────────────────────

describe("setupChildcareBookingPayment (payment authorization — R7/R40/AE14)", () => {
  it("REFUSES payment setup when the jurisdiction pricing refs are unset (R40)", async () => {
    seedBooking();
    seedJurisdictionPolicy(false);
    grantPayment(PAYER);
    hoisted.docs.set("customers/payer-1", { stripeCustomerId: "cus_1" });
    await expect(setupPayment({ bookingId: BOOKING }, ctx(PAYER))).rejects.toMatchObject({
      code: "failed-precondition",
      details: { code: "pricing_unset" },
    });
    expect(recordAuthMock).not.toHaveBeenCalled();
    expect(hoisted.stripeApi.setupIntents.create).not.toHaveBeenCalled();
  });

  it("guardian WITHOUT payment scope gets the explicit pending-payer state (never authorized)", async () => {
    seedBooking();
    seedJurisdictionPolicy();
    // FAMILY is the booking clientId but holds no `payment` scope.
    const res = await setupPayment({ bookingId: BOOKING }, ctx(FAMILY));
    expect(res).toMatchObject({ success: true, paymentState: "pending", needsPayer: true });
    expect(recordAuthMock).toHaveBeenCalledWith(
      { bookingId: BOOKING, state: "pending", correlationId: null },
      expect.anything(),
    );
    expect(hoisted.docs.get(`booking_requests/${BOOKING}`).paymentSetup.pendingPayer).toBe(true);
    expect(hoisted.stripeApi.setupIntents.create).not.toHaveBeenCalled();
  });

  it("a PAYER who is not a guardian can authorize — and the response carries NO child data (R7/A3)", async () => {
    seedBooking();
    seedJurisdictionPolicy();
    grantPayment(PAYER); // payment scope only; PAYER is not clientId/caregiver
    hoisted.docs.set("customers/payer-1", { stripeCustomerId: "cus_1" });

    const res = await setupPayment({ bookingId: BOOKING }, ctx(PAYER));
    expect(res.success).toBe(true);
    expect(res.paymentState).toBe("authorized");
    expect(recordAuthMock).toHaveBeenCalledWith(
      { bookingId: BOOKING, state: "authorized", correlationId: "seti_1" },
      expect.anything(),
    );
    // Response keys pinned: booking/payment state only — no recipientLabel,
    // childIds, household composition, or any other child-adjacent field.
    expect(Object.keys(res).sort()).toEqual(
      ["bookingId", "confirmed", "paymentState", "status", "statusDescription", "success"].sort(),
    );
    // Setup metadata: opaque IDs only, stable idempotency key (AE15).
    expect(hoisted.stripeApi.setupIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_1",
        payment_method: "pm_1",
        confirm: true,
        usage: "off_session",
        metadata: { childcareBookingId: BOOKING, householdId: "hh_family-1" },
      }),
      { idempotencyKey: `childcare-payment-setup-${BOOKING}` },
    );
    const setup = hoisted.docs.get(`booking_requests/${BOOKING}`).paymentSetup;
    expect(setup.payerUid).toBe(PAYER);
    expect(setup.pricingSnapshot.platformFeeRate).toBe(0.05);
  });

  it("an unrelated adult (no payment scope, not the booking family) is denied", async () => {
    seedBooking();
    seedJurisdictionPolicy();
    await expect(setupPayment({ bookingId: BOOKING }, ctx("stranger-1"))).rejects.toMatchObject({
      code: "permission-denied",
    });
  });

  it("fails closed when the payer has no saved payment method", async () => {
    seedBooking();
    seedJurisdictionPolicy();
    grantPayment(PAYER);
    hoisted.docs.set("customers/payer-1", { stripeCustomerId: "cus_1" });
    hoisted.stripeApi.customers.retrieve.mockResolvedValue({ invoice_settings: {} } as any);
    await expect(setupPayment({ bookingId: BOOKING }, ctx(PAYER))).rejects.toMatchObject({
      details: { code: "no_payment_method" },
    });
  });

  it("refuses a canceled/completed booking (booking_not_payable)", async () => {
    seedBooking({ status: "canceled" });
    seedJurisdictionPolicy();
    grantPayment(PAYER);
    await expect(setupPayment({ bookingId: BOOKING }, ctx(PAYER))).rejects.toMatchObject({
      details: { code: "booking_not_payable" },
    });
  });
});

// ── Validated hours at check-out ─────────────────────────────────────────────

function seedCompletedOccurrence(
  id = "cappt_occ1",
  overrides: Record<string, unknown> = {},
  collection: "appointments" | "shifts" = "appointments",
) {
  hoisted.docs.set(`${collection}/${id}`, {
    careVertical: "child",
    ...(collection === "appointments"
      ? { childcareBookingId: BOOKING }
      : { bookingRequestId: BOOKING }),
    clientId: FAMILY,
    caregiverId: CG,
    date: "2026-08-10",
    startTime: "09:00",
    endTime: "13:00",
    status: "completed",
    checkedInAt: "2026-08-10T16:05:00.000Z", // 09:05 PT
    checkedOutAt: "2026-08-10T19:35:00.000Z", // 12:35 PT
    ...overrides,
  });
}

describe("createChildcareValidatedShiftHoursForToday (server-derived hours — R39)", () => {
  const NOW_CHECKOUT = new Date("2026-08-10T19:40:00.000Z");

  it("an UNASSIGNED provider creates nothing", async () => {
    seedBooking({ status: "in_progress", paymentAuthorization: { state: "authorized", correlationId: "seti_1", updatedAt: "x" } });
    seedCompletedOccurrence();
    const r = await createChildcareValidatedShiftHoursForToday(
      { bookingId: BOOKING, actorUid: "cg-other" },
      { db: hoisted.db as any, now: NOW_CHECKOUT },
    );
    expect(r).toMatchObject({ created: 0, blockedReason: "not_assigned_caregiver" });
    expect([...hoisted.docs.keys()].filter((p) => p.startsWith("shiftHours/"))).toHaveLength(0);
  });

  it("FAILS CLOSED with no charge when the frozen pricing snapshot is missing (R40)", async () => {
    seedBooking({
      status: "in_progress",
      paymentAuthorization: { state: "authorized", correlationId: "seti_1", updatedAt: "x" },
      paymentSetup: { pendingPayer: false, payerUid: PAYER }, // no pricingSnapshot
    });
    seedCompletedOccurrence();
    const r = await createChildcareValidatedShiftHoursForToday(
      { bookingId: BOOKING, actorUid: CG },
      { db: hoisted.db as any, now: NOW_CHECKOUT },
    );
    expect(r).toMatchObject({ created: 0, blockedReason: "pricing_snapshot_missing" });
    expect([...hoisted.docs.keys()].filter((p) => p.startsWith("shiftHours/"))).toHaveLength(0);
    const alerts = [...hoisted.docs.entries()].filter(([p]) => p.startsWith("admin_alerts/"));
    expect(alerts.some(([, a]) => a.reason === "pricing_snapshot_missing")).toBe(true);
  });

  it("blocks without payment authorization (booking state revalidated from a fresh read)", async () => {
    seedBooking({ status: "in_progress" }); // paymentAuthorization.state === "none"
    seedCompletedOccurrence();
    const r = await createChildcareValidatedShiftHoursForToday(
      { bookingId: BOOKING, actorUid: CG },
      { db: hoisted.db as any, now: NOW_CHECKOUT },
    );
    expect(r).toMatchObject({ created: 0, blockedReason: "payment_not_authorized" });
  });

  it("creates ONE vertical-stamped row with the frozen fee snapshot + ledger correlation; duplicates converge (AE15)", async () => {
    seedBooking({
      status: "in_progress",
      paymentAuthorization: { state: "authorized", correlationId: "seti_1", updatedAt: "x" },
    });
    seedCompletedOccurrence();

    const first = await createChildcareValidatedShiftHoursForToday(
      { bookingId: BOOKING, actorUid: CG },
      { db: hoisted.db as any, now: NOW_CHECKOUT },
    );
    expect(first.created).toBe(1);

    const row = hoisted.docs.get("shiftHours/cappt_occ1");
    expect(row).toMatchObject({
      careVertical: "child",
      childcareBookingId: BOOKING,
      childcareShiftId: "cappt_occ1",
      billingUserId: PAYER, // the recorded payer is charged, not the guardian
      caregiverId: CG,
      clientId: FAMILY,
      paymentMethod: "credit",
      billingAuthority: CHILDCARE_BILLING_AUTHORITY,
      billingSource: "childcare_checkout",
      status: "pending_client_review",
      paymentGeneration: 1,
      paymentAttemptCount: 0,
    });
    // 09:05–12:35 PT actual within 09:00–13:00 window → 3.5h * $28 = $98.00.
    expect(row.submittedTotalHours).toBe(3.5);
    expect(row.amountCents).toBe(9800);
    expect(row.childcarePricing).toMatchObject({ platformFeeRate: 0.05, platformFeeMinCents: 100 });
    expect(row.childcareRefundPolicy).toMatchObject({ windowHours: 72 });
    // The family review notice was delivered in-app → auto-approval unlocked.
    expect(row.approvalNoticeState).toBe("delivered");
    expect(row.approvalNoticeChannel).toBe("in_app");
    expect(typeof row.autoApproveAt).toBe("string");
    // Row carries NO child fields.
    for (const banned of ["childIds", "recipientLabel", "householdId", "recipientRef"]) {
      expect(row[banned]).toBeUndefined();
    }

    // Duplicate check-out retry converges to the SAME single row.
    const second = await createChildcareValidatedShiftHoursForToday(
      { bookingId: BOOKING, actorUid: CG },
      { db: hoisted.db as any, now: NOW_CHECKOUT },
    );
    expect(second.created).toBe(0);
    expect([...hoisted.docs.keys()].filter((p) => p.startsWith("shiftHours/"))).toHaveLength(1);
  });

  it("clamps billable hours to the scheduled window (early check-in / late check-out)", async () => {
    seedBooking({
      status: "in_progress",
      paymentAuthorization: { state: "authorized", correlationId: "seti_1", updatedAt: "x" },
    });
    seedCompletedOccurrence("cappt_occ2", {
      checkedInAt: "2026-08-10T15:00:00.000Z", // 08:00 PT — before the 09:00 window
      checkedOutAt: "2026-08-10T21:00:00.000Z", // 14:00 PT — after the 13:00 window
    });
    await createChildcareValidatedShiftHoursForToday(
      { bookingId: BOOKING, actorUid: CG },
      { db: hoisted.db as any, now: NOW_CHECKOUT },
    );
    const row = hoisted.docs.get("shiftHours/cappt_occ2");
    expect(row.submittedTotalHours).toBe(4); // exactly the 09:00–13:00 window
    expect(row.amountCents).toBe(11200);
  });

  it("a recurring occurrence (shifts collection) completes its OWN row — the deferred U7 lifecycle", async () => {
    seedBooking({
      status: "in_progress",
      schedule: { dates: [], recurring: { days: ["monday"], startTime: "09:00", endTime: "13:00" } },
      paymentAuthorization: { state: "authorized", correlationId: "seti_1", updatedAt: "x" },
    });
    seedCompletedOccurrence("cshift_occ1", {}, "shifts");
    const r = await createChildcareValidatedShiftHoursForToday(
      { bookingId: BOOKING, actorUid: CG },
      { db: hoisted.db as any, now: NOW_CHECKOUT },
    );
    expect(r.created).toBe(1);
    const row = hoisted.docs.get("shiftHours/cshift_occ1");
    expect(row.childcareShiftId).toBe("cshift_occ1");
    expect(row.careVertical).toBe("child");
  });
});

// ── Overdue childcare visits (late/no-show policy states) ────────────────────

describe("handleOverdueChildcareVisit (late/no-show — never wall-clock completion)", () => {
  it("never-checked-in → missed_visit_review + status 'missed' + admin review, NO charge", async () => {
    hoisted.docs.set("appointments/cappt_miss", {
      careVertical: "child",
      childcareBookingId: BOOKING,
      clientId: FAMILY,
      caregiverId: CG,
      status: "confirmed",
      date: "2026-08-10",
    });
    const state = await handleOverdueChildcareVisit(
      "cappt_miss",
      hoisted.docs.get("appointments/cappt_miss"),
      { db: hoisted.db as any, now: NOW },
    );
    expect(state).toBe("missed_visit_review");
    const appt = hoisted.docs.get("appointments/cappt_miss");
    expect(appt.status).toBe("missed"); // exits the completion scan; never "completed"
    expect(appt.childcareOverdueState).toBe("missed_visit_review");
    expect([...hoisted.docs.keys()].filter((p) => p.startsWith("shiftHours/"))).toHaveLength(0);
    const alerts = [...hoisted.docs.values()].filter((d) => d.type === "childcare_visit_missed_review");
    expect(alerts).toHaveLength(1);

    // Idempotent: a re-scan returns the stamp without duplicating alerts.
    const again = await handleOverdueChildcareVisit("cappt_miss", appt, { db: hoisted.db as any, now: NOW });
    expect(again).toBe("missed_visit_review");
    expect([...hoisted.docs.values()].filter((d) => d.type === "childcare_visit_missed_review")).toHaveLength(1);
  });

  it("checked-in-but-not-out → awaiting_checkout, status stays confirmed, provider nudged", async () => {
    hoisted.docs.set("appointments/cappt_late", {
      careVertical: "child",
      childcareBookingId: BOOKING,
      clientId: FAMILY,
      caregiverId: CG,
      status: "confirmed",
      date: "2026-08-10",
      checkedInAt: "2026-08-10T16:05:00.000Z",
    });
    const state = await handleOverdueChildcareVisit(
      "cappt_late",
      hoisted.docs.get("appointments/cappt_late"),
      { db: hoisted.db as any, now: NOW },
    );
    expect(state).toBe("awaiting_checkout");
    const appt = hoisted.docs.get("appointments/cappt_late");
    expect(appt.status).toBe("confirmed"); // a late check-out can still complete it
    const nudges = [...hoisted.docs.entries()]
      .filter(([p]) => p.startsWith(`users/${CG}/notifications/`))
      .map(([, d]) => d);
    expect(nudges.some((n) => n.type === "childcare_checkout_reminder")).toBe(true);
  });

  it("is a no-op for senior appointments", async () => {
    hoisted.docs.set("appointments/sa1", { clientId: "c1", caregiverId: CG, status: "confirmed" });
    const state = await handleOverdueChildcareVisit("sa1", hoisted.docs.get("appointments/sa1"), {
      db: hoisted.db as any,
      now: NOW,
    });
    expect(state).toBeNull();
    expect(hoisted.docs.get("appointments/sa1").childcareOverdueState).toBeUndefined();
  });
});

// ── Refund requests (policy-driven; existing refundRequests machine) ─────────

function seedPaidOccurrenceRow(id = "cappt_occ1", overrides: Record<string, unknown> = {}) {
  hoisted.docs.set(`shiftHours/${id}`, {
    careVertical: "child",
    childcareBookingId: BOOKING,
    childcareShiftId: id,
    billingUserId: PAYER,
    clientId: FAMILY,
    caregiverId: CG,
    status: "paid",
    stripeChargeId: "pi_1",
    stripeTransferId: "tr_1",
    amountCents: 9800,
    // Checkout 2h before the real test clock — inside the 72h policy window.
    submittedEndTime: new Date(Date.now() - 2 * 3600_000).toISOString(),
    childcareRefundPolicy: { windowHours: 72, allowPartial: true, maxPercent: 100 },
    ...overrides,
  });
}

describe("requestChildcareRefund (policy-driven → existing refund state machine)", () => {
  it("the recorded payer creates ONE refundRequests row; duplicates converge (AE15)", async () => {
    seedBooking();
    seedPaidOccurrenceRow();
    const res = await requestRefund(
      { bookingId: BOOKING, occurrenceId: "cappt_occ1", reason: "visit cut short" },
      ctx(PAYER),
    );
    expect(res).toMatchObject({ success: true, created: true, status: "requested" });
    const row = hoisted.docs.get(`refundRequests/${res.requestId}`);
    expect(row).toMatchObject({
      careVertical: "child",
      childcareBookingId: BOOKING,
      clientId: FAMILY,
      requestedByUid: PAYER,
      appointmentId: "cappt_occ1",
      status: "requested",
      source: "childcare_web",
    });
    expect(row.amountCents).toBe(9800); // full refund default per policy max

    const dup = await requestRefund(
      { bookingId: BOOKING, occurrenceId: "cappt_occ1", reason: "visit cut short" },
      ctx(PAYER),
    );
    expect(dup.created).toBe(false);
    expect([...hoisted.docs.keys()].filter((p) => p.startsWith("refundRequests/"))).toHaveLength(1);
  });

  it("an adult with payment scope (not the recorded payer) may request; a stranger may not", async () => {
    seedBooking();
    seedPaidOccurrenceRow();
    grantPayment(FAMILY);
    const res = await requestRefund(
      { bookingId: BOOKING, occurrenceId: "cappt_occ1", reason: "r" },
      ctx(FAMILY),
    );
    expect(res.success).toBe(true);

    hoisted.docs.delete(`refundRequests/${res.requestId}`);
    await expect(
      requestRefund({ bookingId: BOOKING, occurrenceId: "cappt_occ1", reason: "r" }, ctx("stranger-1")),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("refuses outside the policy refund window (fail closed; admin path remains)", async () => {
    seedBooking();
    seedPaidOccurrenceRow("cappt_old", {
      submittedEndTime: new Date(Date.now() - 80 * 3600_000).toISOString(), // 80h ago > 72h window
    });
    await expect(
      requestRefund({ bookingId: BOOKING, occurrenceId: "cappt_old", reason: "r" }, ctx(PAYER)),
    ).rejects.toMatchObject({ details: expect.objectContaining({ code: "refund_window_closed" }) });
    expect([...hoisted.docs.keys()].filter((p) => p.startsWith("refundRequests/"))).toHaveLength(0);
  });

  it("refuses an uncharged occurrence", async () => {
    seedBooking();
    seedPaidOccurrenceRow("cappt_pend", { status: "pending_client_review", stripeChargeId: null });
    await expect(
      requestRefund({ bookingId: BOOKING, occurrenceId: "cappt_pend", reason: "r" }, ctx(PAYER)),
    ).rejects.toMatchObject({ details: expect.objectContaining({ code: "occurrence_not_charged" }) });
  });
});

// ── Dispute / chargeback payout hold ─────────────────────────────────────────

describe("holdChildcareShiftPayout (dispute holds payout — R39)", () => {
  it("holds an un-transferred childcare row", async () => {
    seedPaidOccurrenceRow("cappt_hold", { status: "approved", stripeTransferId: null });
    const r = await holdChildcareShiftPayout("cappt_hold", "dispute:d1", { db: hoisted.db as any, now: NOW });
    expect(r).toEqual({ held: true, alreadyPaidOut: false });
    const row = hoisted.docs.get("shiftHours/cappt_hold");
    expect(row.payoutHold).toBe(true);
    expect(row.payoutHoldReason).toBe("dispute:d1");
  });

  it("escalates (never silently claws back) when the transfer already went out", async () => {
    seedPaidOccurrenceRow("cappt_paid");
    const r = await holdChildcareShiftPayout("cappt_paid", "dispute:d2", { db: hoisted.db as any, now: NOW });
    expect(r).toEqual({ held: false, alreadyPaidOut: true });
    expect(hoisted.docs.get("shiftHours/cappt_paid").payoutHold).toBeUndefined();
    const alerts = [...hoisted.docs.values()].filter((d) => d.type === "childcare_dispute_after_payout");
    expect(alerts).toHaveLength(1);
  });

  it("is a no-op for senior rows", async () => {
    hoisted.docs.set("shiftHours/sa1", { clientId: "c1", caregiverId: CG, status: "approved" });
    const r = await holdChildcareShiftPayout("sa1", "dispute:d3", { db: hoisted.db as any, now: NOW });
    expect(r).toEqual({ held: false, alreadyPaidOut: false });
    expect(hoisted.docs.get("shiftHours/sa1").payoutHold).toBeUndefined();
  });
});

// ── Cancellation policy outcome ──────────────────────────────────────────────

describe("evaluateAndRecordChildcareCancellation (policy outcome; auth canceled via the seam)", () => {
  it("records the policy window outcome and cancels a live authorization", async () => {
    seedBooking({
      status: "canceled",
      paymentAuthorization: { state: "authorized", correlationId: "seti_1", updatedAt: "x" },
      schedule: { dates: [{ date: "2026-08-12", startTime: "09:00", endTime: "13:00" }], recurring: null },
    });
    await evaluateAndRecordChildcareCancellation(BOOKING, {
      db: hoisted.db as any,
      // 2026-08-10T23:00Z is 41h before the 2026-08-12 09:00 PT (16:00Z)
      // start → inside the 24h window boundary → 50% per policy.
      now: new Date("2026-08-10T23:00:00.000Z"),
      byUid: FAMILY,
    });
    const booking = hoisted.docs.get(`booking_requests/${BOOKING}`);
    expect(booking.cancellationPolicyOutcome).toMatchObject({
      refundPercent: 50,
      matchedWindowHours: 24,
      policyVersion: "CA-2026-07-22.1",
      byUid: FAMILY,
    });
    expect(recordAuthMock).toHaveBeenCalledWith(
      { bookingId: BOOKING, state: "canceled", correlationId: "seti_1" },
      expect.anything(),
    );
  });

  it("never throws into the committed cancel (missing snapshot is tolerated)", async () => {
    seedBooking({ status: "canceled", paymentSetup: { pendingPayer: true } });
    await expect(
      evaluateAndRecordChildcareCancellation(BOOKING, { db: hoisted.db as any, now: NOW }),
    ).resolves.toBeUndefined();
  });
});

describe("hasPaymentScopeForBooking", () => {
  it("requires LIVE payment scope for EVERY child", async () => {
    grantPayment(PAYER, "child-a");
    expect(await hasPaymentScopeForBooking(PAYER, { childIds: ["child-a"] }, hoisted.db as any)).toBe(true);
    expect(await hasPaymentScopeForBooking(PAYER, { childIds: ["child-a", "child-b"] }, hoisted.db as any)).toBe(false);
    expect(await hasPaymentScopeForBooking(PAYER, { childIds: [] }, hoisted.db as any)).toBe(false);
  });
});
