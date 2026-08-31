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

// reschedule_appointment now routes through agents/shiftTimeChange → shiftOffer,
// which texts the caregiver a YES/NO offer over Linq — stub the transport.
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
    // Confirmed-action gate (U12) now validates _confirmedActionId against a real
    // pending doc; seed one matching the cancel_appointment bypass calls below.
    hoisted.docState.set("pending_actions/test", { toolName: "cancel_appointment", status: "awaiting", expiresAt: "2999-01-01T00:00:00.000Z" });
    // request_booking now gates on identity/membership (mirrors the website's
    // own paywall) — default client c1 to verified+active so the existing
    // booking-domain tests below keep exercising booking logic, not the gate.
    hoisted.docState.set("users/c1", { identityCheckStatus: "verified", membershipStatus: "active" });
  });

  describe("cancel_appointment", () => {
    it("requires appointmentId + clientId", async () => {
      const r = await handleToolCall("cancel_appointment", { appointmentId: "a1" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("rejects appointments owned by a different client (IDOR)", async () => {
      hoisted.docState.set("appointments/a1", { clientId: "OTHER", status: "confirmed" });
      const r = await handleToolCall("cancel_appointment", { appointmentId: "a1", clientId: "c1" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("PERMISSION_DENIED");
    });

    it("returns INVALID_INPUT for already-cancelled appointment", async () => {
      hoisted.docState.set("appointments/a1", { clientId: "c1", status: "cancelled_by_client" });
      const r = await handleToolCall("cancel_appointment", { appointmentId: "a1", clientId: "c1" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("cancels and returns notification.sent=true when caregiver phone reachable", async () => {
      hoisted.docState.set("appointments/a1", { clientId: "c1", status: "confirmed", caregiverId: "cg1", date: "2026-06-01", caregiverName: "Alice" });
      hoisted.docState.set("caregivers/cg1", { phone: "+15555550101" });
      // _confirmedActionId bypasses the runtime HITL gate so we can test the
      // tool body directly. In production this flag is injected only by
      // approvalHandler after a confirmed YES; tests treat themselves as
      // post-approval execution. See pendingActions.ts.
      const r = await handleToolCall("cancel_appointment", { appointmentId: "a1", clientId: "c1", _confirmedActionId: "test" }) as any;
      expect(r.success).toBe(true);
      expect(r.cancelled).toBe(true);
      expect(r.notification.sent).toBe(true);
      expect(trySend).toHaveBeenCalled();
    });

    it("returns notification.sent=false when caregiver has no phone", async () => {
      hoisted.docState.set("appointments/a1", { clientId: "c1", status: "confirmed", caregiverId: "cg1", date: "2026-06-01" });
      hoisted.docState.set("caregivers/cg1", {});
      const r = await handleToolCall("cancel_appointment", { appointmentId: "a1", clientId: "c1", _confirmedActionId: "test" }) as any;
      expect(r.success).toBe(true);
      expect(r.notification.sent).toBe(false);
      expect(r.notification.reason).toBe("no_caregiver_phone");
    });

    it("returns notification.sent=false when Linq fails (so Evia tells the family)", async () => {
      hoisted.docState.set("appointments/a1", { clientId: "c1", status: "confirmed", caregiverId: "cg1", date: "2026-06-01" });
      hoisted.docState.set("caregivers/cg1", { phone: "+15555550101" });
      trySend.mockResolvedValueOnce({ sent: false, reason: "linq_send_failed", error: "timeout" });
      const r = await handleToolCall("cancel_appointment", { appointmentId: "a1", clientId: "c1", _confirmedActionId: "test" }) as any;
      expect(r.success).toBe(true);          // cancellation succeeded
      expect(r.notification.sent).toBe(false); // but the caregiver wasn't reached
    });
  });

  describe("reschedule_appointment", () => {
    it("requires all four inputs", async () => {
      const r = await handleToolCall("reschedule_appointment", { appointmentId: "a1", clientId: "c1" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("rejects mismatched clientId", async () => {
      hoisted.docState.set("appointments/a1", { clientId: "OTHER", status: "confirmed", caregiverId: "cg1" });
      const r = await handleToolCall("reschedule_appointment", { appointmentId: "a1", clientId: "c1", newDate: "2026-06-02", newTime: "10:00" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("PERMISSION_DENIED");
    });

    it("rejects rescheduling completed/cancelled appointments", async () => {
      hoisted.docState.set("appointments/a1", { clientId: "c1", status: "completed", caregiverId: "cg1" });
      const r = await handleToolCall("reschedule_appointment", { appointmentId: "a1", clientId: "c1", newDate: "2026-06-02", newTime: "10:00" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("does NOT move the appointment — stamps pendingTimeChange and sends a caregiver offer", async () => {
      hoisted.docState.set("appointments/a1", { clientId: "c1", status: "confirmed", caregiverId: "cg1", caregiverName: "Alice", date: "2026-06-01", startTime: "09:00", endTime: "11:00", durationHours: 2 });
      hoisted.docState.set("caregivers/cg1", { phone: "+15555550101" });
      const r = await handleToolCall("reschedule_appointment", { appointmentId: "a1", clientId: "c1", newDate: "2026-06-02", newTime: "10:00" }) as any;
      expect(r.success).toBe(true);
      expect(r.status).toBe("pending_caregiver_confirmation");

      // Appointment keeps its original schedule until the caregiver accepts
      const appt = hoisted.docState.get("appointments/a1");
      expect(appt.date).toBe("2026-06-01");
      expect(appt.startTime).toBe("09:00");
      expect(appt.pendingTimeChange).toMatchObject({ newDate: "2026-06-02", newStartTime: "10:00" });

      // A shift offer was created and the caregiver was texted a YES/NO prompt
      const offerAdd = hoisted.adds.find((a) => a.path === "shift_offers");
      expect(offerAdd).toBeTruthy();
      expect(offerAdd!.data.kind).toBe("time_change");
      expect(offerAdd!.data.status).toBe("pending");
      expect(sendMessage).toHaveBeenCalledWith("chat-cg", expect.stringContaining("Reply YES"));
    });

    it("applies directly (with admin alert) when the caregiver has no phone", async () => {
      hoisted.docState.set("appointments/a1", { clientId: "c1", status: "confirmed", caregiverId: "cg1", date: "2026-06-01", startTime: "09:00", durationHours: 2 });
      hoisted.docState.set("caregivers/cg1", {});
      const r = await handleToolCall("reschedule_appointment", { appointmentId: "a1", clientId: "c1", newDate: "2026-06-02", newTime: "10:00" }) as any;
      expect(r.success).toBe(true);
      expect(r.status).toBe("applied_directly");
      expect(hoisted.docState.get("appointments/a1").date).toBe("2026-06-02");
      expect(hoisted.adds.some((a) => a.path === "admin_alerts" && a.data.type === "time_change_unconfirmed")).toBe(true);
    });
  });

  // U6: confirmed money-moving tools route through the idempotency ledger; a
  // cached claim short-circuits before the tool body runs.
  describe("confirmed-action idempotency wiring", () => {
    beforeEach(() => {
      ledger.claimToolExecution.mockClear();
      ledger.claimToolExecution.mockResolvedValue({ cached: false } as any);
    });

    it("a confirmed irreversible tool routes through the ledger; a cached claim short-circuits the body", async () => {
      // cached:true so the (slow, real) web-action body never runs — we assert
      // the wiring: the ledger is consulted with a tool-scoped key, and its
      // cached result is returned verbatim.
      ledger.claimToolExecution.mockResolvedValue({ cached: true, result: { success: true, cached: true } } as any);
      const previousFlag = process.env.FEATURE_REAL_WORLD_HEALTHCARE_ACTIONS;
      process.env.FEATURE_REAL_WORLD_HEALTHCARE_ACTIONS = "true";
      try {
        const result = await handleToolCall("perform_web_action", {
          _confirmedActionId: "pa_1", phone: "+15125550123", userId: "u1", loginAction: "pharmacy_refill",
        });
        expect(ledger.claimToolExecution).toHaveBeenCalledTimes(1);
        expect(ledger.claimToolExecution.mock.calls[0][0]).toContain("perform_web_action");
        expect(result).toEqual({ success: true, cached: true });
      } finally {
        if (previousFlag === undefined) delete process.env.FEATURE_REAL_WORLD_HEALTHCARE_ACTIONS;
        else process.env.FEATURE_REAL_WORLD_HEALTHCARE_ACTIONS = previousFlag;
      }
    });

    it("a non-idempotent confirmed tool (cancel_appointment) does NOT consult the ledger", async () => {
      await handleToolCall("cancel_appointment", {
        _confirmedActionId: "pa_2", phone: "+15125550123", appointmentId: "a1", clientId: "c1",
      }).catch(() => {});
      expect(ledger.claimToolExecution).not.toHaveBeenCalled();
    });
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

  describe("quote_booking (U9b)", () => {
    it("computes per-visit hours, line items, and a multi-date total without booking", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: 30 });
      const r = await handleToolCall("quote_booking", {
        caregiverId: "cg1",
        clientId:    "c1",
        dates:       ["2026-07-01", "2026-07-02"],
        startTime:   "09:00",
        endTime:     "17:00", // 8h
      }) as any;
      expect(r.success).toBe(true);
      expect(r.committed).toBe(false);
      expect(r.durationHours).toBe(8);
      expect(r.lineItems).toHaveLength(2);
      expect(r.lineItems[0]).toEqual({ date: "2026-07-01", hours: 8, amount: 240 });
      expect(r.totalEstimate).toBe(480); // 8h * $30 * 2 days
      // No write — quoting must not create a booking task.
      expect(hoisted.adds.length).toBe(0);
    });

    it("accepts a single date (not wrapped in an array)", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: 20 });
      const r = await handleToolCall("quote_booking", {
        caregiverId: "cg1", dates: "2026-07-01", startTime: "10:00", endTime: "12:00", // 2h
      }) as any;
      expect(r.success).toBe(true);
      expect(r.totalEstimate).toBe(40);
    });

    it("rejects an end time at or before the start time", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: 20 });
      const r = await handleToolCall("quote_booking", {
        caregiverId: "cg1", dates: ["2026-07-01"], startTime: "17:00", endTime: "09:00",
      }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("INVALID_INPUT");
    });

    it("returns NOT_FOUND when the caregiver doesn't exist", async () => {
      const r = await handleToolCall("quote_booking", {
        caregiverId: "ghost", dates: ["2026-07-01"], startTime: "09:00", endTime: "10:00",
      }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("NOT_FOUND");
    });

    it('quotes with a coerced legacy string rate ("25") exactly like a numeric 25', async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: "25" });
      const r = await handleToolCall("quote_booking", {
        caregiverId: "cg1", dates: "2026-07-01", startTime: "10:00", endTime: "12:00", // 2h
      }) as any;
      expect(r.success).toBe(true);
      expect(r.hourlyRate).toBe(25);
      expect(r.totalEstimate).toBe(50); // 2h * $25
      expect(hoisted.adds.length).toBe(0); // still no write
    });

    // U6 (R9): a quote must never be built on a fabricated $20 either — the
    // quote and the eventual booking share one rate resolver, and both refuse.
    it("returns RATE_UNKNOWN instead of quoting a fabricated $20 when no rate is on file", async () => {
      hoisted.docState.set("caregivers/cg3", { name: "Pat" });
      const r = await handleToolCall("quote_booking", {
        caregiverId: "cg3", dates: ["2026-07-01"], startTime: "09:00", endTime: "10:00",
      }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("RATE_UNKNOWN");
    });
  });

  // ── U9b: request_booking now commits via the SAME quote primitive ────────────
  describe("request_booking (U9b — commit path shares buildBookingQuote)", () => {
    const baseInput = {
      clientId: "c1", phone: "+15555550100", caregiverId: "cg1",
      dates: ["2026-07-01", "2026-07-02"], startTime: "09:00", endTime: "17:00", // 8h
    };

    it("commits the booking with the quote's computed rate/duration and returns the estimate", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: 30 });
      const r = await handleToolCall("request_booking", baseInput) as any;
      expect(r.success).toBe(true);
      expect(r.taskId).toBe("task-123");
      expect(r.status).toBe("awaiting_approval");
      expect(r.estimatedTotal).toBe(480); // 8h * $30 * 2 days — same math as quote_booking
      // Delegated to createBookingTask with the quote-derived values.
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

      const r = await handleToolCall("request_booking", { ...baseInput, interviewId: "iv1" }) as any;
      expect(r.success).toBe(true);
      const arg = createBookingTask.mock.calls[0][0] as any;
      expect(arg.interviewId).toBe("iv1");
      expect(arg.jobId).toBe("job1");
      expect(arg.jobTitle).toBe("Weekend companionship");
      expect(arg.applicationId).toBe("app1");
    });

    it("an interviewId that doesn't belong to this client/caregiver books unlinked instead of failing", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: 30 });
      hoisted.docState.set("video_interviews/iv1", { clientId: "someone_else", caregiverId: "cg1", applicationId: "app1" });

      const r = await handleToolCall("request_booking", { ...baseInput, interviewId: "iv1" }) as any;
      expect(r.success).toBe(true);
      const arg = createBookingTask.mock.calls[0][0] as any;
      expect(arg.jobId).toBeUndefined();
      expect(arg.jobTitle).toBeUndefined();
      expect(arg.applicationId).toBeUndefined();
    });

    it("booking with no interviewId at all stays unlinked (direct/matching-flow booking)", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: 30 });
      const r = await handleToolCall("request_booking", baseInput) as any;
      expect(r.success).toBe(true);
      const arg = createBookingTask.mock.calls[0][0] as any;
      expect(arg.interviewId).toBeUndefined();
      expect(arg.jobId).toBeUndefined();
      expect(arg.applicationId).toBeUndefined();
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
    it("returns a structured ask-for-rate error (RATE_UNKNOWN) instead of booking at a silent $20", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria" }); // no hourlyRate
      const r = await handleToolCall("request_booking", baseInput) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("RATE_UNKNOWN");
      expect(r.message).toMatch(/confirm/i);
      expect(r.message).toMatch(/rate/i);
      expect(createBookingTask).not.toHaveBeenCalled();
    });

    it("a non-numeric hourlyRate is treated as unknown (no coerced booking)", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: "flexible" });
      const r = await handleToolCall("request_booking", baseInput) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("RATE_UNKNOWN");
      expect(createBookingTask).not.toHaveBeenCalled();
    });

    // Legacy string rates: a doc carrying hourlyRate "$27.50" (raw user text
    // written straight through) must book exactly as if it were 27.5 — same
    // quote math, same createBookingTask payload, agreement preserved.
    it('books with a coerced legacy "$27.50" string rate exactly like 27.5', async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: "$27.50" });
      const r = await handleToolCall("request_booking", baseInput) as any;
      expect(r.success).toBe(true);
      expect(r.estimatedTotal).toBe(440); // 8h * $27.50 * 2 days
      expect(createBookingTask).toHaveBeenCalledTimes(1);
      const arg = createBookingTask.mock.calls[0][0] as any;
      expect(arg.hourlyRate).toBe(27.5);
    });

    it("surfaces a blocked booking (e.g. pending background check) without erroring", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Maria", hourlyRate: 30 });
      createBookingTask.mockResolvedValueOnce(""); // executor blocked it + already messaged the family
      const r = await handleToolCall("request_booking", baseInput) as any;
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

  describe("caregiver-callout tools", () => {
    it("get_callout_backups returns stored options for the owner", async () => {
      hoisted.docState.set("appointments/a9", { clientId: "c1", backupCaregiverOptions: [{ id: "cg2", name: "Sam" }] });
      const r = await handleToolCall("get_callout_backups", { clientId: "c1", appointmentId: "a9" }) as any;
      expect(r.success).toBe(true);
      expect(r.count).toBe(1);
    });
    it("get_callout_backups rejects a non-owner (IDOR)", async () => {
      hoisted.docState.set("appointments/a9", { clientId: "OTHER", backupCaregiverOptions: [] });
      const r = await handleToolCall("get_callout_backups", { clientId: "c1", appointmentId: "a9" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("PERMISSION_DENIED");
    });
    it("select_callout_backup reassigns the appointment to the chosen caregiver", async () => {
      hoisted.docState.set("appointments/a9", { clientId: "c1", caregiverId: "cg1" });
      hoisted.docState.set("caregivers/cg2", { name: "Sam" });
      const r = await handleToolCall("select_callout_backup", { clientId: "c1", appointmentId: "a9", backupCaregiverId: "cg2" }) as any;
      expect(r.success).toBe(true);
      expect(r.caregiverId).toBe("cg2");
      expect(hoisted.docState.get("appointments/a9").caregiverId).toBe("cg2");
      expect(hoisted.docState.get("appointments/a9").status).toBe("confirmed");
    });
    it("request_callout_refund files a refund request for the owner", async () => {
      hoisted.docState.set("appointments/a9", { clientId: "c1", amount: 120 });
      const r = await handleToolCall("request_callout_refund", { clientId: "c1", appointmentId: "a9", reason: "no backup" }) as any;
      expect(r.success).toBe(true);
      expect(r.status).toBe("pending");
      expect(hoisted.adds.some((a) => a.path === "refundRequests")).toBe(true);
      expect(hoisted.docState.get("appointments/a9").status).toBe("cancelled_refund_requested");
    });
  });

  describe("update_reminder (CRUD)", () => {
    it("updates an owned reminder's fields", async () => {
      hoisted.docState.set("user_triggers/t1", { phone: "+15555550100", active: true, recurrence: "daily", hour: 9, minute: 0, label: "meds", message: "take meds" });
      const r = await handleToolCall("update_reminder", { phone: "+15555550100", triggerId: "t1", hour: 8, label: "morning meds" }) as any;
      expect(r.success).toBe(true);
      expect(hoisted.docState.get("user_triggers/t1").hour).toBe(8);
      expect(hoisted.docState.get("user_triggers/t1").label).toBe("morning meds");
    });
    it("rejects updating a reminder owned by another phone (NOT_FOUND)", async () => {
      hoisted.docState.set("user_triggers/t1", { phone: "+1OTHER", active: true, recurrence: "daily", hour: 9, minute: 0 });
      const r = await handleToolCall("update_reminder", { phone: "+15555550100", triggerId: "t1", hour: 8 }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("NOT_FOUND");
    });
    it("requires at least one field to update", async () => {
      const r = await handleToolCall("update_reminder", { phone: "+15555550100", triggerId: "t1" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("INVALID_INPUT");
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
