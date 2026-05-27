import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const docState  = new Map<string, any>();
  const collState = new Map<string, any[]>();
  const sets:    Array<{ path: string; data: any; opts?: any }> = [];
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
  });

  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id?: string) => makeDocRef(`${path}/${id ?? `auto-${sets.length}`}`);
    ref.where   = (..._a: any[]) => ref;
    ref.orderBy = (..._a: any[]) => ref;
    ref.limit   = (..._a: any[]) => ref;
    ref.get = vi.fn(async () => {
      const items = collState.get(path) ?? [];
      return { empty: items.length === 0, size: items.length, docs: items.map((d: any, i: number) => ({ id: d.id ?? `doc-${i}`, data: () => d, ref: makeDocRef(`${path}/${d.id ?? `doc-${i}`}`) })) };
    });
    return ref;
  };

  return {
    docState, collState, sets, updates,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); collState.clear(); sets.length = 0; updates.length = 0; },
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

vi.mock("../../agents/familyGroupManager", () => ({
  buildOrUpdateFamilyGroup: vi.fn().mockResolvedValue(undefined),
  removeMemberFromGroup:    vi.fn().mockResolvedValue({ removed: true }),
}));

const trySend = vi.fn().mockResolvedValue({ sent: true });
vi.mock("../../utils/toolNotify", () => ({
  trySend:        (...args: unknown[]) => trySend(...args),
  trySendViaCara: vi.fn().mockResolvedValue({ sent: true }),
}));

import { handleToolCall } from "../server";

describe("family tools", () => {
  beforeEach(() => { hoisted.reset(); trySend.mockClear(); trySend.mockResolvedValue({ sent: true }); });

  describe("add_family_member", () => {
    it("requires all fields", async () => {
      const r = await handleToolCall("add_family_member", { seniorId: "s1", clientId: "c1" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("rejects when senior belongs to a different client (IDOR)", async () => {
      hoisted.docState.set("senior_profiles/s1", { userId: "OTHER" });
      const r = await handleToolCall("add_family_member", { seniorId: "s1", name: "Aunt Mae", phone: "+15555550111", clientId: "c1" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("PERMISSION_DENIED");
    });

    it("rejects duplicate phone in family group", async () => {
      hoisted.docState.set("senior_profiles/s1", { userId: "c1", familyMembers: [{ phone: "+15555550111" }] });
      const r = await handleToolCall("add_family_member", { seniorId: "s1", name: "Aunt Mae", phone: "+15555550111", clientId: "c1" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("adds member and sends welcome SMS, surfacing notification status", async () => {
      hoisted.docState.set("senior_profiles/s1", { userId: "c1", familyMembers: [] });
      const r = await handleToolCall("add_family_member", { seniorId: "s1", name: "Aunt Mae", phone: "+15555550111", clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.added).toBe(true);
      expect(r.notification.sent).toBe(true);
      expect(trySend).toHaveBeenCalledWith("+15555550111", expect.stringContaining("CareConnex care group"), "mcp:add_family_member");
    });

    it("surfaces notification.sent=false when welcome SMS fails", async () => {
      hoisted.docState.set("senior_profiles/s1", { userId: "c1", familyMembers: [] });
      trySend.mockResolvedValueOnce({ sent: false, reason: "linq_send_failed" });
      const r = await handleToolCall("add_family_member", { seniorId: "s1", name: "Aunt Mae", phone: "+15555550111", clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.added).toBe(true);
      expect(r.notification.sent).toBe(false);
    });
  });

  describe("remove_family_member", () => {
    it("requires all fields", async () => {
      const r = await handleToolCall("remove_family_member", { seniorId: "s1" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("rejects when senior belongs to different client", async () => {
      hoisted.docState.set("senior_profiles/s1", { userId: "OTHER" });
      const r = await handleToolCall("remove_family_member", { seniorId: "s1", phone: "+15555550111", clientId: "c1" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("removes member and notifies them they were removed", async () => {
      hoisted.docState.set("senior_profiles/s1", { userId: "c1", familyMembers: [{ phone: "+15555550111", name: "Aunt Mae" }] });
      const r = await handleToolCall("remove_family_member", { seniorId: "s1", phone: "+15555550111", clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.notification.sent).toBe(true);
      expect(trySend).toHaveBeenCalledWith("+15555550111", expect.stringContaining("removed from"), "mcp:remove_family_member");
    });
  });
});
