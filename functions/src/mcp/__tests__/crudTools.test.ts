import { describe, it, expect, vi, beforeEach } from "vitest";

// Mirrors the in-memory Firestore harness used by journal.test.ts: docState backs
// .doc().get(), collState backs .where()...get() (where/orderBy/limit are no-ops
// that return the same ref, so the query path stays the base collection name).
const hoisted = vi.hoisted(() => {
  const docState  = new Map<string, any>();
  const collState = new Map<string, any[]>();
  const sets:    Array<{ path: string; data: any; opts?: any }> = [];
  const adds:    Array<{ path: string; data: any; id: string }> = [];
  const updates: Array<{ path: string; data: any }> = [];

  const makeDocRef = (path: string) => ({
    id: path.split("/").pop(),
    path,
    get: vi.fn(async () => ({
      exists: docState.has(path),
      data:   () => docState.get(path),
      ref:    makeDocRef(path),
    })),
    set: vi.fn(async (data: any, opts?: any) => {
      sets.push({ path, data, opts });
      docState.set(path, opts?.merge ? { ...(docState.get(path) ?? {}), ...data } : data);
    }),
    update: vi.fn(async (data: any) => {
      updates.push({ path, data });
      docState.set(path, { ...(docState.get(path) ?? {}), ...data });
    }),
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });

  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id?: string) => makeDocRef(`${path}/${id ?? `auto-${adds.length}`}`);
    ref.where   = (..._a: any[]) => ref;
    ref.orderBy = (..._a: any[]) => ref;
    ref.limit   = (..._a: any[]) => ref;
    ref.add = vi.fn(async (data: any) => {
      const id = `auto-${adds.length}`;
      adds.push({ path, data, id });
      docState.set(`${path}/${id}`, data);
      return { id };
    });
    ref.get = vi.fn(async () => {
      const items = collState.get(path) ?? [];
      return { empty: items.length === 0, size: items.length, docs: items.map((d: any, i: number) => ({ id: d.id ?? `doc-${i}`, data: () => d, ref: makeDocRef(`${path}/${d.id ?? `doc-${i}`}`) })) };
    });
    return ref;
  };

  return {
    docState, collState, sets, adds, updates,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); collState.clear(); sets.length = 0; adds.length = 0; updates.length = 0; },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: {
      arrayUnion:  (...v: any[]) => ({ __arrayUnion: v }),
      arrayRemove: (...v: any[]) => ({ __arrayRemove: v }),
      increment:   (n: number) => ({ __increment: n }),
      delete:      () => ({ __delete: true }),
    },
  }),
}));

vi.mock("../../observability/auditLog", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
  logHealthDataAccessed: vi.fn().mockResolvedValue(undefined),
  logBookingCreated:     vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../memory/memoryFiles", () => ({
  readMemoryFile:  vi.fn().mockResolvedValue(""),
  writeMemoryFile: vi.fn().mockResolvedValue(undefined),
  MemoryFile: {},
}));

vi.mock("../../memory/preferences", () => ({
  getPreferences: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../agents/matchingAgent", () => ({
  runMatchingForClient: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../utils/toolNotify", () => ({
  trySend:        vi.fn().mockResolvedValue({ sent: true }),
  trySendViaCara: vi.fn().mockResolvedValue({ sent: true }),
}));

import { handleToolCall } from "../server";

