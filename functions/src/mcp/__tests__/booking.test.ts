import { describe, it, expect, vi, beforeEach } from "vitest";

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

// request_booking (U9b) delegates the actual write to createBookingTask via a
// dynamic import. Mock it so the handler test exercises validation + the shared
// quote + delegation, not the booking-executor internals (bgcheck guard etc.).
const createBookingTask = vi.fn().mockResolvedValue("task-123");
vi.mock("../../agents/bookingExecutor", () => ({
  createBookingTask: (...args: unknown[]) => createBookingTask(...args),
}));

const trySend = vi.fn().mockResolvedValue({ sent: true });
vi.mock("../../utils/toolNotify", () => ({
  trySend:        (...args: unknown[]) => trySend(...args),
  trySendViaCara: vi.fn().mockResolvedValue({ sent: true }),
}));

// Stub the Linq transport so server.ts's module graph loads.
const sendMessage = vi.fn().mockResolvedValue({ message_id: "m1" });
vi.mock("../../linq/client", () => ({
  sendMessage:        (...args: unknown[]) => sendMessage(...args),
  getOrCreateSession: vi.fn().mockResolvedValue({ chatId: "chat-cg" }),
  sendToPhone:        vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../utils/caraMessage", () => ({
  generateCaraMessage: vi.fn(async ({ fallback }: { fallback: string }) => fallback),
}));

// Control the idempotency ledger so we can assert the handleToolCall wiring (U6)
// without a real Firestore round-trip. `claimToolExecution` returning {cached}
// short-circuits before executeToolCall, so no tool body runs.
const ledger = vi.hoisted(() => ({
  claimToolExecution: vi.fn(async (_key: string) => ({ cached: false as const })),
  settleToolExecution: vi.fn(async () => {}),
  toolExecutionKey: (id: string, name: string) => `${id}:${name}:hash`,
}));
vi.mock("../toolExecutionLedger", () => ledger);

// Make the confirmation gate accept our _confirmedActionId so the confirmed path
// (where idempotency applies) is reached.
vi.mock("../../agents/pendingActions", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return {
    ...actual,
    getPendingActionById: vi.fn(async () => ({ status: "awaiting", toolName: "any", phone: "+15125550123" })),
    isConfirmedActionValid: vi.fn(() => true),
  };
});

import { handleToolCall } from "../server";
import { setCaraActionExecutionStoreForTest } from "../../agents/actionNative/actionExecutionLedger";

// Pass-through duplicate-protection store: request_booking is failClosed, so
// an unavailable ledger (this file's firestore mock) would refuse to run at
// all. These suites test domain behavior, so the store never caches.
setCaraActionExecutionStoreForTest({
  async claim() {
    return { cached: false };
  },
  async settle() { /* no-op */ },
});

