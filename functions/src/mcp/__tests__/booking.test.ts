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
      const result = await handleToolCall("perform_web_action", {
        _confirmedActionId: "pa_1", phone: "+15125550123", userId: "u1", loginAction: "pharmacy_refill",
      });
      expect(ledger.claimToolExecution).toHaveBeenCalledTimes(1);
      expect(ledger.claimToolExecution.mock.calls[0][0]).toContain("perform_web_action");
      expect(result).toEqual({ success: true, cached: true });
    });

    it("a non-idempotent confirmed tool (cancel_appointment) does NOT consult the ledger", async () => {
      await handleToolCall("cancel_appointment", {
        _confirmedActionId: "pa_2", phone: "+15125550123", appointmentId: "a1", clientId: "c1",
      }).catch(() => {});
      expect(ledger.claimToolExecution).not.toHaveBeenCalled();
    });
  });
});
