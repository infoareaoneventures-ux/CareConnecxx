import { describe, it, expect, vi, beforeEach } from "vitest";

// Booking-pipeline parity (2026-08-30): the website's My Bookings / Calendar
// pages let a family cancel a pending request, cancel a whole booking, cancel
// a single visit, resend a declined/cancelled request, and request/accept a
// schedule amendment — none of which Evia could do before. These tests lock
// in the new manage_booking / request_schedule_amendment /
// respond_to_schedule_amendment tools against the exact site write shapes.

const hoisted = vi.hoisted(() => {
  const docState  = new Map<string, any>();
  const collState = new Map<string, any[]>();
  const sets:    Array<{ path: string; data: any }> = [];
  const updates: Array<{ path: string; data: any }> = [];

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path), ref: makeDocRef(path) })),
    set: vi.fn(async (data: any) => { sets.push({ path, data }); docState.set(path, data); }),
    update: vi.fn(async (data: any) => {
      updates.push({ path, data });
      docState.set(path, { ...(docState.get(path) ?? {}), ...data });
    }),
  });

  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id?: string) => makeDocRef(`${path}/${id ?? `auto-${sets.length}`}`);
    ref.where   = (..._a: any[]) => ref;
    ref.limit   = (..._a: any[]) => ref;
    ref.orderBy = (..._a: any[]) => ref;
    ref.get = vi.fn(async () => {
      const items = collState.get(path) ?? [];
      return {
        empty: items.length === 0,
        size:  items.length,
        docs:  items.map((d: any) => ({ id: d.id, data: () => d, ref: makeDocRef(`${path}/${d.id}`) })),
      };
    });
    return ref;
  };

  return {
    docState, collState, sets, updates,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); collState.clear(); sets.length = 0; updates.length = 0; },
  };
});

vi.mock("firebase-admin", () => {
  const makeBatch = () => ({
    update: (ref: any, data: any) => {
      hoisted.updates.push({ path: ref.path, data });
      hoisted.docState.set(ref.path, { ...(hoisted.docState.get(ref.path) ?? {}), ...data });
    },
    set: (ref: any, data: any) => { hoisted.sets.push({ path: ref.path, data }); hoisted.docState.set(ref.path, data); },
    commit: vi.fn(async () => undefined),
  });
  const firestoreFn = () => ({ collection: hoisted.collectionMock, batch: makeBatch });
  return {
    __esModule: true,
    default: { firestore: firestoreFn },
    firestore: Object.assign(firestoreFn, {
      FieldValue: {
        delete: () => ({ __delete: true }),
        arrayUnion: (...v: any[]) => ({ __arrayUnion: v }),
        serverTimestamp: () => ({ __serverTimestamp: true }),
      },
    }),
  };
});

vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../memory/memoryFiles", () => ({ readMemoryFile: vi.fn().mockResolvedValue(""), writeMemoryFile: vi.fn().mockResolvedValue(undefined), MemoryFile: {} }));
vi.mock("../../memory/preferences", () => ({ getPreferences: vi.fn().mockResolvedValue(null) }));
vi.mock("../../agents/caregiverSearch", () => ({
  presentCaregiverSearch: vi.fn(async () => ({ status: "shown", total: 0, shown: [], offset: 0, hasMore: false })),
  searchCaregivers: vi.fn(async () => ({ total: 0, caregivers: [], hasLocation: false, filters: {} })),
}));
vi.mock("../../linq/client", () => ({ sendToPhone: vi.fn().mockResolvedValue("sent") }));

import { handleToolCall } from "../server";

const CLIENT = "client_1";
const CAREGIVER = "cg_1";

