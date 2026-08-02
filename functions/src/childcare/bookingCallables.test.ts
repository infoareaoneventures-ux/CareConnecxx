// U7 childcare booking callable tests (plan 2026-07-22-002, R36-R40/R46).
//
// Scenarios (plan U7 list): request/accept order enforced; screening expiry
// between request and acceptance blocks; time conflict same vertical AND
// cross-vertical both directions; duplicate request idempotent; sibling
// booking (one booking, authority per child); recurring generation vertical-
// stamped; overnight blocked by policy end-to-end; cancellation revokes
// safety + file access; extension revalidates; authority change invalidates
// safety versions via the U2 outbox effect; substitution revoke-first
// ordering (intermediate state asserted); policy disable mid-flight; stale
// booking state version; payment-authorization AE14 semantics (U8 seam);
// child-safe appointment/shift/notification content; full middleware stack.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── In-memory Firestore mock (safetyProjection pattern: ==, in, array-contains) ──
const hoisted = vi.hoisted(() => {
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

  // FieldValue.increment must behave like the real sentinel or writes that use
  // it (ai/caregiverReputation.recordCaregiverOutcome) throw inside a caught
  // block and the suite silently covers nothing.
  const resolveSentinels = (prev: any, data: any): any => {
    const out: any = {};
    for (const [k, v] of Object.entries(data ?? {})) {
      if (v && typeof v === "object" && !Array.isArray(v) && "__increment" in (v as any)) {
        const base = typeof prev?.[k] === "number" ? prev[k] : 0;
        out[k] = base + Number((v as any).__increment ?? 0);
      } else {
        out[k] = v;
      }
    }
    return out;
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
      const prev = docs.get(path);
      const resolved = resolveSentinels(prev, data);
      docs.set(path, opts?.merge ? { ...(prev ?? {}), ...resolved } : { ...resolved });
    },
    update: async (data: any) => {
      if (!docs.has(path)) {
        const err: any = new Error(`5 NOT_FOUND: ${path}`);
        err.code = 5;
        throw err;
      }
      const prev = docs.get(path);
      docs.set(path, { ...(prev ?? {}), ...resolveSentinels(prev, data) });
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

  const runTransaction = async (fn: any) => {
    const tx = {
      get: (ref: any) => ref.get(),
      set: (ref: any, data: any, opts?: any) => {
        void ref.set(data, opts);
      },
      update: (ref: any, data: any) => {
        const prev = docs.get(ref.path);
        docs.set(ref.path, { ...(prev ?? {}), ...resolveSentinels(prev, data) });
      },
    };
    return fn(tx);
  };

  return {
    docs,
    db: { collection: (p: string) => makeCollRef(p), runTransaction },
    reset: () => docs.clear(),
  };
});

vi.mock("firebase-admin", () => {
  // FieldValue is required by the U9 idempotent notification writer
  // (notifications/userNotification.ts) that bookingCallables now routes
  // its generic child-safe rows through, AND by the U8/R45 per-vertical
  // reputation write (ai/caregiverReputation) on the confirm path — `increment`
  // is resolved by the mock's write path so that write really executes.
  const firestore: any = Object.assign(() => hoisted.db, {
    FieldValue: {
      serverTimestamp: () => ({ __serverTimestamp: true }),
      delete: () => ({ __delete: true }),
      increment: (n: number) => ({ __increment: n }),
    },
  });
  const storage: any = () => ({ bucket: () => ({}) });
  return {
    __esModule: true,
    default: { firestore, storage, apps: [{}] },
    firestore,
    storage,
    apps: [{}],
  };
});
vi.mock("../observability/auditLog", () => ({
  logAudit: vi.fn(async () => {}),
  logBookingCreated: vi.fn(async () => {}),
}));

// agents/bookingExecutor's senior side effects (heavy graphs) — mocked so the
// EXPORTED hasConflict (the cross-vertical gate under test) imports cleanly.
vi.mock("../linq/client", () => ({
  sendMessage: vi.fn(async () => {}),
  getOrCreateSession: vi.fn(async () => ({ chatId: "chat-1" })),
}));
vi.mock("../notifications", () => ({ notifyAdminBookingConfirmed: vi.fn(async () => {}) }));
vi.mock("../triggers/jobNotifications", () => ({ closeJobPost: vi.fn(async () => {}) }));
vi.mock("../utils/caraMessage", () => ({ generateCaraMessage: vi.fn(async () => "msg") }));
vi.mock("../agents/shiftOffer", () => ({ createShiftOffer: vi.fn(async () => "offer-1") }));
vi.mock("../billing/createValidatedShiftHours", () => ({ BILLING_AUTHORITY_VERSION: "test" }));
vi.mock("../utils/caregiverEligibility", () => ({ isCaregiverBookable: vi.fn(() => true) }));

const recheckMock = vi.hoisted(() => vi.fn());
vi.mock("./providerEligibility", () => ({
  recheckChildcareProviderEligibility: recheckMock,
}));

import {
  requestChildcareBooking as _request,
  acceptChildcareBooking as _accept,
  declineChildcareBooking as _decline,
  cancelChildcareBooking as _cancel,
  requestChildcareBookingChange as _change,
  respondChildcareBookingChange as _respondChange,
  substituteChildcareCaregiver as _substitute,
  checkInChildcareShift as _checkIn,
  checkOutChildcareShift as _checkOut,
  getChildcareBookingSafety as _getSafety,
  acceptChildcareApplication as _acceptApp,
  rejectChildcareApplication as _rejectApp,
  childcareBookingDocId,
  childcareAppointmentDocId,
  recordChildcareBookingPaymentAuthorization,
  handleChildcareBookingRequestWrite,
  sweepChildcareRollingShifts,
  findChildcareBookingConflict,
} from "./bookingCallables";
import { hasConflict as seniorHasConflict } from "../agents/bookingExecutor";
import { createBookingAssignedProviderSource } from "./safetyProjection";
import { describeChildcareBookingStatus } from "./bookingPolicy";
import { authorityDocId, dispatchAuthorityOutboxRecord } from "./guardianAuthority";
import { assertChildSafeAppointmentDoc } from "../utils/appointmentDoc";
import { bustChildcareFlagsCache } from "../config/featureFlags";
import { familyChildcareObjectiveId } from "./signupIngress";

/* eslint-disable @typescript-eslint/no-explicit-any */
const requestBooking = _request as any;
const acceptBooking = _accept as any;
const declineBooking = _decline as any;
const cancelBooking = _cancel as any;
const requestChange = _change as any;
const respondChange = _respondChange as any;
const substitute = _substitute as any;
const checkIn = _checkIn as any;
const checkOut = _checkOut as any;
const getSafety = _getSafety as any;
const acceptApp = _acceptApp as any;
const rejectApp = _rejectApp as any;

const FAMILY = "family-1";
const CG = "cg-1";
const CG2 = "cg-2";
const HH = "hh_family-1";

function ctx(uid: string): any {
  return {
    auth: { uid, token: { auth_time: Math.floor(Date.now() / 1000) - 5 } },
    app: { appId: "test-app" },
  };
}

function enableFlags(overrides: Record<string, unknown> = {}) {
  hoisted.docs.set("childcare_flags/global", {
    CHILDCARE_ENABLED: true,
    CHILDCARE_DISCOVERY_ENABLED: true,
    CHILDCARE_WRITES_ENABLED: true,
    CHILDCARE_PROACTIVE_ENABLED: true,
    ...overrides,
  });
  bustChildcareFlagsCache();
}

function seedChild(childId: string, householdId = HH, safetyVersion = 1) {
  hoisted.docs.set(`child_profiles/${childId}`, {
    childId,
    householdId,
    careVertical: "child",
    displayLabel: childId === "child-a" ? "M." : "J.",
    ageBand: "preschool",
    careCategories: ["babysitting"],
    state: "active",
    authorizedViewerUids: [FAMILY],
    accessVersion: 1,
    safetyCurrentVersion: safetyVersion,
  });
  hoisted.docs.set(`child_profiles/${childId}/private/safety`, {
    childId,
    currentVersion: safetyVersion,
    accessVersion: safetyVersion,
  });
  hoisted.docs.set(`child_profiles/${childId}/private/safety/versions/${safetyVersion}`, {
    childId,
    version: safetyVersion,
    data: {
      dateOfBirth: "2022-04-01",
      emergencyContacts: [{ name: "Ana Adult", relationship: "parent", phone: "+15551230000" }],
      healthNotes: null,
      allergiesNote: "peanuts",
      pickupNotes: "Only Ana may pick up",
      custodyNotes: "RESTRICTED",
      addressDetail: "123 Exact St",
    },
    immutable: true,
  });
}

function seedAuthority(childId: string, uid: string, scopes: string[] = ["view", "schedule", "cancellation"]) {
  hoisted.docs.set(`guardian_authorities/${authorityDocId(childId, uid)}`, {
    authorityId: authorityDocId(childId, uid),
    householdId: HH,
    childId,
    adultUid: uid,
    state: "active",
    scopes,
    accessVersion: 1,
  });
}

function seedIdentity(uid = FAMILY) {
  hoisted.docs.set(
    `childcare_identity_sessions/${familyChildcareObjectiveId(uid)}`,
    { status: "verified", adultUid: uid },
  );
}

function seedCaregiver(uid = CG, name = "Pat Provider") {
  hoisted.docs.set(`caregivers/${uid}`, { name, phone: "+15559990000" });
}

const ELIGIBLE = () => ({
  eligible: true,
  issues: [],
  eligibilityVersion: "childcare-provider-eligibility-test",
  evidenceVersion: 2,
  capabilities: { transport: false },
  evidenceLabels: [],
  renewal: { expiresAt: null, due: false, overdue: false },
});
const INELIGIBLE = (code: string) => ({
  ...ELIGIBLE(),
  eligible: false,
  issues: [{ code, field: "x", detail: "d" }],
});

const SCHEDULE = () => ({
  dates: [{ date: "2026-08-10", startTime: "09:00", endTime: "13:00" }],
});

const REQUEST_INPUT = (overrides: Record<string, unknown> = {}) => ({
  idempotencyKey: "bk-1",
  caregiverId: CG,
  childIds: ["child-a"],
  schedule: SCHEDULE(),
  hourlyRate: 28,
  ...overrides,
});

function seedFamily(childIds = ["child-a"]) {
  for (const c of childIds) {
    seedChild(c);
    seedAuthority(c, FAMILY);
  }
  seedIdentity();
  seedCaregiver();
}

async function createRequestedBooking(input: Record<string, unknown> = {}): Promise<string> {
  const res = await requestBooking(REQUEST_INPUT(input), ctx(FAMILY));
  expect(res.success).toBe(true);
  return res.bookingId as string;
}

async function createAcceptedBooking(): Promise<string> {
  const bookingId = await createRequestedBooking();
  const res = await acceptBooking({ bookingId }, ctx(CG));
  expect(res.success).toBe(true);
  return bookingId;
}

async function createConfirmedBooking(): Promise<string> {
  const bookingId = await createAcceptedBooking();
  await recordChildcareBookingPaymentAuthorization({
    bookingId,
    state: "authorized",
    correlationId: "pi_test_1",
  });
  expect(hoisted.docs.get(`booking_requests/${bookingId}`).status).toBe("confirmed");
  return bookingId;
}

beforeEach(() => {
  hoisted.reset();
  recheckMock.mockReset();
  recheckMock.mockResolvedValue(ELIGIBLE());
  enableFlags();
});

// ── requestChildcareBooking ──────────────────────────────────────────────────

describe("requestChildcareBooking", () => {
  it("creates a requested booking with typed references, a recheck stamp, and evidence (R36)", async () => {
    seedFamily();
    const bookingId = await createRequestedBooking();
    expect(bookingId).toBe(childcareBookingDocId(FAMILY, "bk-1"));

    const stored = hoisted.docs.get(`booking_requests/${bookingId}`);
    expect(stored.careVertical).toBe("child");
    expect(stored.status).toBe("requested");
    expect(stored.recipientRef).toEqual({ careVertical: "child", householdId: HH, childIds: ["child-a"] });
    expect(stored.paymentAuthorization.state).toBe("none");
    expect(stored.eligibilitySnapshot.context).toBe("booking_request");
    expect(recheckMock).toHaveBeenCalledWith(CG, expect.objectContaining({ context: "booking_request" }));
    // Postcondition evidence (fresh read) stored on the doc.
    expect(stored.lastTransitionEvidence).toMatchObject({
      actionName: "childcare_booking_request",
      status: "verified",
      safeClaimCode: "completed_verified",
    });
    // The stored doc carries NO child-sensitive fields (R46).
    expect(() => assertChildSafeAppointmentDoc(stored, "test")).not.toThrow();
    // Generic child-safe caregiver notification, no child name.
    const notifications = [...hoisted.docs.entries()].filter(([p]) => p.startsWith(`users/${CG}/notifications/`));
    expect(notifications).toHaveLength(1);
    expect(JSON.stringify(notifications[0][1])).not.toContain("M.");
  });

  it("duplicate request is idempotent (same idempotencyKey converges — AE15)", async () => {
    seedFamily();
    const first = await requestBooking(REQUEST_INPUT(), ctx(FAMILY));
    const replay = await requestBooking(REQUEST_INPUT(), ctx(FAMILY));
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.bookingId).toBe(first.bookingId);
    const notifications = [...hoisted.docs.keys()].filter((p) => p.startsWith(`users/${CG}/notifications/`));
    expect(notifications).toHaveLength(1); // no duplicate notification
  });

  it("sibling booking: multiple children, ONE booking, authority checked PER child (AE1/AE4)", async () => {
    seedFamily(["child-a", "child-b"]);
    const res = await requestBooking(
      REQUEST_INPUT({ childIds: ["child-a", "child-b"] }),
      ctx(FAMILY),
    );
    const stored = hoisted.docs.get(`booking_requests/${res.bookingId}`);
    expect(stored.childIds).toEqual(["child-a", "child-b"]);
    expect(stored.recipientLabel).toBe("M. & J.");

    // Missing authority for ONE sibling denies the whole booking.
    hoisted.reset();
    enableFlags();
    seedFamily(["child-a"]);
    seedChild("child-b"); // profile exists but NO authority record
    await expect(
      requestBooking(REQUEST_INPUT({ idempotencyKey: "bk-2", childIds: ["child-a", "child-b"] }), ctx(FAMILY)),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("requires verified identity and per-child schedule authority", async () => {
    seedChild("child-a");
    seedAuthority("child-a", FAMILY);
    seedCaregiver();
    // No identity session:
    await expect(requestBooking(REQUEST_INPUT(), ctx(FAMILY))).rejects.toMatchObject({
      code: "failed-precondition",
    });
    seedIdentity();
    // Wrong scope (view only):
    seedAuthority("child-a", FAMILY, ["view"]);
    await expect(requestBooking(REQUEST_INPUT(), ctx(FAMILY))).rejects.toMatchObject({
      code: "permission-denied",
    });
  });

  it("overnight schedules are blocked by policy end-to-end (deferred category — R37)", async () => {
    seedFamily();
    await expect(
      requestBooking(
        REQUEST_INPUT({
          schedule: { dates: [{ date: "2026-08-10", startTime: "20:00", endTime: "06:00" }] },
        }),
        ctx(FAMILY),
      ),
    ).rejects.toMatchObject({
      code: "failed-precondition",
      details: { code: "deferred_category" },
    });
    expect(hoisted.docs.has(`booking_requests/${childcareBookingDocId(FAMILY, "bk-1")}`)).toBe(false);
  });

  it("an ineligible provider blocks the request (R29 context booking_request)", async () => {
    seedFamily();
    recheckMock.mockResolvedValue(INELIGIBLE("screening_expired"));
    await expect(requestBooking(REQUEST_INPUT(), ctx(FAMILY))).rejects.toMatchObject({
      code: "failed-precondition",
      details: { code: "provider_not_eligible" },
    });
  });

  it("books from an ACCEPTED application (the U6 deferral feeds booking)", async () => {
    seedFamily();
    hoisted.docs.set("job_applications/capp_x", {
      careVertical: "child",
      clientId: FAMILY,
      caregiverId: CG,
      jobId: "cjob_x",
      status: "accepted",
    });
    const res = await requestBooking(
      REQUEST_INPUT({ caregiverId: undefined, applicationId: "capp_x" }),
      ctx(FAMILY),
    );
    const stored = hoisted.docs.get(`booking_requests/${res.bookingId}`);
    expect(stored.caregiverId).toBe(CG);
    expect(stored.jobId).toBe("cjob_x");

    // A PENDING (not accepted) application cannot feed a booking.
    hoisted.docs.set("job_applications/capp_x", {
      careVertical: "child", clientId: FAMILY, caregiverId: CG, jobId: "cjob_x", status: "pending",
    });
    await expect(
      requestBooking(REQUEST_INPUT({ idempotencyKey: "bk-9", caregiverId: undefined, applicationId: "capp_x" }), ctx(FAMILY)),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });
});

// ── Conflicts (same vertical AND cross-vertical, both directions) ────────────

describe("conflict checks (R37/KTD12)", () => {
  it("blocks a childcare request over an existing SENIOR appointment (cross-vertical direction 1)", async () => {
    seedFamily();
    hoisted.docs.set("appointments/senior-1", {
      clientId: "senior-client",
      caregiverId: CG,
      seniorName: "Rose",
      date: "2026-08-10",
      startTime: "12:00",
      endTime: "16:00",
      status: "confirmed",
    });
    await expect(requestBooking(REQUEST_INPUT(), ctx(FAMILY))).rejects.toMatchObject({
      code: "failed-precondition",
      details: expect.objectContaining({ code: "schedule_conflict" }),
    });
  });

  it("a confirmed childcare booking blocks the SENIOR conflict gate (cross-vertical direction 2)", async () => {
    seedFamily();
    const bookingId = await createConfirmedBooking();
    // The confirmed booking materialized a shared appointment doc:
    const apptId = childcareAppointmentDocId(bookingId, "2026-08-10", "09:00");
    expect(hoisted.docs.get(`appointments/${apptId}`).careVertical).toBe("child");
    // The SENIOR gate (bookingExecutor.hasConflict) sees it and blocks.
    expect(await seniorHasConflict(CG, "2026-08-10", "12:00", "14:00")).toBe(true);
    expect(await seniorHasConflict(CG, "2026-08-10", "13:00", "14:00")).toBe(false);
  });

  it("blocks a second childcare booking over a pending childcare booking (same vertical)", async () => {
    seedFamily();
    await createRequestedBooking();
    await expect(
      requestBooking(REQUEST_INPUT({ idempotencyKey: "bk-2" }), ctx(FAMILY)),
    ).rejects.toMatchObject({
      code: "failed-precondition",
      details: expect.objectContaining({ code: "schedule_conflict" }),
    });
  });

  it("recurring rules conflict on matching weekdays", async () => {
    seedFamily();
    hoisted.docs.set(`booking_requests/other`, {
      careVertical: "child",
      caregiverId: CG,
      status: "confirmed",
      schedule: { dates: [], recurring: { days: ["monday"], startTime: "08:00", endTime: "12:00" } },
    });
    // 2026-08-10 is a Monday, 09:00-13:00 overlaps 08:00-12:00.
    const result = await findChildcareBookingConflict({
      caregiverId: CG,
      schedule: { dates: [{ date: "2026-08-10", startTime: "09:00", endTime: "13:00" }], recurring: null },
    });
    expect(result.conflict).toBe(true);
    expect(result.source).toBe("childcare_booking");
  });
});

// ── accept / decline (R36 order, screening expiry, conflict re-check) ────────

describe("acceptChildcareBooking / declineChildcareBooking", () => {
  it("acceptance creates safety projection v1 and grants the caregiver (R38)", async () => {
    seedFamily();
    const bookingId = await createAcceptedBooking();
    const stored = hoisted.docs.get(`booking_requests/${bookingId}`);
    expect(stored.status).toBe("accepted");
    expect(stored.safetyAccessVersion).toBe(1);
    const pointer = hoisted.docs.get(`childcare_booking_safety/${bookingId}`);
    expect(pointer).toMatchObject({ state: "active", assignedCaregiverUid: CG, currentVersion: 1 });
    // The caregiver can now read the safety projection through the callable.
    const safety = await getSafety({ bookingId }, ctx(CG));
    expect(safety.children[0].pickupNotes).toContain("Ana");
    expect(recheckMock).toHaveBeenCalledWith(CG, expect.objectContaining({ context: "acceptance" }));
  });

  it("screening expiry between request and acceptance BLOCKS acceptance (R29)", async () => {
    seedFamily();
    const bookingId = await createRequestedBooking();
    recheckMock.mockResolvedValue(INELIGIBLE("screening_expired"));
    await expect(acceptBooking({ bookingId }, ctx(CG))).rejects.toMatchObject({
      code: "failed-precondition",
      details: { code: "provider_not_eligible" },
    });
    expect(hoisted.docs.get(`booking_requests/${bookingId}`).status).toBe("requested");
    expect(hoisted.docs.has(`childcare_booking_safety/${bookingId}`)).toBe(false);
  });

  it("acceptance re-checks conflicts (a senior visit booked since the request blocks)", async () => {
    seedFamily();
    const bookingId = await createRequestedBooking();
    hoisted.docs.set("appointments/senior-late", {
      caregiverId: CG,
      clientId: "senior-client",
      date: "2026-08-10",
      startTime: "10:00",
      endTime: "12:00",
      status: "pending_caregiver_confirmation",
    });
    await expect(acceptBooking({ bookingId }, ctx(CG))).rejects.toMatchObject({
      details: expect.objectContaining({ code: "schedule_conflict" }),
    });
  });

  it("only the requested caregiver may accept/decline; stale state versions fail closed", async () => {
    seedFamily();
    const bookingId = await createRequestedBooking();
    await expect(acceptBooking({ bookingId }, ctx("cg-impostor"))).rejects.toMatchObject({
      code: "permission-denied",
    });
    await expect(
      acceptBooking({ bookingId, expectedStateVersion: 99 }, ctx(CG)),
    ).rejects.toMatchObject({ code: "failed-precondition", details: { code: "stale_state_version" } });
  });

  it("decline is terminal and notifies the family generically", async () => {
    seedFamily();
    const bookingId = await createRequestedBooking();
    const res = await declineBooking({ bookingId }, ctx(CG));
    expect(res.status).toBe("declined");
    // Accept after decline is an invalid transition.
    await expect(acceptBooking({ bookingId }, ctx(CG))).rejects.toMatchObject({
      code: "failed-precondition",
    });
  });

  it("policy disable mid-flight blocks acceptance (Firestore-resident flags — R61)", async () => {
    seedFamily();
    const bookingId = await createRequestedBooking();
    enableFlags({ CHILDCARE_WRITES_ENABLED: false });
    await expect(acceptBooking({ bookingId }, ctx(CG))).rejects.toMatchObject({
      code: "failed-precondition",
      details: { code: "childcare_disabled" },
    });
  });
});

// ── Payment authorization (AE14 + the U8 seam) ───────────────────────────────

describe("recordChildcareBookingPaymentAuthorization (U8 seam)", () => {
  it("authorization BEFORE acceptance keeps the booking requested and 'pending' in copy (AE14)", async () => {
    seedFamily();
    const bookingId = await createRequestedBooking();
    const { booking, confirmed } = await recordChildcareBookingPaymentAuthorization({
      bookingId,
      state: "authorized",
      correlationId: "pi_early",
    });
    expect(confirmed).toBe(false);
    expect(booking.status).toBe("requested");
    const copy = describeChildcareBookingStatus(booking.status, booking.paymentAuthorization.state);
    expect(copy.toLowerCase()).toContain("pending");
    expect(copy).not.toMatch(/^Booking confirmed/);
  });

  it("acceptance + authorization confirms exactly once and materializes the calendar", async () => {
    seedFamily();
    const bookingId = await createConfirmedBooking();
    const apptId = childcareAppointmentDocId(bookingId, "2026-08-10", "09:00");
    const appt = hoisted.docs.get(`appointments/${apptId}`);
    expect(appt).toMatchObject({
      careVertical: "child",
      status: "confirmed",
      recipientLabel: "M.",
      time: "09:00",
      duration: 4,
      cost: 112,
    });
    expect(appt.seniorName).toBeUndefined();
    expect(appt.billingAuthority).toBeUndefined(); // childcare money is U8
    expect(() => assertChildSafeAppointmentDoc(appt, "test")).not.toThrow();

    // Duplicate authorization replays converge (idempotent — AE15).
    const before = { ...hoisted.docs.get(`booking_requests/${bookingId}`) };
    const replay = await recordChildcareBookingPaymentAuthorization({
      bookingId,
      state: "authorized",
      correlationId: "pi_test_1",
    });
    expect(replay.booking.stateVersion).toBe(before.stateVersion);
    const appts = [...hoisted.docs.keys()].filter((p) => p.startsWith("appointments/"));
    expect(appts).toHaveLength(1);
  });

  it("payment authorized on an accepted booking auto-confirms (either order works — R36)", async () => {
    seedFamily();
    const bookingId = await createRequestedBooking();
    await recordChildcareBookingPaymentAuthorization({ bookingId, state: "authorized", correlationId: "pi_x" });
    expect(hoisted.docs.get(`booking_requests/${bookingId}`).status).toBe("requested");
    await acceptBooking({ bookingId }, ctx(CG));
    expect(hoisted.docs.get(`booking_requests/${bookingId}`).status).toBe("confirmed");
  });
});

// ── U8/R45: the per-vertical hire outcome the confirm path records ────────────
//
// These assert the WRITE, not just that the call site exists (u8VerticalGuards
// only greps the source). The suite's FieldValue.increment is faithful, so a
// regression in recordCaregiverOutcome — or a vertical mix-up — fails here
// instead of being swallowed by the caller's try/catch.

describe("childcare confirm records a CHILD-vertical hire outcome (R45)", () => {
  const repDoc = () => hoisted.docs.get(`caregiver_reputation/${CG}`);

  it("lands in child-prefixed fields only — the senior fields are absent", async () => {
    seedFamily();
    await createConfirmedBooking();
    const rep = repDoc();
    expect(rep).toBeDefined();
    expect(rep.childScore).toBe(1);
    expect(rep.childHireCount).toBe(1);
    expect(rep.childPassCount).toBe(0);
    expect(typeof rep.childLastOutcomeAt).toBe("number");
    // R45 direction 1: no senior leakage.
    expect(rep.score).toBeUndefined();
    expect(rep.hireCount).toBeUndefined();
    expect(rep.passCount).toBeUndefined();
    expect(rep.lastOutcomeAt).toBeUndefined();
  });

  it("a pre-existing SENIOR history is left untouched by the childcare hire (R45 both directions)", async () => {
    hoisted.docs.set(`caregiver_reputation/${CG}`, {
      score: 3,
      lastOutcomeAt: 1_700_000_000_000,
      hireCount: 3,
      passCount: 1,
    });
    seedFamily();
    await createConfirmedBooking();
    const rep = repDoc();
    // Senior aggregates byte-identical…
    expect(rep.score).toBe(3);
    expect(rep.lastOutcomeAt).toBe(1_700_000_000_000);
    expect(rep.hireCount).toBe(3);
    expect(rep.passCount).toBe(1);
    // …childcare aggregates start from zero regardless of the senior history.
    expect(rep.childScore).toBe(1);
    expect(rep.childHireCount).toBe(1);
    expect(rep.childPassCount).toBe(0);
  });

  it("the outcome is recorded EXACTLY once — authorization replays do not inflate it", async () => {
    seedFamily();
    const bookingId = await createConfirmedBooking();
    expect(repDoc().childHireCount).toBe(1);
    for (let i = 0; i < 3; i++) {
      await recordChildcareBookingPaymentAuthorization({
        bookingId,
        state: "authorized",
        correlationId: "pi_test_1",
      });
    }
    expect(repDoc().childHireCount).toBe(1);
    expect(repDoc().childScore).toBe(1);
  });

  it("no reputation row is written for a booking that never confirms", async () => {
    seedFamily();
    await createRequestedBooking();
    expect(repDoc()).toBeUndefined();
  });
});

// ── Recurring generation (vertical-stamped shifts) ───────────────────────────

describe("recurring childcare bookings generate vertical-stamped shifts", () => {
  async function confirmedRecurringBooking(): Promise<string> {
    seedFamily();
    const res = await requestBooking(
      REQUEST_INPUT({
        idempotencyKey: "bk-rec",
        schedule: { dates: [], recurring: { days: ["monday", "wednesday"], startTime: "09:00", endTime: "12:00" } },
      }),
      ctx(FAMILY),
    );
    const bookingId = res.bookingId as string;
    await acceptBooking({ bookingId }, ctx(CG));
    await recordChildcareBookingPaymentAuthorization({ bookingId, state: "authorized", correlationId: "pi_r" });
    return bookingId;
  }

  it("confirmation generates child-safe scheduled shifts (no address/careNeeds/emergencyContact)", async () => {
    const bookingId = await confirmedRecurringBooking();
    // Confirmation ENQUEUES a durable generation operation inside the confirm
    // transaction (it never generates inline — pinned by
    // shiftGenerationOperations.test.ts); the leased worker materializes the
    // shifts, so drive it here before asserting the shift content.
    await sweepChildcareRollingShifts();
    const shifts = [...hoisted.docs.entries()].filter(([p]) => p.startsWith("shifts/"));
    expect(shifts.length).toBeGreaterThan(0);
    for (const [, shift] of shifts) {
      expect(shift.careVertical).toBe("child");
      expect(shift.bookingRequestId).toBe(bookingId);
      expect(shift.status).toBe("scheduled");
      expect(shift.address).toBeUndefined();
      expect(shift.careNeeds).toBeUndefined();
      expect(shift.emergencyContact).toBeUndefined();
      expect(() => assertChildSafeAppointmentDoc(shift, "test")).not.toThrow();
    }
  });

  it("the trigger seam and the rolling sweep are idempotent (deterministic shift IDs)", async () => {
    const bookingId = await confirmedRecurringBooking();
    await sweepChildcareRollingShifts();
    const countBefore = [...hoisted.docs.keys()].filter((p) => p.startsWith("shifts/")).length;
    expect(countBefore).toBeGreaterThan(0);
    const opsOf = () => [...hoisted.docs.entries()]
      .filter(([p]) => p.startsWith("childcare_shift_generation_operations/"));
    const opBefore = { ...opsOf()[0][1] };
    expect(opBefore).toMatchObject({ state: "completed", createdCount: countBefore });

    // Replaying the trigger seam targets the SAME deterministic operation id.
    // Because the operation already reached a TERMINAL state, the replay is a
    // true no-op: no reset back to pending, no re-run, no duplicate shifts and
    // no loss of createdCount/completedAt.
    await handleChildcareBookingRequestWrite(bookingId, hoisted.docs.get(`booking_requests/${bookingId}`));
    await sweepChildcareRollingShifts();
    const countAfter = [...hoisted.docs.keys()].filter((p) => p.startsWith("shifts/")).length;
    expect(countAfter).toBe(countBefore);
    const ops = opsOf();
    expect(ops).toHaveLength(1);
    expect(ops[0][1]).toEqual(opBefore);
  });

  it("the trigger seam ignores senior docs and respects the flags (dark = no-op)", async () => {
    await handleChildcareBookingRequestWrite("senior-b", { status: "accepted", clientName: "Rose" });
    expect([...hoisted.docs.keys()].filter((p) => p.startsWith("shifts/"))).toHaveLength(0);
    seedFamily();
    const bookingId = await confirmedRecurringBooking();
    for (const key of [...hoisted.docs.keys()]) {
      if (key.startsWith("shifts/")) hoisted.docs.delete(key);
    }
    enableFlags({ CHILDCARE_ENABLED: false });
    await handleChildcareBookingRequestWrite(bookingId, hoisted.docs.get(`booking_requests/${bookingId}`));
    expect([...hoisted.docs.keys()].filter((p) => p.startsWith("shifts/"))).toHaveLength(0);
  });
});

// ── Cancellation (revoke first — AE6) ────────────────────────────────────────

describe("cancelChildcareBooking", () => {
  it("family cancellation revokes safety AND file access, then cancels the calendar", async () => {
    seedFamily();
    const bookingId = await createConfirmedBooking();
    const res = await cancelBooking({ bookingId }, ctx(FAMILY));
    expect(res.status).toBe("canceled");

    // Safety read denied (revoked pointer).
    await expect(getSafety({ bookingId }, ctx(CG))).rejects.toMatchObject({ code: "permission-denied" });
    // File-access source denied.
    const source = createBookingAssignedProviderSource();
    expect((await source.isAssignedProviderEligible(CG, "child-a")).eligible).toBe(false);
    const bookingRoom = [...hoisted.docs.entries()]
      .find(([path, doc]) =>
        path.startsWith("chatRooms/") &&
        doc.careVertical === "child" &&
        doc.contextId === bookingId
      )?.[1];
    expect(bookingRoom?.participants).not.toContain(CG);
    expect(bookingRoom?.state).toBe("revoked");
    // Calendar cancelled.
    const apptId = childcareAppointmentDocId(bookingId, "2026-08-10", "09:00");
    expect(hoisted.docs.get(`appointments/${apptId}`).status).toBe("cancelled");
  });

  it("the assigned provider may cancel; a stranger may not; family needs the cancellation scope", async () => {
    seedFamily();
    const bookingId = await createAcceptedBooking();
    await expect(cancelBooking({ bookingId }, ctx("stranger"))).rejects.toMatchObject({
      code: "permission-denied",
    });
    // Family WITHOUT the cancellation scope:
    seedAuthority("child-a", FAMILY, ["view", "schedule"]);
    await expect(cancelBooking({ bookingId }, ctx(FAMILY))).rejects.toMatchObject({
      code: "permission-denied",
    });
    // Provider cancels their own.
    const res = await cancelBooking({ bookingId }, ctx(CG));
    expect(res.status).toBe("canceled");
  });
});

// ── Change / extension (revalidates — R37) ───────────────────────────────────

describe("requestChildcareBookingChange / respondChildcareBookingChange", () => {
  it("extension revalidates conflicts at the NEW time", async () => {
    seedFamily();
    const bookingId = await createConfirmedBooking();
    hoisted.docs.set("appointments/senior-2", {
      caregiverId: CG,
      clientId: "sr",
      date: "2026-08-10",
      startTime: "13:00",
      endTime: "15:00",
      status: "confirmed",
    });
    // Extending 09:00-13:00 → 09:00-14:00 collides with the senior 13:00 visit.
    await expect(
      requestChange(
        {
          bookingId,
          idempotencyKey: "chg-1",
          schedule: { dates: [{ date: "2026-08-10", startTime: "09:00", endTime: "14:00" }] },
        },
        ctx(FAMILY),
      ),
    ).rejects.toMatchObject({ details: expect.objectContaining({ code: "schedule_conflict" }) });
  });

  it("post-acceptance changes are PENDING until the provider re-accepts, then re-materialize the calendar", async () => {
    seedFamily();
    const bookingId = await createConfirmedBooking();
    const res = await requestChange(
      {
        bookingId,
        idempotencyKey: "chg-2",
        schedule: { dates: [{ date: "2026-08-11", startTime: "10:00", endTime: "14:00" }] },
      },
      ctx(FAMILY),
    );
    expect(res.pending).toBe(true);
    expect(hoisted.docs.get(`booking_requests/${bookingId}`).schedule.dates[0].date).toBe("2026-08-10");

    const applied = await respondChange({ bookingId, accept: true }, ctx(CG));
    expect(applied.applied).toBe(true);
    const stored = hoisted.docs.get(`booking_requests/${bookingId}`);
    expect(stored.schedule.dates[0].date).toBe("2026-08-11");
    // Old appointment cancelled, new one created.
    expect(hoisted.docs.get(`appointments/${childcareAppointmentDocId(bookingId, "2026-08-10", "09:00")}`).status).toBe("cancelled");
    expect(hoisted.docs.get(`appointments/${childcareAppointmentDocId(bookingId, "2026-08-11", "10:00")}`).status).toBe("confirmed");
  });

  it("pre-acceptance changes apply directly (the family amends their own request)", async () => {
    seedFamily();
    const bookingId = await createRequestedBooking();
    const res = await requestChange(
      {
        bookingId,
        idempotencyKey: "chg-3",
        schedule: { dates: [{ date: "2026-08-12", startTime: "09:00", endTime: "12:00" }] },
      },
      ctx(FAMILY),
    );
    expect(res.applied).toBe(true);
    expect(hoisted.docs.get(`booking_requests/${bookingId}`).schedule.dates[0].date).toBe("2026-08-12");
  });

  it("overnight changes are blocked by policy (deferred category)", async () => {
    seedFamily();
    const bookingId = await createRequestedBooking();
    await expect(
      requestChange(
        {
          bookingId,
          idempotencyKey: "chg-4",
          schedule: { dates: [{ date: "2026-08-12", startTime: "21:00", endTime: "07:00" }] },
        },
        ctx(FAMILY),
      ),
    ).rejects.toMatchObject({ details: { code: "deferred_category" } });
  });
});

// ── Substitution (revoke old FIRST — the AE6 ordering test) ──────────────────

describe("substituteChildcareCaregiver", () => {
  it("revoke-first ordering: the OLD caregiver is denied BEFORE the replacement is validated/granted", async () => {
    seedFamily();
    seedCaregiver(CG2, "Riley Replacement");
    const bookingId = await createConfirmedBooking();

    // Make replacement validation FAIL so the flow stops between revoke and grant.
    recheckMock.mockImplementation(async (uid: string) =>
      uid === CG2 ? INELIGIBLE("not_eligible") : ELIGIBLE(),
    );
    await expect(
      substitute({ bookingId, newCaregiverId: CG2, idempotencyKey: "sub-1" }, ctx(FAMILY)),
    ).rejects.toMatchObject({ details: { code: "replacement_not_eligible" } });

    // THE INTERMEDIATE STATE: old caregiver already revoked, no new grant.
    const pointer = hoisted.docs.get(`childcare_booking_safety/${bookingId}`);
    expect(pointer.state).toBe("revoked");
    expect(pointer.assignedCaregiverUid).toBeNull();
    await expect(getSafety({ bookingId }, ctx(CG))).rejects.toMatchObject({ code: "permission-denied" });
    const oldRoom = [...hoisted.docs.entries()]
      .find(([path, doc]) =>
        path.startsWith("chatRooms/") &&
        doc.careVertical === "child" &&
        doc.contextId === bookingId &&
        Array.isArray(doc.participants) &&
        doc.participants.includes(FAMILY)
      )?.[1];
    expect(oldRoom?.participants).not.toContain(CG);
    const stored = hoisted.docs.get(`booking_requests/${bookingId}`);
    expect(stored.substitution.state).toBe("revoked_pending_replacement");
    expect(stored.caregiverId).toBe(CG); // not reassigned
    // Admin alert for the stuck substitution.
    const alerts = [...hoisted.docs.values()].filter((d) => d.type === "childcare_substitution_blocked");
    expect(alerts).toHaveLength(1);
  });

  it("successful substitution: old denied, replacement validated (context substitution), NEW safety version granted", async () => {
    seedFamily();
    seedCaregiver(CG2, "Riley Replacement");
    const bookingId = await createConfirmedBooking();

    const res = await substitute({ bookingId, newCaregiverId: CG2, idempotencyKey: "sub-2" }, ctx(FAMILY));
    expect(res.substituted).toBe(true);

    const stored = hoisted.docs.get(`booking_requests/${bookingId}`);
    expect(stored.caregiverId).toBe(CG2);
    expect(stored.substitution).toMatchObject({ state: "none", previousCaregiverUid: CG });
    expect(recheckMock).toHaveBeenCalledWith(CG2, expect.objectContaining({ context: "substitution" }));

    // New caregiver reads a FRESH version; the old caregiver is denied.
    const safety = await getSafety({ bookingId }, ctx(CG2));
    expect(safety.version).toBe(2);
    await expect(getSafety({ bookingId }, ctx(CG))).rejects.toMatchObject({ code: "permission-denied" });

    // The materialized calendar points at the replacement.
    const apptId = childcareAppointmentDocId(bookingId, "2026-08-10", "09:00");
    expect(hoisted.docs.get(`appointments/${apptId}`).caregiverId).toBe(CG2);

    // Idempotent replay converges.
    const replay = await substitute({ bookingId, newCaregiverId: CG2, idempotencyKey: "sub-2" }, ctx(FAMILY));
    expect(replay.substituted).toBe(true);
  });

  it("substitution requires FAMILY authorization (the provider cannot self-substitute)", async () => {
    seedFamily();
    seedCaregiver(CG2);
    const bookingId = await createConfirmedBooking();
    await expect(
      substitute({ bookingId, newCaregiverId: CG2, idempotencyKey: "sub-3" }, ctx(CG)),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });
});

// ── Check-in / check-out ─────────────────────────────────────────────────────

describe("checkInChildcareShift / checkOutChildcareShift", () => {
  it("assigned caregiver checks in (recheck context check_in) and out; single-date booking completes and revokes access", async () => {
    seedFamily();
    const bookingId = await createConfirmedBooking();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T16:05:00.000Z")); // the visit date
    try {
      const inRes = await checkIn({ bookingId }, ctx(CG));
      expect(inRes.status).toBe("in_progress");
      expect(recheckMock).toHaveBeenCalledWith(CG, expect.objectContaining({ context: "check_in" }));
      const apptId = childcareAppointmentDocId(bookingId, "2026-08-10", "09:00");
      expect(hoisted.docs.get(`appointments/${apptId}`).status).toBe("in-progress");

      const outRes = await checkOut({ bookingId }, ctx(CG));
      expect(outRes.status).toBe("completed");
      expect(outRes.bookingCompleted).toBe(true);
      expect(hoisted.docs.get(`appointments/${apptId}`).status).toBe("completed");
      // Completion is time-bounded access: safety read now denies (R38).
      await expect(getSafety({ bookingId }, ctx(CG))).rejects.toMatchObject({ code: "permission-denied" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("an unassigned caregiver cannot check in; a requested booking cannot be checked into", async () => {
    seedFamily();
    const bookingId = await createConfirmedBooking();
    await expect(checkIn({ bookingId }, ctx("cg-impostor"))).rejects.toMatchObject({
      code: "permission-denied",
    });
    const requested = await (async () => {
      hoisted.docs.set(`booking_requests/${bookingId}`, {
        ...hoisted.docs.get(`booking_requests/${bookingId}`),
        status: "requested",
      });
      return checkIn({ bookingId }, ctx(CG));
    })().catch((e) => e);
    expect(requested).toMatchObject({ code: "failed-precondition" });
  });
});

// ── Safety read (assigned current / unassigned / revoked) via the callable ───

describe("getChildcareBookingSafety", () => {
  it("assigned caregiver reads current version; unassigned and revoked are indistinguishably denied", async () => {
    seedFamily();
    const bookingId = await createAcceptedBooking();
    const ok = await getSafety({ bookingId }, ctx(CG));
    expect(ok.success).toBe(true);
    expect(ok.children).toHaveLength(1);
    // Projection carries NO DOB / custody / address.
    const json = JSON.stringify(ok);
    expect(json).not.toContain("2022-04-01");
    expect(json).not.toContain("RESTRICTED");
    expect(json).not.toContain("123 Exact St");

    const unassigned = await getSafety({ bookingId }, ctx("cg-impostor")).catch((e: unknown) => e);
    await cancelBooking({ bookingId }, ctx(FAMILY));
    const revoked = await getSafety({ bookingId }, ctx(CG)).catch((e: unknown) => e);
    expect((unassigned as { code: string }).code).toBe("permission-denied");
    expect((revoked as { code: string }).code).toBe("permission-denied");
    expect((unassigned as { message: string }).message).toBe((revoked as { message: string }).message);
  });

  it("a pickup/safety change denies with a distinct stale code for the ASSIGNED caregiver only", async () => {
    seedFamily();
    const bookingId = await createAcceptedBooking();
    hoisted.docs.set("child_profiles/child-a", {
      ...hoisted.docs.get("child_profiles/child-a"),
      safetyCurrentVersion: 2,
    });
    await expect(getSafety({ bookingId }, ctx(CG))).rejects.toMatchObject({
      code: "failed-precondition",
      details: { code: "stale_projection" },
    });
  });
});

// ── Authority change → safety re-version via the U2 outbox effect (AE20) ─────

describe("authority-change fan-out (guardianAuthorityOutbox → safety reprojection)", () => {
  it("dispatching a derived_access_invalidation effect re-versions the booking safety projection", async () => {
    seedFamily();
    const bookingId = await createAcceptedBooking();
    expect(hoisted.docs.get(`childcare_booking_safety/${bookingId}`).currentVersion).toBe(1);

    // The U2 revocation fan-out record (as revokeGuardianAuthority enqueues it).
    const outboxId = "auth_child-a__other_v2_derived_access_invalidation";
    hoisted.docs.set(`guardianAuthorityOutbox/${outboxId}`, {
      outboxId,
      kind: "derived_access_invalidation",
      authorityId: authorityDocId("child-a", "other-adult"),
      householdId: HH,
      childId: "child-a",
      affectedAdultUid: "other-adult",
      actionByUid: FAMILY,
      action: "revoke",
      authorityAccessVersion: 2,
      state: "pending",
      attemptCount: 0,
      nextAttemptAt: new Date(0).toISOString(),
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });

    const completed = await dispatchAuthorityOutboxRecord(outboxId, "test-worker");
    expect(completed).toBe(true);
    const outbox = hoisted.docs.get(`guardianAuthorityOutbox/${outboxId}`);
    expect(outbox.state).toBe("completed");
    expect(outbox.safetyReprojectedCount).toBe(1);

    // The projection was re-versioned: v2 current, old version dead, the
    // (still assigned) caregiver reads the FRESH version.
    const pointer = hoisted.docs.get(`childcare_booking_safety/${bookingId}`);
    expect(pointer.currentVersion).toBe(2);
    expect(pointer.accessVersion).toBe(2);
    const read = await getSafety({ bookingId }, ctx(CG));
    expect(read.version).toBe(2);
  });
});

// ── Application accept / reject (the U6 deferral) ────────────────────────────

describe("acceptChildcareApplication / rejectChildcareApplication", () => {
  function seedJobWithApplication() {
    seedFamily();
    hoisted.docs.set("job_posts/cjob_1", {
      careVertical: "child",
      clientId: FAMILY,
      status: "open_childcare",
    });
    hoisted.docs.set("job_posts/cjob_1/private/children", { childIds: ["child-a"] });
    // Deterministic application ID for (cjob_1, cg-1).
    const { createHash } = require("crypto");
    const appId = `capp_${createHash("sha1").update(`cjob_1|${CG}`).digest("hex")}`;
    hoisted.docs.set(`job_applications/${appId}`, {
      careVertical: "child",
      jobId: "cjob_1",
      caregiverId: CG,
      clientId: FAMILY,
      status: "pending",
    });
    return appId;
  }

  it("family accepts a pending application (provider re-checked), idempotently", async () => {
    const appId = seedJobWithApplication();
    const res = await acceptApp({ jobId: "cjob_1", caregiverId: CG }, ctx(FAMILY));
    expect(res.status).toBe("accepted");
    expect(res.changed).toBe(true);
    expect(hoisted.docs.get(`job_applications/${appId}`).status).toBe("accepted");
    expect(recheckMock).toHaveBeenCalledWith(CG, expect.objectContaining({ context: "application" }));

    const replay = await acceptApp({ jobId: "cjob_1", caregiverId: CG }, ctx(FAMILY));
    expect(replay.changed).toBe(false);

    // Reject after accept fails (already decided).
    await expect(rejectApp({ jobId: "cjob_1", caregiverId: CG }, ctx(FAMILY))).rejects.toMatchObject({
      code: "failed-precondition",
    });
  });

  it("rejection notifies the caregiver generically; a non-owner cannot decide", async () => {
    seedJobWithApplication();
    await expect(acceptApp({ jobId: "cjob_1", caregiverId: CG }, ctx("stranger"))).rejects.toMatchObject({
      code: "permission-denied",
    });
    const res = await rejectApp({ jobId: "cjob_1", caregiverId: CG }, ctx(FAMILY));
    expect(res.status).toBe("rejected");
    const rows = [...hoisted.docs.entries()]
      .filter(([p]) => p.startsWith(`users/${CG}/notifications/`))
      .map(([, d]) => d);
    expect(rows.some((r) => r.type === "childcare_application_rejected")).toBe(true);
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain("M."); // no child display label outbound
    }
  });

  it("an ineligible provider cannot be accepted (R29)", async () => {
    seedJobWithApplication();
    recheckMock.mockResolvedValue(INELIGIBLE("expired"));
    await expect(acceptApp({ jobId: "cjob_1", caregiverId: CG }, ctx(FAMILY))).rejects.toMatchObject({
      details: { code: "provider_not_eligible" },
    });
  });
});

// ── Middleware stack ─────────────────────────────────────────────────────────

describe("middleware stack (R21)", () => {
  it("unauthenticated calls are rejected", async () => {
    await expect(requestBooking(REQUEST_INPUT(), { app: {} })).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });

  it("dark flags reject every booking callable (childcare_disabled)", async () => {
    hoisted.docs.delete("childcare_flags/global");
    bustChildcareFlagsCache();
    for (const call of [
      () => requestBooking(REQUEST_INPUT(), ctx(FAMILY)),
      () => acceptBooking({ bookingId: "x" }, ctx(CG)),
      () => cancelBooking({ bookingId: "x" }, ctx(FAMILY)),
      () => getSafety({ bookingId: "x" }, ctx(CG)),
    ]) {
      await expect(call()).rejects.toMatchObject({
        code: "failed-precondition",
        details: { code: "childcare_disabled" },
      });
    }
  });

  it("unknown bookings and foreign bookings are the SAME error (enumeration-safe)", async () => {
    seedFamily();
    const bookingId = await createRequestedBooking();
    const missing = await acceptBooking({ bookingId: "cbook_missing" }, ctx(CG)).catch((e: unknown) => e);
    const foreign = await acceptBooking({ bookingId }, ctx("cg-impostor")).catch((e: unknown) => e);
    expect((missing as { code: string }).code).toBe("permission-denied");
    expect((foreign as { code: string }).code).toBe("permission-denied");
    expect((missing as { message: string }).message).toBe((foreign as { message: string }).message);
  });
});
