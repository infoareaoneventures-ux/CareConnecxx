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
  });

  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id?: string) => makeDocRef(`${path}/${id ?? `auto-${sets.length}`}`);
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

const OWNER = "+15555550100";
const CG = "cg1";

describe("pause_account / reactivate_account (U1)", () => {
  beforeEach(() => {
    hoisted.reset();
    hoisted.docState.set(`caregivers/${CG}`, { phone: OWNER, status: "active" });
  });

  describe("pause_account", () => {
    it("pauses until a specific date when the owner asks", async () => {
      const r = await handleToolCall("pause_account", { caregiverId: CG, until: "2026-07-12", phone: OWNER }) as any;
      expect(r.success).toBe(true);
      expect(hoisted.docState.get(`caregivers/${CG}`).pausedUntil).toBe("2026-07-12");
      expect(hoisted.docState.get(`caregivers/${CG}`).pausedAt).toBeTruthy();
    });

    it("maps 'indefinite' to the far-future sentinel", async () => {
      await handleToolCall("pause_account", { caregiverId: CG, until: "indefinite", phone: OWNER });
      expect(hoisted.docState.get(`caregivers/${CG}`).pausedUntil).toBe("2099-12-31");
    });

    it("rejects a non-owner phone (PERMISSION_DENIED), leaving the doc unchanged", async () => {
      const r = await handleToolCall("pause_account", { caregiverId: CG, until: "indefinite", phone: "+19998887777" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("PERMISSION_DENIED");
      expect(hoisted.docState.get(`caregivers/${CG}`).pausedUntil).toBeUndefined();
    });

    it("fails closed when the acting phone is missing", async () => {
      const r = await handleToolCall("pause_account", { caregiverId: CG, until: "indefinite" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("PERMISSION_DENIED");
    });

    it("requires caregiverId and until", async () => {
      expect((await handleToolCall("pause_account", { until: "indefinite", phone: OWNER }) as any)._toolError).toBe(true);
      expect((await handleToolCall("pause_account", { caregiverId: CG, phone: OWNER }) as any)._toolError).toBe(true);
    });

    it("returns NOT_FOUND for an unknown caregiver", async () => {
      const r = await handleToolCall("pause_account", { caregiverId: "ghost", until: "indefinite", phone: OWNER }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("NOT_FOUND");
    });
  });

  describe("reactivate_account", () => {
    it("clears pausedUntil AND pausedAt and stamps reactivatedAt", async () => {
      hoisted.docState.set(`caregivers/${CG}`, { phone: OWNER, pausedUntil: "2099-12-31", pausedAt: "2026-06-01T00:00:00.000Z" });
      const r = await handleToolCall("reactivate_account", { caregiverId: CG, phone: OWNER }) as any;
      expect(r.success).toBe(true);
      const update = hoisted.updates.find(u => u.path === `caregivers/${CG}`)!;
      expect(update.data.pausedUntil).toEqual({ __delete: true });
      expect(update.data.pausedAt).toEqual({ __delete: true });
      expect(update.data.reactivatedAt).toBeTruthy();
    });

    it("rejects a non-owner (PERMISSION_DENIED)", async () => {
      const r = await handleToolCall("reactivate_account", { caregiverId: CG, phone: "+19998887777" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("PERMISSION_DENIED");
    });
  });
});
