import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const docState  = new Map<string, any>();
  const collState = new Map<string, any[]>();
  const sets:    Array<{ path: string; data: any; opts?: any }> = [];
  const adds:    Array<{ path: string; data: any; id: string }> = [];

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
    docState, collState, sets, adds,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); collState.clear(); sets.length = 0; adds.length = 0; },
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

describe("communication tools", () => {
  beforeEach(() => { hoisted.reset(); trySend.mockClear(); trySend.mockResolvedValue({ sent: true }); });

  describe("send_client_message (IDOR-protected)", () => {
    it("requires caregiverId + message", async () => {
      const r = await handleToolCall("send_client_message", { caregiverId: "cg1" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("blocks caregivers with no active or recent engagement", async () => {
      // No appointments — caregiver should be blocked
      const r = await handleToolCall("send_client_message", { caregiverId: "cg1", message: "hi" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("FORBIDDEN");
    });

    it("allows when caregiver has a CONFIRMED appointment with the explicit clientId", async () => {
      hoisted.collState.set("appointments", [
        { caregiverId: "cg1", clientId: "c1", status: "confirmed", date: "2026-06-01" },
      ]);
      hoisted.docState.set("users/c1", { phone: "+15555550100" });
      hoisted.docState.set("caregivers/cg1", { name: "Alice" });
      const r = await handleToolCall("send_client_message", { caregiverId: "cg1", message: "hi", clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.sent).toBe(true);
      expect(r.notification.sent).toBe(true);
      expect(trySend).toHaveBeenCalledWith("+15555550100", "Alice: hi", "mcp:send_client_message");
    });

    it("blocks an explicit clientId when no relationship exists", async () => {
      // collState is empty for appointments — no relationship
      hoisted.docState.set("users/c1", { phone: "+15555550100" });
      hoisted.docState.set("caregivers/cg1", { name: "Alice" });
      const r = await handleToolCall("send_client_message", { caregiverId: "cg1", message: "hi", clientId: "c1" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("FORBIDDEN");
    });

    it("surfaces notification.sent=false when Linq send fails", async () => {
      hoisted.collState.set("appointments", [
        { caregiverId: "cg1", clientId: "c1", status: "confirmed", date: "2026-06-01" },
      ]);
      hoisted.docState.set("users/c1", { phone: "+15555550100" });
      hoisted.docState.set("caregivers/cg1", { name: "Alice" });
      trySend.mockResolvedValueOnce({ sent: false, reason: "linq_send_failed" });
      const r = await handleToolCall("send_client_message", { caregiverId: "cg1", message: "hi", clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.notification.sent).toBe(false);
    });
  });

  describe("send_caregiver_message", () => {
    it("requires caregiverId + message", async () => {
      const r = await handleToolCall("send_caregiver_message", {}) as any;
      expect(r._toolError).toBe(true);
    });

    it("returns NOT_FOUND if caregiver doc missing", async () => {
      const r = await handleToolCall("send_caregiver_message", { caregiverId: "ghost", message: "hi", clientId: "c1" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("returns NOT_FOUND if caregiver has no phone", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Alice" });
      const r = await handleToolCall("send_caregiver_message", { caregiverId: "cg1", message: "hi", clientId: "c1" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("sends and returns notification status", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Alice", phone: "+15555550101" });
      const r = await handleToolCall("send_caregiver_message", { caregiverId: "cg1", message: "she napped well", clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.notification.sent).toBe(true);
      expect(r.sent).toBe(true);
    });

    it("surfaces notification failure", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Alice", phone: "+15555550101" });
      trySend.mockResolvedValueOnce({ sent: false, reason: "linq_send_failed" });
      const r = await handleToolCall("send_caregiver_message", { caregiverId: "cg1", message: "hi", clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.sent).toBe(false);
      expect(r.notification.sent).toBe(false);
    });
  });
});
