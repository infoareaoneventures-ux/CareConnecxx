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
      const prev = docState.get(path) ?? {};
      docState.set(path, opts?.merge ? { ...prev, ...data } : data);
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

import { handleToolCall } from "../server";

describe("discovery tools", () => {
  beforeEach(() => hoisted.reset());

  describe("get_caregiver_reviews", () => {
    it("requires caregiverId", async () => {
      const r = await handleToolCall("get_caregiver_reviews", {}) as any;
      expect(r._toolError).toBe(true);
    });

    it("returns recent reviews + average rating", async () => {
      hoisted.collState.set("reviews", [
        { rating: 5, comment: "Great with my dad", createdAt: "2026-05-01" },
        { rating: 4, comment: "Punctual and kind",  createdAt: "2026-04-15" },
      ]);
      hoisted.docState.set("caregivers/cg1", { name: "Alice", averageRating: 4.7, reviewCount: 12 });
      const r = await handleToolCall("get_caregiver_reviews", { caregiverId: "cg1" }) as any;
      expect(r.success).toBe(true);
      expect(r.caregiverName).toBe("Alice");
      expect(r.averageRating).toBe(4.7);
      expect(r.recentReviews).toHaveLength(2);
    });
  });

  describe("save_caregiver_favorite", () => {
    it("requires both ids", async () => {
      const r = await handleToolCall("save_caregiver_favorite", { clientId: "c1" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("returns NOT_FOUND if caregiver doesn't exist", async () => {
      const r = await handleToolCall("save_caregiver_favorite", { clientId: "c1", caregiverId: "ghost" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("NOT_FOUND");
    });

    it("arrayUnions the caregiver into savedCaregiverIds", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Alice" });
      const r = await handleToolCall("save_caregiver_favorite", { clientId: "c1", caregiverId: "cg1" }) as any;
      expect(r.success).toBe(true);
      expect(r.saved).toBe(true);
      const userSet = hoisted.sets.find(s => s.path === "users/c1");
      expect(userSet?.data.savedCaregiverIds).toEqual({ __arrayUnion: ["cg1"] });
    });
  });

  describe("unsave_caregiver_favorite", () => {
    it("arrayRemoves the caregiver", async () => {
      const r = await handleToolCall("unsave_caregiver_favorite", { clientId: "c1", caregiverId: "cg1" }) as any;
      expect(r.success).toBe(true);
      const userSet = hoisted.sets.find(s => s.path === "users/c1");
      expect(userSet?.data.savedCaregiverIds).toEqual({ __arrayRemove: ["cg1"] });
    });
  });

  describe("list_saved_caregivers", () => {
    it("returns empty list when no favorites", async () => {
      hoisted.docState.set("users/c1", { savedCaregiverIds: [] });
      const r = await handleToolCall("list_saved_caregivers", { clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.count).toBe(0);
    });

    it("hydrates favorites from caregivers collection", async () => {
      hoisted.docState.set("users/c1", { savedCaregiverIds: ["cg1", "cg2"] });
      hoisted.docState.set("caregivers/cg1", { name: "Alice", hourlyRate: 25, averageRating: 4.8, specialties: ["dementia"] });
      hoisted.docState.set("caregivers/cg2", { name: "Bob",   hourlyRate: 28, averageRating: 4.5, specialties: ["mobility"] });
      const r = await handleToolCall("list_saved_caregivers", { clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.count).toBe(2);
      expect(r.caregivers[0].name).toBe("Alice");
      expect(r.caregivers[1].rating).toBe(4.5);
    });
  });
});
