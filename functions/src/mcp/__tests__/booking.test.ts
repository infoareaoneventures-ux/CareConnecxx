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

import { handleToolCall } from "../server";

describe("booking tools", () => {
  beforeEach(() => {
    hoisted.reset(); trySend.mockClear(); trySend.mockResolvedValue({ sent: true });
    // Confirmed-action gate (U12) now validates _confirmedActionId against a real
    // pending doc; seed one matching the cancel_appointment bypass calls below.
    hoisted.docState.set("pending_actions/test", { toolName: "cancel_appointment", status: "awaiting", expiresAt: "2999-01-01T00:00:00.000Z" });
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

    it("returns notification.sent=false when Linq fails (so Cara tells the family)", async () => {
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

  // ── U9b: read-only booking primitives extracted from request_booking ─────────
  // These must NEVER write — the whole point is that Cara can look up a rate and
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

    it("falls back to $20 when the caregiver has no rate on file", async () => {
      hoisted.docState.set("caregivers/cg2", { name: "Sam" });
      const r = await handleToolCall("get_caregiver_booking_rate", { caregiverId: "cg2" }) as any;
      expect(r.success).toBe(true);
      expect(r.hourlyRate).toBe(20);
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
  });
});