describe("manage_booking", () => {
  beforeEach(() => hoisted.reset());

  it("cancel_pending_request = the Requests tab's Cancel: the booking_requests doc alone goes to cancelled (no Evia-side queue to retire)", async () => {
    hoisted.docState.set("booking_requests/br1", { clientId: CLIENT, status: "pending", agentTaskId: "task1" });
    hoisted.docState.set("agent_tasks/task1", { status: "awaiting_caregiver" });

    const r = await handleToolCall("manage_booking", { clientId: CLIENT, action: "cancel_pending_request", bookingRequestId: "br1" }) as any;
    expect(r.success).toBe(true);
    expect(hoisted.updates.find(u => u.path === "booking_requests/br1")?.data.status).toBe("cancelled");
    expect(hoisted.updates.find(u => u.path === "agent_tasks/task1")).toBeUndefined();
  });

  it("cancel_pending_request refuses a booking that already has a caregiver's YES", async () => {
    hoisted.docState.set("booking_requests/br1", { clientId: CLIENT, status: "accepted" });
    const r = await handleToolCall("manage_booking", { clientId: CLIENT, action: "cancel_pending_request", bookingRequestId: "br1" }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("cancel_whole_booking bulk-cancels every scheduled shift and the booking_requests doc", async () => {
    hoisted.docState.set("booking_requests/br1", { clientId: CLIENT, status: "accepted", caregiverId: CAREGIVER });
    hoisted.collState.set("shifts", [
      { id: "s1", bookingRequestId: "br1", status: "scheduled" },
      { id: "s2", bookingRequestId: "br1", status: "scheduled" },
    ]);
    hoisted.docState.set(`caregivers/${CAREGIVER}`, { phone: "+15551234567" });

    const r = await handleToolCall("manage_booking", { clientId: CLIENT, action: "cancel_whole_booking", bookingRequestId: "br1" }) as any;
    expect(r.success).toBe(true);
    expect(r.shiftsCancelled).toBe(2);
    expect(hoisted.updates.find(u => u.path === "shifts/s1")?.data).toMatchObject({ status: "cancelled", bulkCancelled: true });
    expect(hoisted.updates.find(u => u.path === "shifts/s2")?.data).toMatchObject({ status: "cancelled", bulkCancelled: true });
    expect(hoisted.updates.find(u => u.path === "booking_requests/br1")?.data.status).toBe("cancelled");
  });

  // 2026-09-14 (live-caught, site-side): matches the same fix applied to
  // ClientVisitsPage.tsx's handleCancelBooking — a shift already stuck in
  // 'needs_replacement' must also get cancelled by a whole-booking cancel,
  // or it never disappears from Active Bookings.
  it("cancel_whole_booking also cancels a needs_replacement shift under the same booking", async () => {
    hoisted.docState.set("booking_requests/br1", { clientId: CLIENT, status: "accepted", caregiverId: CAREGIVER });
    hoisted.collState.set("shifts", [
      { id: "s1", bookingRequestId: "br1", status: "scheduled" },
      { id: "s2", bookingRequestId: "br1", status: "needs_replacement" },
    ]);
    const r = await handleToolCall("manage_booking", { clientId: CLIENT, action: "cancel_whole_booking", bookingRequestId: "br1" }) as any;
    expect(r.success).toBe(true);
    expect(r.shiftsCancelled).toBe(2);
    expect(hoisted.updates.find(u => u.path === "shifts/s2")?.data).toMatchObject({ status: "cancelled", bulkCancelled: true });
  });

  it("cancel_whole_booking rejects a booking belonging to a different client", async () => {
    hoisted.docState.set("booking_requests/br1", { clientId: "other_client", status: "accepted" });
    const r = await handleToolCall("manage_booking", { clientId: CLIENT, action: "cancel_whole_booking", bookingRequestId: "br1" }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("PERMISSION_DENIED");
  });

  it("cancel_visit cancels a single shift and leaves siblings untouched", async () => {
    hoisted.docState.set("shifts/s1", { clientId: CLIENT, caregiverId: CAREGIVER, status: "scheduled", date: "2026-09-01" });
    const r = await handleToolCall("manage_booking", { clientId: CLIENT, action: "cancel_visit", shiftId: "s1" }) as any;
    expect(r.success).toBe(true);
    expect(hoisted.updates.find(u => u.path === "shifts/s1")?.data).toMatchObject({ status: "cancelled", cancelledBy: "client" });
  });

  it("cancel_visit refuses a visit that isn't scheduled anymore", async () => {
    hoisted.docState.set("shifts/s1", { clientId: CLIENT, status: "completed" });
    const r = await handleToolCall("manage_booking", { clientId: CLIENT, action: "cancel_visit", shiftId: "s1" }) as any;
    expect(r._toolError).toBe(true);
  });

  // 2026-09-14 (Hamse's call): matches the website's own Skip button on a
  // "Needs Replacement" visit — the family deciding they don't need a
  // replacement after all uses the same cancel-in-place write.
  it("cancel_visit also cancels a visit stuck in needs_replacement (Skip)", async () => {
    hoisted.docState.set("shifts/s1", { clientId: CLIENT, status: "needs_replacement" });
    const r = await handleToolCall("manage_booking", { clientId: CLIENT, action: "cancel_visit", shiftId: "s1" }) as any;
    expect(r.success).toBe(true);
    expect(hoisted.updates.find(u => u.path === "shifts/s1")?.data).toMatchObject({ status: "cancelled", cancelledBy: "client" });
  });

  it("cancel_pending_amendment cancels a pending booking_amendments doc", async () => {
    hoisted.docState.set("booking_amendments/am1", { clientId: CLIENT, status: "pending" });
    const r = await handleToolCall("manage_booking", { clientId: CLIENT, action: "cancel_pending_amendment", amendmentId: "am1" }) as any;
    expect(r.success).toBe(true);
    expect(hoisted.updates.find(u => u.path === "booking_amendments/am1")?.data.status).toBe("cancelled");
  });

  it("rejects an unknown action", async () => {
    const r = await handleToolCall("manage_booking", { clientId: CLIENT, action: "not_a_real_action" }) as any;
    expect(r._toolError).toBe(true);
  });

  // 2026-09-14 (Hamse's call): matches the website's own handleWithdrawReplacement.
  it("withdraw_replacement_request cancels the replacement booking_requests doc", async () => {
    hoisted.docState.set("booking_requests/br2", { clientId: CLIENT, status: "pending", isShiftReplacement: true, replacementForShiftId: "s1" });
    const r = await handleToolCall("manage_booking", { clientId: CLIENT, action: "withdraw_replacement_request", bookingRequestId: "br2" }) as any;
    expect(r.success).toBe(true);
    expect(hoisted.updates.find(u => u.path === "booking_requests/br2")?.data.status).toBe("cancelled");
  });

  it("withdraw_replacement_request refuses a booking that isn't a replacement request", async () => {
    hoisted.docState.set("booking_requests/br1", { clientId: CLIENT, status: "pending" });
    const r = await handleToolCall("manage_booking", { clientId: CLIENT, action: "withdraw_replacement_request", bookingRequestId: "br1" }) as any;
    expect(r._toolError).toBe(true);
  });

  it("withdraw_replacement_request rejects a request belonging to a different client", async () => {
    hoisted.docState.set("booking_requests/br2", { clientId: "other_client", isShiftReplacement: true });
    const r = await handleToolCall("manage_booking", { clientId: CLIENT, action: "withdraw_replacement_request", bookingRequestId: "br2" }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("PERMISSION_DENIED");
  });
});

// 2026-09-14 (Hamse's call): matches the website's own in-place reschedule —
// ClientVisitsPage.tsx's handleProposeReschedule/handleAcceptReschedule/
// handleClearReschedule — a proposal lives in reschedulePendingDate/
// StartTime/EndTime + rescheduledBy on the SAME shift doc; the real date/
// startTime/endTime never move until the other party accepts.
describe("manage_booking — propose/accept/clear_reschedule", () => {
  beforeEach(() => hoisted.reset());

  it("propose_reschedule stores a pending proposal without touching the real date/time", async () => {
    hoisted.docState.set("shifts/s1", { clientId: CLIENT, status: "scheduled", date: "2099-09-01", startTime: "09:00", endTime: "12:00" });
    const r = await handleToolCall("manage_booking", {
      clientId: CLIENT, action: "propose_reschedule", shiftId: "s1", date: "2099-09-08", startTime: "10:00", endTime: "13:00",
    }) as any;
    expect(r.success).toBe(true);
    const update = hoisted.updates.find(u => u.path === "shifts/s1")?.data;
    expect(update).toMatchObject({
      reschedulePendingDate: "2099-09-08", reschedulePendingStartTime: "10:00", reschedulePendingEndTime: "13:00",
      rescheduledBy: "client",
    });
    // Real date/time untouched by this write.
    expect(update.date).toBeUndefined();
    expect(update.startTime).toBeUndefined();
  });

  it("cancel_visit clears any pending reschedule proposal, exactly like the site's handleCancelShift (2026-09-16)", async () => {
    hoisted.docState.set("shifts/s1", {
      clientId: CLIENT, status: "scheduled", date: "2099-09-01", startTime: "09:00", endTime: "12:00",
      reschedulePendingDate: "2099-09-08", reschedulePendingStartTime: "10:00", reschedulePendingEndTime: "13:00", rescheduledBy: "caregiver",
    });
    const r = await handleToolCall("manage_booking", { clientId: CLIENT, action: "cancel_visit", shiftId: "s1" }) as any;
    expect(r.success).toBe(true);
    const update = hoisted.updates.find(u => u.path === "shifts/s1")?.data;
    expect(update).toMatchObject({ status: "cancelled", cancelledBy: "client" });
    for (const k of ["reschedulePendingDate", "reschedulePendingStartTime", "reschedulePendingEndTime", "rescheduledBy"]) {
      expect(update[k]).toEqual({ __delete: true });
    }
    // handleCancelShift writes no updatedAt (only Skip does) — same fields, nothing extra.
    expect(update.updatedAt).toBeUndefined();
  });

  it("propose_reschedule rejects endTime before startTime", async () => {
    hoisted.docState.set("shifts/s1", { clientId: CLIENT, status: "scheduled" });
    const r = await handleToolCall("manage_booking", {
      clientId: CLIENT, action: "propose_reschedule", shiftId: "s1", date: "2026-09-08", startTime: "13:00", endTime: "10:00",
    }) as any;
    expect(r._toolError).toBe(true);
  });

  it("accept_reschedule moves the real date/time and clears the pending fields", async () => {
    hoisted.docState.set("shifts/s1", {
      clientId: CLIENT, status: "scheduled", date: "2026-09-01", startTime: "09:00", endTime: "12:00",
      reschedulePendingDate: "2026-09-08", reschedulePendingStartTime: "10:00", reschedulePendingEndTime: "13:00",
      rescheduledBy: "caregiver",
    });
    const r = await handleToolCall("manage_booking", { clientId: CLIENT, action: "accept_reschedule", shiftId: "s1" }) as any;
    expect(r.success).toBe(true);
    const update = hoisted.updates.find(u => u.path === "shifts/s1")?.data;
    expect(update).toMatchObject({ date: "2026-09-08", startTime: "10:00", endTime: "13:00" });
    expect(update.reschedulePendingDate).toEqual({ __delete: true });
    expect(update.rescheduledBy).toEqual({ __delete: true });
  });

  it("accept_reschedule refuses to accept your own proposal", async () => {
    hoisted.docState.set("shifts/s1", {
      clientId: CLIENT, status: "scheduled",
      reschedulePendingDate: "2026-09-08", reschedulePendingStartTime: "10:00", reschedulePendingEndTime: "13:00",
      rescheduledBy: "client",
    });
    const r = await handleToolCall("manage_booking", { clientId: CLIENT, action: "accept_reschedule", shiftId: "s1" }) as any;
    expect(r._toolError).toBe(true);
  });

  it("accept_reschedule refuses when there's no pending proposal", async () => {
    hoisted.docState.set("shifts/s1", { clientId: CLIENT, status: "scheduled" });
    const r = await handleToolCall("manage_booking", { clientId: CLIENT, action: "accept_reschedule", shiftId: "s1" }) as any;
    expect(r._toolError).toBe(true);
  });

  it("clear_reschedule clears the pending proposal and leaves the real date/time untouched", async () => {
    hoisted.docState.set("shifts/s1", {
      clientId: CLIENT, status: "scheduled", date: "2026-09-01", startTime: "09:00", endTime: "12:00",
      reschedulePendingDate: "2026-09-08", reschedulePendingStartTime: "10:00", reschedulePendingEndTime: "13:00",
      rescheduledBy: "caregiver",
    });
    const r = await handleToolCall("manage_booking", { clientId: CLIENT, action: "clear_reschedule", shiftId: "s1" }) as any;
    expect(r.success).toBe(true);
    const update = hoisted.updates.find(u => u.path === "shifts/s1")?.data;
    expect(update.reschedulePendingDate).toEqual({ __delete: true });
    expect(update.date).toBeUndefined();
  });
});

describe("manage_shift_reschedule (caregiver side)", () => {
  beforeEach(() => hoisted.reset());

  it("propose stores a pending proposal scoped to this caregiver's shift", async () => {
    hoisted.docState.set("shifts/s1", { caregiverId: CAREGIVER, status: "scheduled", date: "2026-09-01", startTime: "09:00", endTime: "12:00" });
    const r = await handleToolCall("manage_shift_reschedule", {
      caregiverId: CAREGIVER, shiftId: "s1", action: "propose", date: "2026-09-08", startTime: "10:00", endTime: "13:00",
    }) as any;
    expect(r.success).toBe(true);
    expect(hoisted.updates.find(u => u.path === "shifts/s1")?.data).toMatchObject({
      reschedulePendingDate: "2026-09-08", rescheduledBy: "caregiver",
    });
  });

  it("rejects a shift belonging to a different caregiver", async () => {
    hoisted.docState.set("shifts/s1", { caregiverId: "other_cg", status: "scheduled" });
    const r = await handleToolCall("manage_shift_reschedule", {
      caregiverId: CAREGIVER, shiftId: "s1", action: "propose", date: "2026-09-08", startTime: "10:00", endTime: "13:00",
    }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("PERMISSION_DENIED");
  });

  it("accept moves the real date/time when the FAMILY proposed it", async () => {
    hoisted.docState.set("shifts/s1", {
      caregiverId: CAREGIVER, status: "scheduled", date: "2026-09-01", startTime: "09:00", endTime: "12:00",
      reschedulePendingDate: "2026-09-08", reschedulePendingStartTime: "10:00", reschedulePendingEndTime: "13:00",
      rescheduledBy: "client",
    });
    const r = await handleToolCall("manage_shift_reschedule", { caregiverId: CAREGIVER, shiftId: "s1", action: "accept" }) as any;
    expect(r.success).toBe(true);
    expect(hoisted.updates.find(u => u.path === "shifts/s1")?.data).toMatchObject({ date: "2026-09-08", startTime: "10:00", endTime: "13:00" });
  });

  it("refuses to accept your own proposal", async () => {
    hoisted.docState.set("shifts/s1", {
      caregiverId: CAREGIVER, status: "scheduled",
      reschedulePendingDate: "2026-09-08", reschedulePendingStartTime: "10:00", reschedulePendingEndTime: "13:00",
      rescheduledBy: "caregiver",
    });
    const r = await handleToolCall("manage_shift_reschedule", { caregiverId: CAREGIVER, shiftId: "s1", action: "accept" }) as any;
    expect(r._toolError).toBe(true);
  });

  it("decline clears a pending proposal without moving the real date/time", async () => {
    hoisted.docState.set("shifts/s1", {
      caregiverId: CAREGIVER, status: "scheduled", date: "2026-09-01", startTime: "09:00", endTime: "12:00",
      reschedulePendingDate: "2026-09-08", reschedulePendingStartTime: "10:00", reschedulePendingEndTime: "13:00",
      rescheduledBy: "client",
    });
    const r = await handleToolCall("manage_shift_reschedule", { caregiverId: CAREGIVER, shiftId: "s1", action: "decline" }) as any;
    expect(r.success).toBe(true);
    const update = hoisted.updates.find(u => u.path === "shifts/s1")?.data;
    expect(update.reschedulePendingDate).toEqual({ __delete: true });
    expect(update.date).toBeUndefined();
  });
});

describe("request_schedule_amendment", () => {
  beforeEach(() => { hoisted.reset(); hoisted.docState.set(`users/${CLIENT}`, { identityCheckStatus: "verified", membershipStatus: "active" }); });

  it("is gated like the Calendar's + Request Visit button", async () => {
    hoisted.docState.set(`users/${CLIENT}`, { identityCheckStatus: "verified", membershipStatus: "canceled" });
    hoisted.docState.set("booking_requests/br1", { clientId: CLIENT, clientName: "A Family", caregiverId: CAREGIVER, caregiverName: "Alice" });
    const r = await handleToolCall("request_schedule_amendment", {
      bookingRequestId: "br1", clientId: CLIENT, date: "2026-09-07", startTime: "14:00", endTime: "16:00",
    }) as any;
    expect(r.code).toBe("MEMBERSHIP_REQUIRED");
  });

  it("writes a booking_amendments doc matching the site's add_recurring_days shape", async () => {
    hoisted.docState.set("booking_requests/br1", { clientId: CLIENT, clientName: "A Family", caregiverId: CAREGIVER, caregiverName: "Alice" });
    hoisted.docState.set(`caregivers/${CAREGIVER}`, { phone: "+15551234567" });

    const r = await handleToolCall("request_schedule_amendment", {
      bookingRequestId: "br1", clientId: CLIENT, date: "2026-09-07", startTime: "14:00", endTime: "16:00",
    }) as any;
    expect(r.success).toBe(true);
    const set = hoisted.sets.find(s => s.path.startsWith("booking_amendments/"));
    expect(set?.data).toMatchObject({
      bookingRequestId: "br1", clientId: CLIENT, caregiverId: CAREGIVER,
      status: "pending", type: "add_recurring_days",
      startDate: "2026-09-07", endDate: "2026-09-07", ongoing: false,
    });
    expect(Object.keys(set?.data.newDays)).toHaveLength(1);
  });

  // 2026-09-16: the modal's full shape — several days, several blocks — and
  // its checks (overlap with the booking's own schedule / this family's
  // shifts, or a time the caregiver is booked elsewhere).
  it("accepts the modal's newDays shape with several days and blocks, ongoing by default", async () => {
    hoisted.docState.set("booking_requests/br1", { clientId: CLIENT, caregiverId: CAREGIVER, caregiverName: "Alice", schedule: { dayShiftTimes: { Tue: [{ start: "11:00", end: "13:00" }] } } });
    const r = await handleToolCall("request_schedule_amendment", {
      bookingRequestId: "br1", clientId: CLIENT, startDate: "2099-01-05",
      newDays: { Thu: [{ start: "09:00", end: "11:00" }, { start: "14:00", end: "16:00" }], saturday: [{ start: "10:00", end: "12:00" }] },
      notes: "side door",
    }) as any;
    expect(r.success).toBe(true);
    const set = hoisted.sets.find(s => s.path.startsWith("booking_amendments/"));
    expect(set?.data).toMatchObject({
      type: "add_recurring_days", status: "pending", ongoing: true, endDate: null, startDate: "2099-01-05", notes: "side door",
      newDays: { Thu: [{ start: "09:00", end: "11:00" }, { start: "14:00", end: "16:00" }], Sat: [{ start: "10:00", end: "12:00" }] },
    });
  });

  it("refuses a block that overlaps a visit the family already has with that caregiver (the modal's overlappingDays)", async () => {
    hoisted.docState.set("booking_requests/br1", { clientId: CLIENT, caregiverId: CAREGIVER, caregiverName: "Alice", schedule: { dayShiftTimes: { Tue: [{ start: "11:00", end: "13:00" }] } } });
    const r = await handleToolCall("request_schedule_amendment", {
      bookingRequestId: "br1", clientId: CLIENT, newDays: { Tue: [{ start: "12:00", end: "14:00" }] },
    }) as any;
    expect(r._toolError).toBe(true);
    expect(String(r.message)).toContain("overlaps a visit the family already has with Alice (11:00 AM–1:00 PM)");
    expect(hoisted.sets.find(s => s.path.startsWith("booking_amendments/"))).toBeUndefined();
  });

  it("refuses a time the caregiver is booked elsewhere (the modal's greyed-out slots)", async () => {
    hoisted.docState.set("booking_requests/br1", { clientId: CLIENT, caregiverId: CAREGIVER, caregiverName: "Alice", schedule: {} });
    hoisted.docState.set(`caregiver_booked_slots/${CAREGIVER}`, { slots: { Fri: [{ s: 9 * 60, e: 12 * 60 }] } });
    const r = await handleToolCall("request_schedule_amendment", {
      bookingRequestId: "br1", clientId: CLIENT, newDays: { Fri: [{ start: "10:00", end: "11:00" }] },
    }) as any;
    expect(r._toolError).toBe(true);
    expect(String(r.message)).toContain("Alice is already booked Friday 9:00 AM–12:00 PM");
  });

  it("rejects a booking belonging to a different client", async () => {
    hoisted.docState.set("booking_requests/br1", { clientId: "other_client" });
    const r = await handleToolCall("request_schedule_amendment", {
      bookingRequestId: "br1", clientId: CLIENT, date: "2026-09-07", startTime: "14:00", endTime: "16:00",
    }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("PERMISSION_DENIED");
  });
});

// (respond_to_schedule_amendment retired 2026-09-27 — the Requests tab's schedule-change
// cards are answered by respond_to_booking_request by number; the page-exact accept/decline
// live in agents/caregiverBookingRequests.ts and are tested there.)
