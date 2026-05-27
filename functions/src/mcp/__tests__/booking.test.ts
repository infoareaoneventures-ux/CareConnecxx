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

import { handleToolCall } from "../server";

describe("booking tools", () => {
  beforeEach(() => { hoisted.reset(); trySend.mockClear(); trySend.mockResolvedValue({ sent: true }); });

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
      const r = await handleToolCall("cancel_appointment", { appointmentId: "a1", clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.cancelled).toBe(true);
      expect(r.notification.sent).toBe(true);
      expect(trySend).toHaveBeenCalled();
    });

    it("returns notification.sent=false when caregiver has no phone", async () => {
      hoisted.docState.set("appointments/a1", { clientId: "c1", status: "confirmed", caregiverId: "cg1", date: "2026-06-01" });
      hoisted.docState.set("caregivers/cg1", {});
      const r = await handleToolCall("cancel_appointment", { appointmentId: "a1", clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.notification.sent).toBe(false);
      expect(r.notification.reason).toBe("no_caregiver_phone");
    });

    it("returns notification.sent=false when Linq fails (so Cara tells the family)", async () => {
      hoisted.docState.set("appointments/a1", { clientId: "c1", status: "confirmed", caregiverId: "cg1", date: "2026-06-01" });
      hoisted.docState.set("caregivers/cg1", { phone: "+15555550101" });
      trySend.mockResolvedValueOnce({ sent: false, reason: "linq_send_failed", error: "timeout" });
      const r = await handleToolCall("cancel_appointment", { appointmentId: "a1", clientId: "c1" }) as any;
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

    it("reschedules and notifies caregiver", async () => {
      hoisted.docState.set("appointments/a1", { clientId: "c1", status: "confirmed", caregiverId: "cg1", date: "2026-06-01", startTime: "09:00", durationHours: 2 });
      hoisted.docState.set("caregivers/cg1", { phone: "+15555550101" });
      const r = await handleToolCall("reschedule_appointment", { appointmentId: "a1", clientId: "c1", newDate: "2026-06-02", newTime: "10:00" }) as any;
      expect(r.success).toBe(true);
      expect(r.newDate).toBe("2026-06-02");
      expect(r.notification.sent).toBe(true);
    });
  });
});
