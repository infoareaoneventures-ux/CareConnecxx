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

import { handleToolCall } from "../server";

describe("safety tools", () => {
  beforeEach(() => hoisted.reset());

  describe("block_user", () => {
    it("requires both ids", async () => {
      const r = await handleToolCall("block_user", { userId: "u1" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("refuses self-block", async () => {
      const r = await handleToolCall("block_user", { userId: "u1", targetUserId: "u1" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("arrayUnions target + creates admin_alert", async () => {
      const r = await handleToolCall("block_user", { userId: "u1", targetUserId: "u2", reason: "spam" }) as any;
      expect(r.success).toBe(true);
      expect(r.blocked).toBe(true);
      const userSet = hoisted.sets.find(s => s.path === "users/u1");
      expect(userSet?.data.blockedUsers).toEqual({ __arrayUnion: ["u2"] });
      const alert = hoisted.adds.find(a => a.path === "admin_alerts");
      expect(alert?.data.type).toBe("user_blocked");
      expect(alert?.data.severity).toBe("medium");
    });
  });

  describe("unblock_user", () => {
    it("arrayRemoves target", async () => {
      const r = await handleToolCall("unblock_user", { userId: "u1", targetUserId: "u2" }) as any;
      expect(r.success).toBe(true);
      const userSet = hoisted.sets.find(s => s.path === "users/u1");
      expect(userSet?.data.blockedUsers).toEqual({ __arrayRemove: ["u2"] });
    });
  });

  describe("report_user", () => {
    it("requires all fields", async () => {
      const r = await handleToolCall("report_user", { userId: "u1", targetUserId: "u2", category: "harassment" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("rejects unknown category", async () => {
      const r = await handleToolCall("report_user", { userId: "u1", targetUserId: "u2", category: "made-up", description: "x" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("creates a report doc + admin_alert, tells user 24h follow-up", async () => {
      const r = await handleToolCall("report_user", {
        userId: "u1", targetUserId: "u2",
        category: "harassment", description: "Sent abusive messages",
      }) as any;
      expect(r.success).toBe(true);
      expect(r.reported).toBe(true);
      expect(r.followUpWindow).toBe("24h");
      const report = hoisted.adds.find(a => a.path === "reports");
      expect(report?.data.category).toBe("harassment");
      expect(report?.data.status).toBe("open");
      const alert = hoisted.adds.find(a => a.path === "admin_alerts");
      expect(alert?.data.type).toBe("user_reported");
    });

    it("truncates extremely long descriptions to 2000 chars", async () => {
      const longDesc = "x".repeat(5000);
      const r = await handleToolCall("report_user", {
        userId: "u1", targetUserId: "u2",
        category: "other", description: longDesc,
      }) as any;
      expect(r.success).toBe(true);
      const report = hoisted.adds.find(a => a.path === "reports");
      expect((report?.data.description as string).length).toBeLessThanOrEqual(2000);
    });
  });
});