describe("booking tools", () => {
  beforeEach(() => {
    hoisted.reset(); trySend.mockClear(); trySend.mockResolvedValue({ sent: true });
    createBookingTask.mockClear(); createBookingTask.mockResolvedValue("task-123");
    // request_booking now gates on identity/membership (mirrors the website's
    // own paywall) — default client c1 to verified+active so the existing
    // booking-domain tests below keep exercising booking logic, not the gate.
    hoisted.docState.set("users/c1", { identityCheckStatus: "verified", membershipStatus: "active" });
  });

  // ── U9b: read-only booking primitives extracted from request_booking ─────────
  // These must NEVER write — the whole point is that Evia can look up a rate and
  // quote a cost without committing. Each test asserts no booking task is created.
  describe("get_caregiver_booking_rate (U9b)", () => {
    it("returns the caregiver's name + hourly rate, writing nothing", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: 25 });
      const r = await handleToolCall("get_caregiver_booking_rate", { caregiverId: "cg1", clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.caregiverName).toBe("Maria");
      expect(r.hourlyRate).toBe(25);
      // Pure read — no agent_tasks / booking writes.
      expect(hoisted.adds.length).toBe(0);
    });

    // U6 (hallucination hardening 2026-07-17, R9): the old silent $20 fallback
    // is GONE — a missing rate is a structured RATE_UNKNOWN error telling the
    // agent to confirm the real rate, never a fabricated number.
    it("returns RATE_UNKNOWN (not a fabricated $20) when the caregiver has no rate on file", async () => {
      hoisted.docState.set("caregivers/cg2", { name: "Sam" });
      const r = await handleToolCall("get_caregiver_booking_rate", { caregiverId: "cg2" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("RATE_UNKNOWN");
      expect(r.message).toMatch(/confirm/i);
      // Escalation guidance: the agent is pointed at create_support_ticket so
      // a family who needs it resolved now has a real path.
      expect(r.message).toContain("create_support_ticket");
      expect(JSON.stringify(r)).not.toContain("20");
    });

    // Legacy prod docs can carry hourlyRate as a STRING ("25", "$25") — the
    // onboarding correction path stored raw user text whenever Number() failed.
    // Strict plain-numeric strings (optional leading "$") coerce and flow like
    // numbers; anything else stays RATE_UNKNOWN (never a guessed rate).
    it('coerces a legacy string rate "25" and returns the number 25', async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: "25" });
      const r = await handleToolCall("get_caregiver_booking_rate", { caregiverId: "cg1", clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.hourlyRate).toBe(25);
      expect(hoisted.adds.length).toBe(0); // still a pure read
    });

    it('coerces a legacy "$27.50" string rate to 27.5 (leading $ stripped)', async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: "$27.50" });
      const r = await handleToolCall("get_caregiver_booking_rate", { caregiverId: "cg1", clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.hourlyRate).toBe(27.5);
    });

    it("keeps RATE_UNKNOWN for junk, empty, negative, zero, and unit-suffixed rates", async () => {
      for (const bad of ["abc", "", "-5", 0, "25/hr", "Infinity", "1e3"]) {
        hoisted.docState.set("caregivers/cgbad", { name: "Pat", hourlyRate: bad });
        const r = await handleToolCall("get_caregiver_booking_rate", { caregiverId: "cgbad" }) as any;
        expect(r._toolError, `hourlyRate=${JSON.stringify(bad)}`).toBe(true);
        expect(r.code, `hourlyRate=${JSON.stringify(bad)}`).toBe("RATE_UNKNOWN");
      }
    });

    it("returns NOT_FOUND for an unknown caregiver", async () => {
      const r = await handleToolCall("get_caregiver_booking_rate", { caregiverId: "ghost" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("NOT_FOUND");
    });

    it("requires caregiverId", async () => {
      const r = await handleToolCall("get_caregiver_booking_rate", {}) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("INVALID_INPUT");
    });
  });

  // ── U9b: request_booking's own rate/schedule resolution ───────────────────────
  describe("request_booking (U9b — commit path)", () => {
    // 2026-09-13: request_booking now confirms-before-commit (matching the
    // website's own "Review and edit before sending" modal) — _confirmedActionId
    // reaches the commit path via this file's own pendingActions mock above
    // (getPendingActionById/isConfirmedActionValid accept any id). Every test
    // in this block exercises the commit path (or a validation error that
    // fires BEFORE the confirm gate is ever reached), so both fixtures live
    // on the shared baseInput rather than per-test. careLocation is now
    // required (matching the website's own required "Care Location" field);
    // these tests pass it explicitly rather than seeding a users/c1 address.
    // agreedRate is also required now (2026-09-13: confirmed the website's
    // modal NEVER defaults a booking's rate from the caregiver's own listed
    // hourlyRate — that's browsing/display data only — so request_booking no
    // longer falls back to it either; these tests pass agreedRate explicitly
    // rather than relying on the seeded caregivers/cg1.hourlyRate).
    const baseInput = {
      clientId: "c1", phone: "+15555550100", caregiverId: "cg1",
      dates: ["2026-07-01", "2026-07-02"], startTime: "09:00", endTime: "17:00", // 8h
      careLocation: "123 Main St, Springfield",
      agreedRate: 30,
      _confirmedActionId: "test-confirm-1",
    };

    it("commits the booking with the family's agreed rate and duration, returning the estimate", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: 30 });
      const r = await handleToolCall("request_booking", baseInput) as any;
      expect(r.success).toBe(true);
      expect(r.taskId).toBe("task-123");
      expect(r.status).toBe("awaiting_approval");
      expect(r.estimatedTotal).toBe(480); // 8h * $30 * 2 days
      // Delegated to createBookingTask with the resolved values.
      expect(createBookingTask).toHaveBeenCalledTimes(1);
      const arg = createBookingTask.mock.calls[0][0] as any;
      expect(arg.caregiverName).toBe("Maria");
      expect(arg.hourlyRate).toBe(30);
      expect(arg.appointments).toHaveLength(2);
      expect(arg.appointments[0].durationHours).toBe(8);
    });

    // Job/interview linkage (2026-08-30, Care Requests parity): booking right
    // after an interview should carry the same jobId/jobTitle/interviewId the
    // website's handleSendBooking stamps, and mark the caregiver's application
    // accepted — without ever blocking the booking if the lookup fails.
    it("passing interviewId resolves jobId/jobTitle/applicationId onto createBookingTask", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: 30 });
      hoisted.docState.set("video_interviews/iv1", { clientId: "c1", caregiverId: "cg1", applicationId: "app1" });
      hoisted.docState.set("job_applications/app1", { jobId: "job1", caregiverId: "cg1" });
      hoisted.docState.set("job_posts/job1", { title: "Weekend companionship" });

      // Each test needs its own _confirmedActionId — the action-native ledger
      // treats a repeated id + tool name as a replay of the same completed
      // action, not a fresh call, across tests in this file.
      const r = await handleToolCall("request_booking", { ...baseInput, interviewId: "iv1", _confirmedActionId: "test-confirm-2" }) as any;
      expect(r.success).toBe(true);
      const arg = createBookingTask.mock.calls[0][0] as any;
      expect(arg.interviewId).toBe("iv1");
      expect(arg.jobId).toBe("job1");
      expect(arg.jobTitle).toBe("Weekend companionship");
      expect(arg.applicationId).toBe("app1");
    });

    // Top-level careNeeds + lifestylePreferences (2026-09-13): the website's
    // handleSendBooking stamps these onto booking_requests ALONGSIDE the
    // per-recipient careRecipients array — a deduped union of every selected
    // recipient's careNeeds, and the pets/smoking tags of whichever saved
    // address was actually picked. Both were previously dropped silently.
    it("stamps a deduped top-level careNeeds and per-recipient tasks/locations for a multi-recipient booking", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: 30 });
      hoisted.docState.set("carePlans/c1", {
        recipientPlans: {
          samira_noname: { name: "Samira", careNeeds: ["Mobility", "Meal prep"], tasks: { bathing: true }, locations: ["Bedroom"] },
          imran_noname:  { name: "Imran",  careNeeds: ["Meal prep", "Companionship"], tasks: { medication: true }, locations: ["Living room"] },
        },
      });
      const r = await handleToolCall("request_booking", {
        ...baseInput, recipientFirstNames: ["Samira", "Imran"], _confirmedActionId: "test-confirm-needs-1",
      }) as any;
      expect(r.success).toBe(true);
      const arg = createBookingTask.mock.calls[0][0] as any;
      expect(arg.careNeeds.sort()).toEqual(["Companionship", "Meal prep", "Mobility"]);
      expect(arg.careRecipients[0].tasks).toEqual({ bathing: true });
      expect(arg.careRecipients[0].locations).toEqual(["Bedroom"]);
      expect(arg.careRecipients[1].tasks).toEqual({ medication: true });
    });

    // Age/relationship (2026-09-13): matches the website's recipient cards
    // (e.g. "parent · Age 22") — confirmed this data lives on
    // job_postings/{clientUid} (a household profile doc), NOT on
    // carePlans.recipientPlans, so it needs its own lookup + name match.
    it("enriches multi-recipient careRecipients with age/relationship from job_postings", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: 30 });
      hoisted.docState.set("carePlans/c1", {
        recipientPlans: {
          samira_noname: { name: "Samira", careNeeds: ["Mobility"] },
          imran_noname:  { name: "Imran",  careNeeds: ["Companionship"] },
        },
      });
      hoisted.docState.set("job_postings/c1", {
        careRecipientFirstName: "Samira", careRecipientAge: "22", relationship: "parent",
        additionalRecipients: [{ firstName: "Imran", age: "45", relationship: "Other" }],
      });
      const r = await handleToolCall("request_booking", {
        ...baseInput, recipientFirstNames: ["Samira", "Imran"], _confirmedActionId: "test-confirm-needs-4",
      }) as any;
      expect(r.success).toBe(true);
      const arg = createBookingTask.mock.calls[0][0] as any;
      expect(arg.careRecipients[0]).toMatchObject({ name: "Samira", age: "22", relationship: "parent" });
      expect(arg.careRecipients[1]).toMatchObject({ name: "Imran", age: "45", relationship: "Other" });
    });

    it("stamps top-level careNeeds from the sole recipient plan for a single-recipient household", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: 30 });
      hoisted.docState.set("carePlans/c1", {
        recipientPlans: { onlyone: { name: "Grandma Rose", careNeeds: ["Medication reminders"] } },
      });
      const r = await handleToolCall("request_booking", { ...baseInput, _confirmedActionId: "test-confirm-needs-2" }) as any;
      expect(r.success).toBe(true);
      const arg = createBookingTask.mock.calls[0][0] as any;
      expect(arg.careNeeds).toEqual(["Medication reminders"]);
    });

    it("stamps lifestylePreferences tags from whichever saved address was actually picked", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: 30 });
      hoisted.docState.set("carePlans/c1", {
        locationPool: [{ street: "9 Oak Ave", city: "Springfield", state: "IL", zipCode: "62701", smokingHousehold: true, petsInHome: true }],
      });
      const { careLocation: _omit, ...noLocation } = baseInput;
      const r = await handleToolCall("request_booking", { ...noLocation, _confirmedActionId: "test-confirm-needs-3" }) as any;
      expect(r.success).toBe(true);
      const arg = createBookingTask.mock.calls[0][0] as any;
      expect(arg.lifestylePreferences.sort()).toEqual(["Pets in home", "Smoking household"]);
    });

    it("an interviewId that doesn't belong to this client/caregiver books unlinked instead of failing", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: 30 });
      hoisted.docState.set("video_interviews/iv1", { clientId: "someone_else", caregiverId: "cg1", applicationId: "app1" });

      const r = await handleToolCall("request_booking", { ...baseInput, interviewId: "iv1", _confirmedActionId: "test-confirm-3" }) as any;
      expect(r.success).toBe(true);
      const arg = createBookingTask.mock.calls[0][0] as any;
      expect(arg.jobId).toBeUndefined();
      expect(arg.jobTitle).toBeUndefined();
      expect(arg.applicationId).toBeUndefined();
    });

    it("booking with no interviewId at all stays unlinked (direct/matching-flow booking)", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: 30 });
      const r = await handleToolCall("request_booking", { ...baseInput, _confirmedActionId: "test-confirm-4" }) as any;
      expect(r.success).toBe(true);
      const arg = createBookingTask.mock.calls[0][0] as any;
      expect(arg.interviewId).toBeUndefined();
      expect(arg.jobId).toBeUndefined();
      expect(arg.applicationId).toBeUndefined();
    });

    // Recurring shape (2026-09-13): dayShiftTimes/ongoing/endDate instead of
    // dates/startTime/endTime — matches the website's own weekly shift
    // generator shape (shiftGenerator.ts's dayShiftTimes contract).
    it("commits a recurring booking with dayShiftTimes and computes weekly-hours estimate", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: 20 });
      const r = await handleToolCall("request_booking", {
        clientId: "c1", phone: "+15555550100", caregiverId: "cg1",
        careLocation: "123 Main St, Springfield",
        agreedRate: 20,
        recurring: true,
        dayShiftTimes: { Mon: { start: "09:00", end: "17:00" }, Wed: { start: "09:00", end: "17:00" } },
        ongoing: true,
        _confirmedActionId: "test-confirm-recurring-1",
      }) as any;
      expect(r.success).toBe(true);
      expect(r.estimatedTotal).toBe(320); // 16h/week * $20
      const arg = createBookingTask.mock.calls[0][0] as any;
      // Array-wrapped per day (2026-09-14, live-caught) — the input param
      // stays a flat {start,end} per day (the model-facing shape), but the
      // OUTPUT passed to createBookingTask must match the site's own
      // dayShiftTimes shape (an array of blocks per day), or
      // shiftGenerator.ts's onBookingAccepted trigger never generates any
      // real shifts for this booking at all.
      expect(arg.schedule.dayShiftTimes).toEqual({ Mon: [{ start: "09:00", end: "17:00" }], Wed: [{ start: "09:00", end: "17:00" }] });
      expect(arg.schedule.ongoing).toBe(true);
    });

    // 2026-09-14 (live-caught, same session, right after the array-wrap fix
    // above): the model calling this tool can supply dayShiftTimes keys in
    // any casing/format ("Monday" as easily as "Mon") — but the site's own
    // convention (PostsPage.tsx's booking modal, both dashboards' summary-
    // line rendering) keys it by the 3-letter abbreviation. A full-name key
    // rendered a blank weekly-schedule summary line on both the caregiver's
    // and client's dashboards, even though shiftGenerator.ts's own internal
    // normDay() call still generated the real per-visit shifts correctly —
    // masking the bug in practice.
    it("normalizes full weekday-name dayShiftTimes keys to the site's own 3-letter abbreviation", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: 20 });
      const r = await handleToolCall("request_booking", {
        clientId: "c1", phone: "+15555550100", caregiverId: "cg1",
        careLocation: "123 Main St, Springfield",
        agreedRate: 20,
        recurring: true,
        dayShiftTimes: { Monday: { start: "09:00", end: "17:00" }, Wednesday: { start: "09:00", end: "17:00" } },
        ongoing: true,
        _confirmedActionId: "test-confirm-recurring-2",
      }) as any;
      expect(r.success).toBe(true);
      const arg = createBookingTask.mock.calls[0][0] as any;
      expect(arg.schedule.dayShiftTimes).toEqual({ Mon: [{ start: "09:00", end: "17:00" }], Wed: [{ start: "09:00", end: "17:00" }] });
    });

    it("a recurring booking with no dayShiftTimes and a linked job post's days hints them in the error instead of guessing", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: 20 });
      hoisted.docState.set("video_interviews/iv1", { clientId: "c1", caregiverId: "cg1", applicationId: "app1" });
      hoisted.docState.set("job_applications/app1", { jobId: "job1", caregiverId: "cg1" });
      hoisted.docState.set("job_posts/job1", { title: "Weekday care", daysOfWeek: ["Mon", "Wed", "Fri"] });

      const r = await handleToolCall("request_booking", {
        clientId: "c1", phone: "+15555550100", caregiverId: "cg1",
        careLocation: "123 Main St, Springfield",
        interviewId: "iv1", recurring: true,
        _confirmedActionId: "test-confirm-recurring-2",
      }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("INVALID_INPUT");
      expect(r.message).toMatch(/Mon, Wed, Fri/);
      expect(r.message).toMatch(/only.*times/i);
      expect(createBookingTask).not.toHaveBeenCalled();
    });

    it("defaults endDate/ongoing from the linked job post's own schedule when the agent omits both", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: 20 });
      hoisted.docState.set("video_interviews/iv1", { clientId: "c1", caregiverId: "cg1", applicationId: "app1" });
      hoisted.docState.set("job_applications/app1", { jobId: "job1", caregiverId: "cg1" });
      hoisted.docState.set("job_posts/job1", { title: "Short-term care", daysOfWeek: ["Tue"], endDate: "2026-12-01" });

      const r = await handleToolCall("request_booking", {
        clientId: "c1", phone: "+15555550100", caregiverId: "cg1",
        careLocation: "123 Main St, Springfield",
        agreedRate: 20,
        interviewId: "iv1", recurring: true,
        dayShiftTimes: { Tue: { start: "10:00", end: "14:00" } },
        // ongoing/endDate deliberately omitted — should come from the job post, not be invented
        _confirmedActionId: "test-confirm-recurring-3",
      }) as any;
      expect(r.success).toBe(true);
      const arg = createBookingTask.mock.calls[0][0] as any;
      expect(arg.schedule.ongoing).toBe(false);
      expect(arg.schedule.endDate).toBe("2026-12-01");
    });

    it("a job post with no endDate on file still requires an explicit ongoing/endDate answer (never assumes ongoing)", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: 20 });
      hoisted.docState.set("video_interviews/iv1", { clientId: "c1", caregiverId: "cg1", applicationId: "app1" });
      hoisted.docState.set("job_applications/app1", { jobId: "job1", caregiverId: "cg1" });
      hoisted.docState.set("job_posts/job1", { title: "Open-ended care", daysOfWeek: ["Tue"] }); // no endDate on file

      const r = await handleToolCall("request_booking", {
        clientId: "c1", phone: "+15555550100", caregiverId: "cg1",
        careLocation: "123 Main St, Springfield",
        interviewId: "iv1", recurring: true,
        dayShiftTimes: { Tue: { start: "10:00", end: "14:00" } },
        _confirmedActionId: "test-confirm-recurring-4",
      }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("INVALID_INPUT");
      expect(r.message).toMatch(/endDate is required/i);
      expect(createBookingTask).not.toHaveBeenCalled();
    });

    // Care Location (2026-09-13): must match the website's own multi-address
    // picker (carePlans.locationPool), not just a single flat address.
    it("a single saved address in locationPool is used automatically, tags and all", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: 30 });
      hoisted.docState.set("carePlans/c1", {
        locationPool: [{ street: "9 Oak Ave", city: "Springfield", state: "IL", zipCode: "62701", smokingHousehold: true }],
      });
      const { careLocation: _omit, ...noLocation } = baseInput;
      const r = await handleToolCall("request_booking", { ...noLocation, _confirmedActionId: "test-confirm-loc-1" }) as any;
      expect(r.success).toBe(true);
      const arg = createBookingTask.mock.calls[0][0] as any;
      expect(arg.careLocation).toBe("9 Oak Ave, Springfield, IL, 62701");
    });

    it("more than one saved address refuses and lists the real options instead of guessing", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: 30 });
      hoisted.docState.set("carePlans/c1", {
        locationPool: [
          { street: "9 Oak Ave", city: "Springfield", state: "IL", zipCode: "62701" },
          { street: "42 Elm St", city: "Springfield", state: "IL", zipCode: "62702", smokingHousehold: true },
        ],
      });
      const { careLocation: _omit, ...noLocation } = baseInput;
      const r = await handleToolCall("request_booking", { ...noLocation, _confirmedActionId: "test-confirm-loc-2" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("INVALID_INPUT");
      expect(r.message).toMatch(/9 Oak Ave/);
      expect(r.message).toMatch(/42 Elm St/);
      expect(r.message).toMatch(/smoking household/i);
      expect(r.message).toMatch(/do NOT ask them to type an address from scratch/i);
      expect(createBookingTask).not.toHaveBeenCalled();
    });

    it("an explicit careLocation from the agent is used as-is even with multiple saved addresses on file", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: 30 });
      hoisted.docState.set("carePlans/c1", {
        locationPool: [
          { street: "9 Oak Ave", city: "Springfield", state: "IL", zipCode: "62701" },
          { street: "42 Elm St", city: "Springfield", state: "IL", zipCode: "62702" },
        ],
      });
      const r = await handleToolCall("request_booking", { ...baseInput, careLocation: "42 Elm St, Springfield, IL, 62702", _confirmedActionId: "test-confirm-loc-3" }) as any;
      expect(r.success).toBe(true);
      const arg = createBookingTask.mock.calls[0][0] as any;
      expect(arg.careLocation).toBe("42 Elm St, Springfield, IL, 62702");
    });

    it("no locationPool at all falls back to the single on-file users address", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: 30 });
      hoisted.docState.set("users/c1", { identityCheckStatus: "verified", membershipStatus: "active", street: "1 Fallback Rd", city: "Springfield", state: "IL", zipCode: "62703" });
      const { careLocation: _omit, ...noLocation } = baseInput;
      const r = await handleToolCall("request_booking", { ...noLocation, _confirmedActionId: "test-confirm-loc-4" }) as any;
      expect(r.success).toBe(true);
      const arg = createBookingTask.mock.calls[0][0] as any;
      expect(arg.careLocation).toBe("1 Fallback Rd, Springfield, IL, 62703");
    });

    it("rejects an unknown caregiver BEFORE any booking write (shared NOT_FOUND)", async () => {
      const r = await handleToolCall("request_booking", baseInput) as any; // no caregiver doc seeded
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("NOT_FOUND");
      expect(createBookingTask).not.toHaveBeenCalled();
    });

    // U6 (hallucination hardening 2026-07-17, R9): a caregiver with no
    // hourlyRate on file must NEVER be booked at a silent $20. The tool
    // returns a structured error instructing the agent to ask for / confirm
    // the rate, and no booking task is created.
    // Rate precedence (2026-09-13, confirmed against the site's own modal):
    // the caregiver's own listed hourlyRate is browsing/display data only —
    // request_booking must NEVER fall back to it for the actual committed
    // rate. Only an explicit agreedRate, or the linked job post's own rate,
    // may ever set it; caregivers/cg1.hourlyRate below is deliberately
    // irrelevant/absent to prove neither test path touches it.
    it("refuses and asks for a rate when neither agreedRate nor a linked job post's rate exists", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria" }); // no hourlyRate on file — must not matter either way
      const { agreedRate: _omit, ...noRate } = baseInput;
      const r = await handleToolCall("request_booking", noRate) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("INVALID_INPUT");
      expect(r.message).toMatch(/agreed rate/i);
      expect(r.message).toMatch(/never assumes the caregiver's own listed rate/i);
      expect(createBookingTask).not.toHaveBeenCalled();
    });

    it("falls back to the linked job post's own rate when agreedRate is omitted", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: 999 }); // must be ignored
      hoisted.docState.set("video_interviews/iv1", { clientId: "c1", caregiverId: "cg1", applicationId: "app1" });
      hoisted.docState.set("job_applications/app1", { jobId: "job1", caregiverId: "cg1" });
      hoisted.docState.set("job_posts/job1", { title: "Weekend companionship", rate: 22 });

      const { agreedRate: _omit, ...noRate } = baseInput;
      const r = await handleToolCall("request_booking", { ...noRate, interviewId: "iv1", _confirmedActionId: "test-confirm-5" }) as any;
      expect(r.success).toBe(true);
      const arg = createBookingTask.mock.calls[0][0] as any;
      expect(arg.hourlyRate).toBe(22);
    });

    it("surfaces a blocked booking (e.g. pending background check) without erroring", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: 30 });
      createBookingTask.mockResolvedValueOnce(""); // executor blocked it + already messaged the family
      const r = await handleToolCall("request_booking", { ...baseInput, _confirmedActionId: "test-confirm-6" }) as any;
      expect(r.success).toBe(false);
      expect(r.blocked).toBe(true);
      expect(r.reason).toBe("booking_blocked_pending_background_check");
      // ONE VOICE (double-send fix 2026-07-06): the executor already texted the
      // family the explanation — the result must say so, so the agent doesn't
      // re-explain in a second bubble.
      expect(r.sent).toBe(true);
      expect(r.instruction).toMatch(/ALREADY been texted/i);
    });

    it("requires session-injected clientId and phone", async () => {
      const noClient = await handleToolCall("request_booking", { ...baseInput, clientId: "" }) as any;
      expect(noClient._toolError).toBe(true);
      const noPhone = await handleToolCall("request_booking", { ...baseInput, phone: "" }) as any;
      expect(noPhone._toolError).toBe(true);
      expect(createBookingTask).not.toHaveBeenCalled();
    });

    // 2026-08-24: mirrors the website's own paywall (hooks/useAccessGates.tsx
    // `gate('booking', ...)`) — was entirely ungated here before.
    it("blocks when identity is not verified", async () => {
      hoisted.docState.set("users/c1", { membershipStatus: "active" });
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: 30 });
      const r = await handleToolCall("request_booking", baseInput) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("IDENTITY_REQUIRED");
      expect(createBookingTask).not.toHaveBeenCalled();
    });

    it("blocks when membership is not active", async () => {
      hoisted.docState.set("users/c1", { identityCheckStatus: "verified" });
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: 30 });
      const r = await handleToolCall("request_booking", baseInput) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("MEMBERSHIP_REQUIRED");
      expect(createBookingTask).not.toHaveBeenCalled();
    });
  });

  // ── Action-parity tools (Emergency SOS / caregiver callout / referral) ───────
  describe("trigger_emergency_alert", () => {
    it("writes an active emergency_alerts doc and advises 911", async () => {
      const r = await handleToolCall("trigger_emergency_alert", { clientId: "c1", note: "Dad fell" }) as any;
      expect(r.success).toBe(true);
      expect(r.status).toBe("active");
      expect(r.advise911).toBe(true);
      expect(hoisted.adds.some((a) => a.path === "emergency_alerts")).toBe(true);
    });
    it("requires session clientId", async () => {
      const r = await handleToolCall("trigger_emergency_alert", {}) as any;
      expect(r._toolError).toBe(true);
    });
  });

  // 2026-09-14 (Hamse's call): rebuilt against the real `shifts` collection —
  // the old tools queried `appointments`, a legacy model no current visit
  // (site or Evia) writes to anymore, so they never actually worked.
  describe("shift-replacement tools (get_callout_backups / select_callout_backup)", () => {
    const PHONE = "+15550001000";

    // 2026-09-14 (Hamse's call): also sends each candidate's real profile
    // card (same tappable photo-preview link the initial matching gallery
    // sends) and writes pendingMatches, so a later "send me Maria's profile
    // again" resolves via resend_caregiver_profile like any other caregiver
    // search — this flow had neither before.
    it("get_callout_backups texts a profile card per candidate and writes pendingMatches", async () => {
      hoisted.docState.set("shifts/sh1", {
        clientId: "c1", caregiverId: "cg1", status: "needs_replacement",
        careRecipients: [{ careNeeds: ["Meal Preparation"] }],
      });
      hoisted.docState.set(`agent_sessions/${PHONE}`, { chatId: "chat-1" });
      hoisted.collState.set("booking_requests", [
        { id: "br1", clientId: "c1", caregiverId: "cg2", caregiverName: "Sam", caregiverPhotoURL: null, rate: 22, status: "accepted", updatedAt: { seconds: 100 } },
      ]);
      const r = await handleToolCall("get_callout_backups", { clientId: "c1", shiftId: "sh1", phone: PHONE }) as any;
      expect(r.success).toBe(true);
      expect(r.count).toBe(1);
      expect(r.caregivers[0]).toMatchObject({ caregiverId: "cg2", name: "Sam", source: "care_team" });
      const sentMsg = sendMessage.mock.calls.find((c: any[]) => c[0] === "chat-1")?.[1] as string;
      expect(sentMsg).toContain("Sam");
      expect(sentMsg).toContain("Tap to view Sam's profile");
      expect(hoisted.updates.find((u) => u.path === `agent_sessions/${PHONE}`)?.data.pendingMatches).toEqual([
        { id: "cg2", name: "Sam", rate: 22 },
      ]);
    });

    it("get_callout_backups requires phone", async () => {
      hoisted.docState.set("shifts/sh1", { clientId: "c1", status: "needs_replacement" });
      const r = await handleToolCall("get_callout_backups", { clientId: "c1", shiftId: "sh1" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("INVALID_INPUT");
    });

    it("get_callout_backups rejects a non-owner (IDOR)", async () => {
      hoisted.docState.set("shifts/sh1", { clientId: "OTHER", status: "needs_replacement" });
      const r = await handleToolCall("get_callout_backups", { clientId: "c1", shiftId: "sh1", phone: PHONE }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("PERMISSION_DENIED");
    });

    it("get_callout_backups refuses a shift that isn't awaiting a replacement", async () => {
      hoisted.docState.set("shifts/sh1", { clientId: "c1", status: "scheduled" });
      const r = await handleToolCall("get_callout_backups", { clientId: "c1", shiftId: "sh1", phone: PHONE }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("INVALID_INPUT");
    });

    // Matches the website's own handleConfirmReplacement EXACTLY: a real NEW
    // booking_requests doc (the candidate gets the normal accept/decline
    // text), NOT an outright reassignment of the original visit.
    it("select_callout_backup sends a new booking request, defaulting to the original visit's own date/time", async () => {
      hoisted.docState.set("shifts/sh1", {
        clientId: "c1", caregiverId: "cg1", status: "needs_replacement",
        date: "2026-09-15", startTime: "09:00", endTime: "13:00", address: "123 Main St", clientName: "The Family",
      });
      hoisted.docState.set("caregivers/cg2", { name: "Sam", hourlyRate: 24 });
      const r = await handleToolCall("select_callout_backup", { clientId: "c1", shiftId: "sh1", backupCaregiverId: "cg2" }) as any;
      expect(r.success).toBe(true);
      expect(r.status).toBe("pending");
      const bookingSet = hoisted.sets.find((s) => s.path.startsWith("booking_requests/"));
      expect(bookingSet?.data).toMatchObject({
        clientId: "c1", caregiverId: "cg2", caregiverName: "Sam",
        isShiftReplacement: true, replacementForShiftId: "sh1", status: "pending",
        schedule: { startDate: "2026-09-15", endDate: "2026-09-15", ongoing: false },
      });
      const newBookingId = bookingSet!.path.split("/").pop();
      expect(hoisted.updates.find((u) => u.path === "shifts/sh1")?.data).toMatchObject({
        replacementRequestId: newBookingId,
        replacementCaregiverName: "Sam",
      });
    });

    it("select_callout_backup honors an explicit different date/time for the replacement", async () => {
      hoisted.docState.set("shifts/sh1", {
        clientId: "c1", status: "needs_replacement", date: "2026-09-15", startTime: "09:00", endTime: "13:00",
      });
      hoisted.docState.set("caregivers/cg2", { name: "Sam" });
      const r = await handleToolCall("select_callout_backup", {
        clientId: "c1", shiftId: "sh1", backupCaregiverId: "cg2", date: "2026-09-16", startTime: "10:00", endTime: "12:00",
      }) as any;
      expect(r.success).toBe(true);
      const bookingSet = hoisted.sets.find((s) => s.path.startsWith("booking_requests/"));
      expect(bookingSet?.data.schedule).toMatchObject({ startDate: "2026-09-16", endDate: "2026-09-16" });
    });

    it("select_callout_backup rejects a non-owner shift", async () => {
      hoisted.docState.set("shifts/sh1", { clientId: "OTHER", status: "needs_replacement" });
      const r = await handleToolCall("select_callout_backup", { clientId: "c1", shiftId: "sh1", backupCaregiverId: "cg2" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("PERMISSION_DENIED");
    });
  });

  describe("referral tools", () => {
    it("send_referral generates a code, persists it, and files a referral", async () => {
      hoisted.docState.set("users/u1", { userType: "client" });
      const r = await handleToolCall("send_referral", { userId: "u1", email: "friend@example.com" }) as any;
      expect(r.success).toBe(true);
      expect(r.referralCode).toMatch(/^[A-Z0-9]{6}$/);
      expect(hoisted.docState.get("users/u1").referralCode).toBe(r.referralCode); // persisted
      expect(hoisted.adds.some((a) => a.path === "referrals")).toBe(true);
    });
    it("send_referral rejects an invalid email", async () => {
      const r = await handleToolCall("send_referral", { userId: "u1", email: "not-an-email" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("INVALID_INPUT");
    });
  });
});