describe("missing CRUD tools", () => {
  beforeEach(() => { hoisted.reset(); });

  describe("get_support_tickets", () => {
    it("requires userId", async () => {
      const r = await handleToolCall("get_support_tickets", {}) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("INVALID_INPUT");
    });

    it("returns only open tickets by default, newest first", async () => {
      hoisted.collState.set("support_tickets", [
        { id: "old", userId: "u1", subject: "A", status: "open", resolved: false, createdAt: "2026-01-01" },
        { id: "new", userId: "u1", subject: "B", status: "open", resolved: false, createdAt: "2026-03-01" },
        { id: "done", userId: "u1", subject: "C", status: "resolved", resolved: true, createdAt: "2026-02-01" },
      ]);
      const r = await handleToolCall("get_support_tickets", { userId: "u1" }) as any;
      expect(r.success).toBe(true);
      expect(r.count).toBe(2);
      expect(r.tickets.map((t: any) => t.id)).toEqual(["new", "old"]);
    });

    it("includes resolved tickets when includeResolved is set", async () => {
      hoisted.collState.set("support_tickets", [
        { id: "open1", userId: "u1", status: "open", resolved: false, createdAt: "2026-01-01" },
        { id: "done1", userId: "u1", status: "resolved", resolved: true, createdAt: "2026-02-01" },
      ]);
      const r = await handleToolCall("get_support_tickets", { userId: "u1", includeResolved: true }) as any;
      expect(r.count).toBe(2);
    });
  });

  describe("get_refund_requests", () => {
    it("requires clientId", async () => {
      const r = await handleToolCall("get_refund_requests", {}) as any;
      expect(r._toolError).toBe(true);
    });

    it("returns requests newest first", async () => {
      hoisted.collState.set("refundRequests", [
        { id: "r1", clientId: "c1", status: "pending_review", requestedAt: "2026-01-01" },
        { id: "r2", clientId: "c1", status: "approved", requestedAt: "2026-04-01" },
      ]);
      const r = await handleToolCall("get_refund_requests", { clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.requests.map((x: any) => x.id)).toEqual(["r2", "r1"]);
    });
  });

  describe("get_shifts", () => {
    it("requires caregiverId or clientId", async () => {
      const r = await handleToolCall("get_shifts", {}) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("INVALID_INPUT");
    });

    // 2026-08-31 (Payments/Timesheets audit): fixtures now use the REAL
    // shiftHours fields (submittedStartTime/EndTime/TotalHours) instead of
    // date/durationHours/clockInTime/clockOutTime — those never actually
    // exist on a real doc (createValidatedShiftHours.ts writes only
    // submitted*/final*), so this test used to pass while masking the exact
    // bug found live: every real record came back with a null date/hours.
    it("returns mapped shifts with dollar formatting, newest first", async () => {
      hoisted.collState.set("shiftHours", [
        { id: "a1", caregiverId: "cg1", status: "paid", submittedStartTime: "2026-02-01T09:00:00.000Z", submittedEndTime: "2026-02-01T13:00:00.000Z", submittedTotalHours: 4, amountCents: 8800 },
        { id: "a2", caregiverId: "cg1", status: "pending_client_review", submittedStartTime: "2026-05-01T09:00:00.000Z", submittedEndTime: "2026-05-01T11:00:00.000Z", submittedTotalHours: 2, amountCents: 4400 },
      ]);
      const r = await handleToolCall("get_shifts", { caregiverId: "cg1" }) as any;
      expect(r.success).toBe(true);
      expect(r.shifts.map((s: any) => s.appointmentId)).toEqual(["a2", "a1"]);
      const a1 = r.shifts.find((s: any) => s.appointmentId === "a1");
      expect(a1.amountDollars).toBe("$88.00");
      expect(a1.date).toBe("2026-02-01");
      expect(a1.clockInTime).toBe("2026-02-01T09:00:00.000Z");
      expect(a1.clockOutTime).toBe("2026-02-01T13:00:00.000Z");
      expect(a1.durationHours).toBe(4);
    });

    it("filters by status when provided", async () => {
      hoisted.collState.set("shiftHours", [
        { id: "a1", caregiverId: "cg1", status: "paid", submittedStartTime: "2026-02-01T09:00:00.000Z", amountCents: 100 },
        { id: "a2", caregiverId: "cg1", status: "pending_client_review", submittedStartTime: "2026-05-01T09:00:00.000Z", amountCents: 100 },
      ]);
      const r = await handleToolCall("get_shifts", { caregiverId: "cg1", status: "pending_client_review" }) as any;
      expect(r.count).toBe(1);
      expect(r.shifts[0].appointmentId).toBe("a2");
    });
  });

  describe("get_pending_booking_requests", () => {
    it("requires clientId or caregiverId", async () => {
      const r = await handleToolCall("get_pending_booking_requests", {}) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("INVALID_INPUT");
    });

    it("returns pending requests for a client, newest first", async () => {
      hoisted.collState.set("booking_requests", [
        {
          id: "br1", clientId: "c1", caregiverId: "cg1", caregiverName: "Alice", clientName: "The Doe Family",
          rate: 25, status: "pending", createdAt: "2026-09-01T09:00:00.000Z",
          schedule: { days: ["Mon"], ongoing: true },
        },
        {
          id: "br2", clientId: "c1", caregiverId: "cg2", caregiverName: "Bob", status: "pending",
          createdAt: "2026-09-10T09:00:00.000Z", isShiftReplacement: true, replacementForShiftId: "s1",
        },
      ]);
      const r = await handleToolCall("get_pending_booking_requests", { clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.count).toBe(2);
      expect(r.requests.map((x: any) => x.bookingRequestId)).toEqual(["br2", "br1"]);
      expect(r.requests[0].caregiverName).toBe("Bob");
      expect(r.requests[0].isShiftReplacement).toBe(true);
      expect(r.requests[1].hourlyRate).toBe(25);
    });

    it("returns pending requests for a caregiver", async () => {
      hoisted.collState.set("booking_requests", [
        { id: "br3", clientId: "c9", caregiverId: "cg1", clientName: "Rivera Family", status: "pending", createdAt: "2026-09-05T09:00:00.000Z" },
      ]);
      const r = await handleToolCall("get_pending_booking_requests", { caregiverId: "cg1" }) as any;
      expect(r.success).toBe(true);
      expect(r.count).toBe(1);
      expect(r.requests[0].clientName).toBe("Rivera Family");
    });
  });

  // Requests tab, second card type (2026-09-16).
  describe("get_pending_schedule_amendments", () => {
    it("requires clientId or caregiverId", async () => {
      const r = await handleToolCall("get_pending_schedule_amendments", {}) as any;
      expect(r._toolError).toBe(true);
    });

    it("returns a family's pending schedule changes with the site's fields, newest first", async () => {
      hoisted.collState.set("booking_amendments", [
        { id: "am1", clientId: "c1", caregiverName: "Basra Yousuf", bookingRequestId: "br1", status: "pending", type: "add_recurring_days",
          newDays: { Thu: [{ start: "10:00", end: "15:00" }] }, startDate: "2026-09-17", endDate: "2026-09-17", ongoing: false, notes: "one time", createdAt: "2026-09-15T09:00:00.000Z" },
        { id: "am2", clientId: "c1", caregiverName: "Basra Yousuf", bookingRequestId: "br1", status: "pending", type: "add_recurring_days",
          newDays: { Fri: [{ start: "09:00", end: "11:00" }] }, startDate: "2026-09-18", endDate: null, ongoing: true, notes: "", createdAt: "2026-09-16T09:00:00.000Z" },
      ]);
      const r = await handleToolCall("get_pending_schedule_amendments", { clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.count).toBe(2);
      expect(r.amendments.map((a: any) => a.amendmentId)).toEqual(["am2", "am1"]);
      expect(r.amendments[1]).toMatchObject({ startDate: "2026-09-17", startDayOfWeek: "Thursday", ongoing: false, days: [{ day: "Thu", times: ["10:00–15:00"] }] });
    });
  });

  // Past Bookings tab (2026-09-16).
  // My Calendar page (2026-09-16): visits in a date range with the site's
  // display status (overdue = scheduled, time passed) plus interviews.
  describe("get_calendar", () => {
    it("returns visits with display status and interviews inside the range, and defaults the range to a week", async () => {
      hoisted.collState.set("shifts", [
        { id: "s1", clientId: "c1", caregiverName: "Basra Yousuf", status: "scheduled", date: "2000-01-03", startTime: "11:00", endTime: "13:00" },
        { id: "s2", clientId: "c1", caregiverName: "Basra Yousuf", status: "scheduled", date: "2099-01-05", startTime: "11:00", endTime: "13:00" },
        { id: "s3", clientId: "c1", caregiverName: "Basra Yousuf", status: "cancelled", date: "2099-01-06", startTime: "11:00", endTime: "13:00", cancelledBy: "client" },
      ]);
      hoisted.collState.set("video_interviews", [
        { id: "iv1", clientId: "c1", caregiverName: "Basra Yousuf", status: "accepted", scheduledTime: "2099-01-04T17:00:00.000Z" },
        { id: "iv2", clientId: "c1", caregiverName: "Basra Yousuf", status: "cancelled", scheduledTime: "2099-01-04T18:00:00.000Z" },
        { id: "iv3", clientId: "c1", caregiverName: "Basra Yousuf", status: "accepted", scheduledTime: "2099-03-04T17:00:00.000Z" },
      ]);
      const r = await handleToolCall("get_calendar", { clientId: "c1", fromDate: "2099-01-03", toDate: "2099-01-09" }) as any;
      expect(r.success).toBe(true);
      expect(r.fromDate).toBe("2099-01-03");
      expect(r.toDate).toBe("2099-01-09");
      // The where() mock is a no-op, so all seeded shifts come back — the
      // display-status mapping is what's under test here.
      const byId = Object.fromEntries(r.visits.map((v: any) => [v.id, v]));
      expect(byId.s1.displayStatus).toBe("overdue");
      expect(byId.s2.displayStatus).toBe("scheduled");
      expect(byId.s2.dayOfWeek).toBe("Monday");
      expect(byId.s3.displayStatus).toBe("cancelled");
      expect(r.interviews.map((i: any) => i.id)).toEqual(["iv1"]);
      expect(r.interviews[0].date).toBe("2099-01-04");

      const d = await handleToolCall("get_calendar", { clientId: "c1" }) as any;
      const from = new Date(`${d.fromDate}T12:00:00Z`), to = new Date(`${d.toDate}T12:00:00Z`);
      expect(Math.round((to.getTime() - from.getTime()) / 86400000)).toBe(6);
    });

    it("refuses a backwards range", async () => {
      const r = await handleToolCall("get_calendar", { clientId: "c1", fromDate: "2099-01-09", toDate: "2099-01-03" }) as any;
      expect(r._toolError).toBe(true);
    });
  });

  describe("get_past_visits", () => {
    it("requires clientId or caregiverId", async () => {
      const r = await handleToolCall("get_past_visits", {}) as any;
      expect(r._toolError).toBe(true);
    });

    it("returns only completed/cancelled visits, newest first, with weekday and who cancelled", async () => {
      hoisted.collState.set("shifts", [
        { id: "s1", clientId: "c1", caregiverName: "Basra Yousuf", status: "completed", date: "2026-09-09", startTime: "11:00", endTime: "13:00", startedAt: "2026-09-09T18:02:00.000Z", completedAt: "2026-09-09T20:00:00.000Z", paid: true },
        { id: "s2", clientId: "c1", caregiverName: "Basra Yousuf", status: "cancelled", date: "2026-09-15", startTime: "11:00", endTime: "13:00", cancelledBy: "client" },
        { id: "s3", clientId: "c1", caregiverName: "Basra Yousuf", status: "scheduled", date: "2026-09-16", startTime: "11:00", endTime: "13:00" },
      ]);
      const r = await handleToolCall("get_past_visits", { clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.visits.map((v: any) => v.id)).toEqual(["s2", "s1"]);
      expect(r.visits[0]).toMatchObject({ status: "cancelled", cancelledBy: "client", dayOfWeek: "Tuesday" });
      expect(r.visits[1]).toMatchObject({ status: "completed", paid: true, dayOfWeek: "Wednesday" });
    });
  });

  describe("get_caregiver_availability", () => {
    it("requires caregiverId", async () => {
      const r = await handleToolCall("get_caregiver_availability", {}) as any;
      expect(r._toolError).toBe(true);
    });

    it("returns NOT_FOUND for missing caregiver", async () => {
      const r = await handleToolCall("get_caregiver_availability", { caregiverId: "ghost" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("NOT_FOUND");
    });

    it("returns availability, weekly map, and preferred time", async () => {
      hoisted.docState.set("caregivers/cg1", {
        availability: ["monday", "tuesday"],
        weeklyAvailability: { monday: [{ start: "08:00", end: "12:00" }] },
        preferredTimeOfDay: "morning",
      });
      const r = await handleToolCall("get_caregiver_availability", { caregiverId: "cg1" }) as any;
      expect(r.success).toBe(true);
      expect(r.availability).toEqual(["monday", "tuesday"]);
      expect(r.weeklyAvailability.monday).toHaveLength(1);
      expect(r.preferredTimeOfDay).toBe("morning");
    });

    it("defaults missing fields to empty values", async () => {
      hoisted.docState.set("caregivers/cg2", { name: "Maria" });
      const r = await handleToolCall("get_caregiver_availability", { caregiverId: "cg2" }) as any;
      expect(r.availability).toEqual([]);
      expect(r.weeklyAvailability).toEqual({});
      expect(r.preferredTimeOfDay).toBeNull();
    });
  });

  describe("update_care_journal_entry", () => {
    it("requires caregiverId and entryId", async () => {
      const r = await handleToolCall("update_care_journal_entry", { caregiverId: "cg1" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("returns NOT_FOUND for a missing entry", async () => {
      const r = await handleToolCall("update_care_journal_entry", { caregiverId: "cg1", entryId: "ghost", notes: "x" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("NOT_FOUND");
    });

    it("rejects edits from a caregiver who did not author the entry", async () => {
      hoisted.docState.set("care_journal/e1", { caregiverId: "other", notes: "..." });
      const r = await handleToolCall("update_care_journal_entry", { caregiverId: "cg1", entryId: "e1", notes: "x" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("PERMISSION_DENIED");
    });

    it("requires at least one field beyond identifiers", async () => {
      hoisted.docState.set("care_journal/e1", { caregiverId: "cg1", notes: "..." });
      const r = await handleToolCall("update_care_journal_entry", { caregiverId: "cg1", entryId: "e1" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("INVALID_INPUT");
    });

    it("updates provided fields and stamps updatedAt", async () => {
      hoisted.docState.set("care_journal/e1", { caregiverId: "cg1", notes: "old" });
      const r = await handleToolCall("update_care_journal_entry", { caregiverId: "cg1", entryId: "e1", notes: "corrected", mood: "calm" }) as any;
      expect(r.success).toBe(true);
      const upd = hoisted.updates.find(u => u.path === "care_journal/e1");
      expect(upd?.data.notes).toBe("corrected");
      expect(upd?.data.mood).toBe("calm");
      expect(upd?.data.updatedAt).toBeDefined();
    });
  });
});

// Fix 3 (loop-only): the model saves jobType in whatever casing it extracted
// ("Full time", "FT", "part-time"); the caregiver doc + matching expect the
// canonical occasional|part_time|full_time enum. save_onboarding_field must
// canonicalize AT the persist site — this exercises the real wiring end-to-end
// (not just the pure normalizeOnboardingFieldValue unit), so a future edit that
// drops the normalize call (persists raw fieldValue) is caught.
describe("save_onboarding_field jobType canonicalization (Fix 3)", () => {
  const PHONE = "+15555550001";
  beforeEach(() => { hoisted.reset(); });

  const persistedJobType = () =>
    hoisted.docState.get(`agent_sessions/${PHONE}`)?.onboardingData?.jobType;

  it.each([
    ["Full time", "full_time"],
    ["FT", "full_time"],
    ["part-time", "part_time"],
    ["Occasionally", "occasional"],
  ])("normalizes %o to %o at the save site", async (raw, canonical) => {
    const r = await handleToolCall("save_onboarding_field", {
      phone: PHONE, role: "caregiver", fieldName: "jobType", fieldValue: raw,
    }) as any;
    expect(r.saved).toBe(true);
    expect(persistedJobType()).toBe(canonical);
  });

  it("passes an unknown jobType through unchanged (never silently dropped)", async () => {
    const r = await handleToolCall("save_onboarding_field", {
      phone: PHONE, role: "caregiver", fieldName: "jobType", fieldValue: "seasonal-ish",
    }) as any;
    expect(r.saved).toBe(true);
    expect(persistedJobType()).toBe("seasonal-ish");
  });
});

// Zip → city/state auto-derivation (2026-08-22): a client's zipCode save must
// deterministically derive city/state via the same zippopotam.us lookup the
// website wizard uses — never left to the model to extract/guess a city from
// free text (the live bug this closes: "Campbell Ave" mistaken for the city
// "Campbell").
vi.mock("../../utils/geocode", () => ({
  lookupZipPlace: vi.fn(async (zip: string) =>
    zip === "95008" ? { lat: 37.28, lng: -121.95, city: "Campbell", state: "CA" } : null),
}));

describe("save_onboarding_field zip → city/state auto-derivation", () => {
  const PHONE = "+15555550002";
  beforeEach(() => { hoisted.reset(); });

  const onboardingData = () =>
    hoisted.docState.get(`agent_sessions/${PHONE}`)?.onboardingData ?? {};

  it("derives city/state from a valid zip for the care address", async () => {
    const r = await handleToolCall("save_onboarding_field", {
      phone: PHONE, role: "client", fieldName: "zipCode", fieldValue: "95008",
    }) as any;
    expect(r.saved).toBe(true);
    expect(onboardingData().zipCode).toBe("95008");
    expect(onboardingData().city).toBe("Campbell");
    expect(onboardingData().state).toBe("CA");
  });

  it("derives homeCity/homeState from homeZipCode", async () => {
    const r = await handleToolCall("save_onboarding_field", {
      phone: PHONE, role: "client", fieldName: "homeZipCode", fieldValue: "95008",
    }) as any;
    expect(r.saved).toBe(true);
    expect(onboardingData().homeZipCode).toBe("95008");
    expect(onboardingData().homeCity).toBe("Campbell");
    expect(onboardingData().homeState).toBe("CA");
  });

  it("saves the zip even when the lookup can't resolve a place (fail-soft)", async () => {
    // homeZipCode (not zipCode) to avoid the unrelated service-area gate, which
    // fires only on city/zipCode and would reject an unrecognized zip on its
    // own terms — this test is purely about the geocode-lookup fail-soft path.
    const r = await handleToolCall("save_onboarding_field", {
      phone: PHONE, role: "client", fieldName: "homeZipCode", fieldValue: "00000",
    }) as any;
    expect(r.saved).toBe(true);
    expect(onboardingData().homeZipCode).toBe("00000");
    expect(onboardingData().homeCity).toBeUndefined();
  });
});
