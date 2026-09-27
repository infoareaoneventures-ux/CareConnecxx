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

vi.mock("../../agents/caregiverSearch", () => ({
  presentCaregiverSearch: vi.fn(async () => ({ status: "shown", total: 0, shown: [], offset: 0, hasMore: false })),
  searchCaregivers: vi.fn(async () => ({ total: 0, caregivers: [], hasLocation: false, filters: {} })),
}));

vi.mock("../../utils/toolNotify", () => ({
  trySend:        vi.fn().mockResolvedValue({ sent: true }),
  trySendViaCara: vi.fn().mockResolvedValue({ sent: true }),
}));

import { handleToolCall } from "../server";

describe("missing CRUD tools", () => {
  beforeEach(() => { hoisted.reset(); });

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

  // The Interviews tab's Resend rows as a read (2026-09-17, live-caught: the
  // agent inferred "nothing to resend" from unrelated tools).
  describe("get_resendable_booking_requests", () => {
    it("requires clientId", async () => {
      const r = await handleToolCall("get_resendable_booking_requests", {}) as any;
      expect(r._toolError).toBe(true);
    });

    it("returns the latest declined/cancelled request per caregiver+job, labelled like the site's rows", async () => {
      hoisted.collState.set("booking_requests", [
        { id: "br-c", clientId: "c1", caregiverId: "cg1", caregiverName: "Basra Yousuf", interviewId: "iv-a", status: "cancelled", createdAt: "2026-09-10T00:00:00.000Z" },
        { id: "br-p", clientId: "c1", caregiverId: "cg1", caregiverName: "Basra Yousuf", jobId: "job-1", status: "pending", createdAt: "2026-09-11T00:00:00.000Z" },
      ]);
      const r = await handleToolCall("get_resendable_booking_requests", { clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.count).toBe(1);
      expect(r.requests[0]).toMatchObject({ bookingRequestId: "br-c", caregiverName: "Basra Yousuf", statusLabel: "Visit cancelled" });
      expect(r.instruction).toContain("start_resend_booking_flow");
    });

    it("says plainly when nothing is resendable", async () => {
      hoisted.collState.set("booking_requests", [
        { id: "br-p", clientId: "c1", caregiverId: "cg1", jobId: "job-1", status: "pending", createdAt: "2026-09-11T00:00:00.000Z" },
      ]);
      const r = await handleToolCall("get_resendable_booking_requests", { clientId: "c1" }) as any;
      expect(r.count).toBe(0);
      expect(r.instruction).toContain("Nothing is resendable");
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
  describe("get_pending_tasks — the site's pending items, never an Evia-only queue", () => {
    it("returns the Requests tab, Needs Replacement / Review buttons, interview proposals, Care Plan banner and timesheets with waitingOn", async () => {
      hoisted.collState.set("booking_requests", [{ id: "br1", clientId: "c1", status: "pending", caregiverName: "Basra Yousuf", isResend: true }]);
      hoisted.collState.set("booking_amendments", [{ id: "am1", clientId: "c1", status: "pending", bookingRequestId: "br0", caregiverName: "Basra Yousuf", startDate: "2099-01-08" }]);
      hoisted.collState.set("shifts", [
        { id: "s1", clientId: "c1", status: "needs_replacement", date: "2099-01-05", startTime: "14:00", endTime: "15:00", caregiverName: "Basra Yousuf" },
        { id: "s2", clientId: "c1", status: "scheduled", date: "2099-01-06", startTime: "20:00", endTime: "21:30", caregiverName: "Basra Yousuf", reschedulePendingDate: "2099-01-07", reschedulePendingStartTime: "10:00", reschedulePendingEndTime: "11:30", rescheduledBy: "caregiver" },
        { id: "s3", clientId: "c1", status: "scheduled", date: "2099-01-08", startTime: "20:00", endTime: "21:30", caregiverName: "Basra Yousuf", reschedulePendingDate: "2099-01-09", reschedulePendingStartTime: "10:00", rescheduledBy: "client" },
        { id: "s4", clientId: "c1", status: "scheduled", date: "2099-01-10", startTime: "20:00", endTime: "21:30", caregiverName: "Basra Yousuf" },
      ]);
      hoisted.docState.set("carePlans/c1", { recipientPlans: {} });
      hoisted.collState.set("shiftHours", [{ id: "h1", clientId: "c1", status: "pending_client_review" }, { id: "h2", clientId: "c1", status: "pending_client_review" }]);
      const r = await handleToolCall("get_pending_tasks", { clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      const byKind = Object.fromEntries(r.items.map((i: any) => [i.kind + ":" + (i.shiftId ?? i.amendmentId ?? i.bookingRequestId ?? ""), i]));
      expect(byKind["booking_request_pending:br1"]).toMatchObject({ waitingOn: "caregiver", isResend: true, page: "My Bookings > Requests" });
      expect(byKind["visit_request_pending:am1"]).toMatchObject({ waitingOn: "caregiver" });
      expect(byKind["visit_needs_replacement:s1"]).toMatchObject({ waitingOn: "you", actions: ["find_replacement", "skip"] });
      expect(byKind["visit_reschedule_proposal:s2"]).toMatchObject({ waitingOn: "you", proposedDate: "2099-01-07" });
      expect(byKind["visit_reschedule_proposal:s3"]).toMatchObject({ waitingOn: "caregiver" });
      expect(r.items.some((i: any) => i.shiftId === "s4")).toBe(false);
      expect(r.items.find((i: any) => i.kind === "care_plan_review")).toMatchObject({ waitingOn: "you" });
      expect(r.items.find((i: any) => i.kind === "timesheets_to_review")).toMatchObject({ waitingOn: "you", count: 2 });
      expect(r.waitingOnYou).toBe(4);
    });
    it("a reviewed care plan and no open items → Nothing pending", async () => {
      hoisted.docState.set("carePlans/c1", { carePlanReviewedAt: "2099-01-01T00:00:00.000Z" });
      const r = await handleToolCall("get_pending_tasks", { clientId: "c1" }) as any;
      expect(r).toMatchObject({ success: true, total: 0, summary: "Nothing pending" });
    });
  });

  describe("get_pending_timesheets — the website's Timesheets page", () => {
    const seed = () => hoisted.collState.set("shiftHours", [
      { id: "a1", clientId: "c1", caregiverId: "cg1", caregiverName: "Basra Yousuf", status: "pending_client_review", submittedStartTime: "2099-01-05T22:00:00.000Z", submittedEndTime: "2099-01-05T23:30:00.000Z", payRate: 20, lineItems: [], submittedAt: "2099-01-05T23:35:00.000Z", autoApproveAt: "2099-01-06T23:35:00.000Z" },
      { id: "a2", clientId: "c1", caregiverId: "cg1", caregiverName: "Basra Yousuf", status: "correction_proposed", submittedStartTime: "2099-01-04T22:00:00.000Z", submittedEndTime: "2099-01-05T00:00:00.000Z", payRate: 20, submittedAt: "2099-01-05T00:05:00.000Z", correctionHistory: [{ by: "caregiver", action: "submitted", at: "x" }, { by: "client", action: "proposed_correction", at: "y", hours: 1.5 }] },
      { id: "a3", clientId: "c1", caregiverId: "cg2", caregiverName: "Imran", status: "payment_failed", submittedStartTime: "2099-01-03T20:00:00.000Z", submittedEndTime: "2099-01-03T21:00:00.000Z", payRate: 24, grossPay: 24, submittedAt: "2099-01-03T21:05:00.000Z" },
      { id: "a4", clientId: "c1", caregiverId: "cg1", caregiverName: "Basra Yousuf", status: "paid", finalStartTime: "2099-01-01T20:00:00.000Z", finalEndTime: "2099-01-01T22:00:00.000Z", submittedStartTime: "2099-01-01T20:00:00.000Z", submittedEndTime: "2099-01-01T22:30:00.000Z", payRate: 20, grossPay: 40, resolvedBy: "caregiver", submittedAt: "2099-01-01T22:35:00.000Z" },
      { id: "a5", clientId: "c1", caregiverId: "cg1", caregiverName: "Basra Yousuf", status: "auto_approved", submittedStartTime: "2098-12-20T20:00:00.000Z", submittedEndTime: "2098-12-20T21:00:00.000Z", payRate: 20, grossPay: 20, submittedAt: "2098-12-20T21:05:00.000Z" },
    ]);

    it("requires clientId", async () => {
      const r = await handleToolCall("get_pending_timesheets", {}) as any;
      expect(r._toolError).toBe(true);
    });

    it("Needs Review = the page's six statuses, grouped by caregiver, with the card's fields and button", async () => {
      seed();
      const r = await handleToolCall("get_pending_timesheets", { clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.tab).toBe("needs_review");
      expect(r.rows.map((x: any) => x.id).sort()).toEqual(["a1", "a2", "a3"]);
      expect(r.counts).toEqual({ needsReview: 3, history: 2, pendingReview: 1, pending: 1 });
      const a1 = r.rows.find((x: any) => x.id === "a1");
      expect(a1).toMatchObject({ caregiverName: "Basra Yousuf", hours: 1.5, duration: "1:30:00", basePay: 30, grossPay: 30, statusLabel: "Needs Review", actions: ["review_and_approve"], autoApproveAt: "2099-01-06T23:35:00.000Z" });
      const a2 = r.rows.find((x: any) => x.id === "a2");
      expect(a2).toMatchObject({ statusLabel: "Correction Sent", actions: [] });
      expect(a2.statusHint).toMatch(/Waiting for the caregiver/);
      expect(a2.correctionHistory).toEqual([expect.objectContaining({ action: "proposed_correction", label: "Client proposed correction", hours: 1.5 })]);
      expect(r.rows.find((x: any) => x.id === "a3")).toMatchObject({ statusLabel: "Payment Failed", actions: ["retry_payment"], grossPay: 24 });
      const basra = r.groups.find((g: any) => g.caregiverId === "cg1");
      expect(basra.rows.map((x: any) => x.id)).toEqual(["a1", "a2"]); // actionable first
      expect(r.groups.find((g: any) => g.caregiverId === "cg2").rows).toHaveLength(1);
    });

    it("History = approved / auto-approved / paid, final times win, with the report totals and date range", async () => {
      seed();
      const all = await handleToolCall("get_pending_timesheets", { clientId: "c1", tab: "history" }) as any;
      expect(all.rows.map((x: any) => x.id).sort()).toEqual(["a4", "a5"]);
      expect(all.rows.find((x: any) => x.id === "a4")).toMatchObject({ hours: 2, isCorrected: true, statusLabel: "Paid", actions: [] });
      expect(all.report).toMatchObject({ shifts: 2, hours: 3, pay: 60 });
      const ranged = await handleToolCall("get_pending_timesheets", { clientId: "c1", tab: "history", from: "2099-01-01", to: "2099-01-31" }) as any;
      expect(ranged.rows.map((x: any) => x.id)).toEqual(["a4"]);
      expect(ranged.report).toMatchObject({ from: "2099-01-01", to: "2099-01-31", shifts: 1, hours: 2, pay: 40 });
    });

    it("get_payment_update_link with no billing account = the page's Add a card → membership page", async () => {
      const r = await handleToolCall("get_payment_update_link", { clientId: "c1" }) as any;
      expect(r).toMatchObject({ success: true, hasCard: false, action: "add_card" });
      expect(r.url).toMatch(/\/client\/membership$/);
    });
  });

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

    it("each visit and interview carries the page's click-through popover fields and buttons", async () => {
      hoisted.collState.set("shifts", [
        { id: "s1", clientId: "c1", caregiverName: "Basra Yousuf", status: "scheduled", date: "2099-01-05", startTime: "20:00", endTime: "21:30", address: "4746 campbell ave", notes: "bring keys",
          careRecipients: [{ name: "Samira M" }], careNeeds: ["Meal Preparation", "Personal Care"], tasksCompleted: [] },
        { id: "s2", clientId: "c1", caregiverName: "Basra Yousuf", status: "completed", date: "2099-01-06", startTime: "11:00", endTime: "13:00", startedAt: "2099-01-06T19:02:00.000Z", completedAt: "2099-01-06T21:00:00.000Z", completionNotes: "all good", careNeeds: ["Meal Preparation"], tasksCompleted: ["Meal Preparation"] },
        { id: "s3", clientId: "c1", caregiverName: "Basra Yousuf", status: "cancelled", date: "2099-01-07", startTime: "11:00", endTime: "13:00" },
      ]);
      hoisted.collState.set("video_interviews", [
        { id: "iv1", clientId: "c1", caregiverName: "Basra Yousuf", status: "requested", scheduledTime: "2099-01-04T17:00:00.000Z", callUrl: "https://meet.google.com/abc-defg-hij", jobId: "job1" },
        { id: "iv2", clientId: "c1", caregiverName: "Basra Yousuf", status: "completed", scheduledTime: "2099-01-05T17:00:00.000Z", interviewType: "phone" },
      ]);
      hoisted.docState.set("job_posts/job1", { title: "Senior care in San Jose", city: "San Jose", state: "CA" });
      const r = await handleToolCall("get_calendar", { clientId: "c1", fromDate: "2099-01-03", toDate: "2099-01-09" }) as any;
      const byId = Object.fromEntries(r.visits.map((v: any) => [v.id, v]));
      expect(byId.s1).toMatchObject({ address: "4746 campbell ave", notes: "bring keys", careRecipients: ["Samira M"], careNeeds: ["Meal Preparation", "Personal Care"], tasksCompleted: [], actions: ["message", "cancel"] });
      expect(byId.s2).toMatchObject({ startedAt: "2099-01-06T19:02:00.000Z", completionNotes: "all good", actions: ["message"] });
      expect(byId.s3.actions).toEqual([]);
      const iv = Object.fromEntries(r.interviews.map((i: any) => [i.id, i]));
      expect(iv.iv1).toMatchObject({ statusLabel: "Pending", typeLabel: "Video Call", jobTitle: "Senior care in San Jose", jobLocation: "San Jose, CA", callUrl: "https://meet.google.com/abc-defg-hij", actions: ["join_video_call", "message", "cancel"] });
      expect(iv.iv2).toMatchObject({ statusLabel: "Completed", typeLabel: "Phone Call", callUrl: null, actions: ["message"] });
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

// Wizard-parity value rules at the save site (2026-09-23): the client's rate,
// start date and emergency phone are validated/canonicalized exactly as the
// site's ClientJobPostingWizard would store them (canAdvanceAt + createJobPosting).
vi.mock("../../utils/openaiClient", () => ({
  quickComplete: vi.fn(async (_sys: string, text: string) => {
    // careNeedsTaxonomy's canonicalizer sends the unresolved terms as a JSON
    // array — answer like the real model: a task maps, a frequency word doesn't.
    if (text.trim().startsWith("[")) {
      const terms = JSON.parse(text) as string[];
      const out: Record<string, unknown> = {};
      for (const t of terms) out[t] = /meal/i.test(t) ? { category: "Meal Preparation", sub: null } : null;
      return JSON.stringify(out);
    }
    return /next monday/i.test(text) ? "2099-06-07" : "UNKNOWN";
  }),
  getOpenAIClient: vi.fn(),
}));
import { businessTodayStr } from "../../utils/scheduledTime";

describe("caregiver action tools enforce the website's gate (hooks/useCaregiverGate.tsx) — 2026-09-26", () => {
  beforeEach(() => { hoisted.reset(); });
  const openJob = (extra: Record<string, unknown> = {}) =>
    hoisted.docState.set("job_posts/job1", { status: "open", clientId: "client1", careTypes: ["Companionship"], ...extra });

  // (the apply_to_job gate tests moved to agents/__tests__/caregiverJobFlows.test.ts
  // when the Apply modal became a scripted flow, 2026-09-27)

  it("respond_to_booking_request: Decline is never gated (the site keeps Decline available); Accept is", async () => {
    hoisted.docState.set("caregivers/cg1", { name: "Maria" });
    const accept = await handleToolCall("respond_to_booking_request", { caregiverId: "cg1", appointmentId: "bk1", decision: "accept" }) as any;
    expect(accept.code).toBe("MEMBERSHIP_REQUIRED");
    const decline = await handleToolCall("respond_to_booking_request", { caregiverId: "cg1", appointmentId: "bk1", decision: "decline" }) as any;
    expect(decline.code).not.toBe("MEMBERSHIP_REQUIRED");
  });
});

describe("save_onboarding_field client wizard-parity values (rate / startDate / emergency phone)", () => {
  const PHONE = "+15555550003";
  beforeEach(() => { hoisted.reset(); });
  const onboardingData = () => hoisted.docState.get(`agent_sessions/${PHONE}`)?.onboardingData ?? {};

  it("a 'flexible' rate is NOT saved — gentle re-ask for a number (the wizard has no flexible option)", async () => {
    const r = await handleToolCall("save_onboarding_field", {
      phone: PHONE, role: "client", fieldName: "rate", fieldValue: "flexible",
    }) as any;
    expect(r.ok).toBe(true);
    expect(r.saved).toBe(false);
    expect(r.invalidValue).toBe(true);
    expect(r.guidance).toMatch(/number/i);
    expect(onboardingData().rate).toBeUndefined();
  });

  it("caregiver hourlyRate outside the wizard's $15–$200 is NOT saved — re-ask with the range (2026-09-26: '$3/hr' was accepted)", async () => {
    const low = await handleToolCall("save_onboarding_field", {
      phone: PHONE, role: "caregiver", fieldName: "hourlyRate", fieldValue: "3",
    }) as any;
    expect(low.saved).toBe(false);
    expect(low.invalidValue).toBe(true);
    expect(low.guidance).toMatch(/\$15 to \$200/);
    expect(onboardingData().hourlyRate).toBeUndefined();
    const ok = await handleToolCall("save_onboarding_field", {
      phone: PHONE, role: "caregiver", fieldName: "hourlyRate", fieldValue: "$23/hr",
    }) as any;
    expect(ok.saved).toBe(true);
    expect(onboardingData().hourlyRate).toBe(23);
  });

  it("caregiver availability merges across two messages and says which half is still needed", async () => {
    const daysOnly = await handleToolCall("save_onboarding_field", {
      phone: PHONE, role: "caregiver", fieldName: "availability", fieldValue: { days: ["Monday"], hours: "" },
    }) as any;
    expect(daysOnly.saved).toBe(true);
    expect(daysOnly.missing).toContain("availability");
    expect(daysOnly.guidance).toMatch(/parts of the day/i);
    const timesToo = await handleToolCall("save_onboarding_field", {
      phone: PHONE, role: "caregiver", fieldName: "availability", fieldValue: { days: [], hours: "mornings" },
    }) as any;
    expect(timesToo.saved).toBe(true);
    expect(timesToo.missing).not.toContain("availability");
    expect(onboardingData().availability).toEqual({ days: ["Monday"], hours: "mornings" });
  });

  it("a numeric-string rate is saved as a number", async () => {
    const r = await handleToolCall("save_onboarding_field", {
      phone: PHONE, role: "client", fieldName: "rate", fieldValue: "$26/hr",
    }) as any;
    expect(r.saved).toBe(true);
    expect(onboardingData().rate).toBe(26);
  });

  it("startDate 'ASAP' is stored as today's ISO date, like the wizard's date input", async () => {
    const r = await handleToolCall("save_onboarding_field", {
      phone: PHONE, role: "client", fieldName: "startDate", fieldValue: "ASAP",
    }) as any;
    expect(r.saved).toBe(true);
    expect(onboardingData().startDate).toBe(businessTodayStr());
  });

  it("an ISO startDate is kept; free text is resolved through the quick model; unresolvable text is re-asked", async () => {
    let r = await handleToolCall("save_onboarding_field", {
      phone: PHONE, role: "client", fieldName: "startDate", fieldValue: "2099-05-01",
    }) as any;
    expect(r.saved).toBe(true);
    expect(onboardingData().startDate).toBe("2099-05-01");

    r = await handleToolCall("save_onboarding_field", {
      phone: PHONE, role: "client", fieldName: "startDate", fieldValue: "next Monday",
    }) as any;
    expect(r.saved).toBe(true);
    expect(onboardingData().startDate).toBe("2099-06-07");

    r = await handleToolCall("save_onboarding_field", {
      phone: PHONE, role: "client", fieldName: "startDate", fieldValue: "whenever the stars align",
    }) as any;
    expect(r.saved).toBe(false);
    expect(r.invalidValue).toBe(true);
    expect(onboardingData().startDate).toBe("2099-06-07"); // unchanged
  });

  it("emergency phone is stored in the wizard's (555) 000-0000 shape; fewer than 10 digits is re-asked", async () => {
    let r = await handleToolCall("save_onboarding_field", {
      phone: PHONE, role: "client", fieldName: "emergencyContactPhone", fieldValue: "408 555 1234",
    }) as any;
    expect(r.saved).toBe(true);
    expect(onboardingData().emergencyContactPhone).toBe("(408) 555-1234");

    r = await handleToolCall("save_onboarding_field", {
      phone: PHONE, role: "client", fieldName: "emergencyContactPhone", fieldValue: "555-1234",
    }) as any;
    expect(r.saved).toBe(false);
    expect(r.invalidValue).toBe(true);
  });

  it("rejects the retired 'conditions' field outright", async () => {
    const r = await handleToolCall("save_onboarding_field", {
      phone: PHONE, role: "client", fieldName: "conditions", fieldValue: ["dementia"],
    }) as any;
    expect(r._toolError).toBe(true);
    expect(onboardingData().conditions).toBeUndefined();
  });
});

// 2026-09-26 live client signup: the model saved the frequency answer as the
// care need "occasional help" (skipping the "what kind of help" step and
// putting a bogus pill on the Care Plan), and lost the smoking / pets /
// description answers by inventing field keys ('smoking', 'pets',
// 'description') the tool rejected. Both are closed at the save site.
describe("save_onboarding_field client care needs + field-name aliases (2026-09-26)", () => {
  const PHONE = "+15555550004";
  beforeEach(() => { hoisted.reset(); });
  const onboardingData = () => hoisted.docState.get(`agent_sessions/${PHONE}`)?.onboardingData ?? {};

  it("careNeeds are stored as the site's category names (+ sub-tasks), never the raw words", async () => {
    const r = await handleToolCall("save_onboarding_field", {
      phone: PHONE, role: "client", fieldName: "careNeeds", fieldValue: ["Bathing", "help with meals"],
    }) as any;
    expect(r.saved).toBe(true);
    expect(onboardingData().careNeeds).toEqual(["Personal Care", "Meal Preparation"]);
    expect(onboardingData().careNeedDetails).toEqual({ "Personal Care": ["Bathing"] });
  });

  it("a frequency answer is NOT a care need — refused with guidance, nothing stored", async () => {
    const r = await handleToolCall("save_onboarding_field", {
      phone: PHONE, role: "client", fieldName: "careNeeds", fieldValue: "occasional help",
    }) as any;
    expect(r.ok).toBe(true);
    expect(r.saved).toBe(false);
    expect(r.invalidValue).toBe(true);
    expect(r.guidance).toMatch(/careFrequency/);
    expect(onboardingData().careNeeds).toBeUndefined();
  });

  it.each([
    ["smoking", true, "smokingHousehold"],
    ["pets", false, "petsInHome"],
    ["description", "Looking for a kind caregiver for my son", "jobDescription"],
    ["Emergency Contact Relationship", "sibling", "emergencyContactRelationship"],
  ])("near-miss key %o resolves onto the contract key", async (key, value, canonical) => {
    const r = await handleToolCall("save_onboarding_field", {
      phone: PHONE, role: "client", fieldName: key, fieldValue: value,
    }) as any;
    expect(r.saved).toBe(true);
    expect(r.fieldName).toBe(canonical);
    expect(onboardingData()[canonical]).toBe(value);
  });

  it("a genuinely unknown key is rejected WITH the allowed list so the model can retry", async () => {
    const r = await handleToolCall("save_onboarding_field", {
      phone: PHONE, role: "client", fieldName: "favoriteColor", fieldValue: "blue",
    }) as any;
    expect(r._toolError).toBe(true);
    expect(r.message).toMatch(/smokingHousehold/);
    expect(onboardingData().favoriteColor).toBeUndefined();
  });
});
