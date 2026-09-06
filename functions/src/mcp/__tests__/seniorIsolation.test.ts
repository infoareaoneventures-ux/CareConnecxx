// Guards senior-data isolation: a client may only read/update the senior
// profile they own (senior_profiles.userId), and only whitelisted fields are
// updatable through the MCP surface.

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

vi.mock("../../utils/toolNotify", () => ({
  trySend:        vi.fn().mockResolvedValue({ sent: true }),
  trySendViaCara: vi.fn().mockResolvedValue({ sent: true }),
}));

import { handleToolCall } from "../server";

describe("senior data isolation (PHI read tools)", () => {
  beforeEach(() => hoisted.reset());

  it("get_senior_profile denies a client reading another household's senior", async () => {
    hoisted.docState.set("senior_profiles/s1", { userId: "OTHER_CLIENT", name: "Mary" });
    hoisted.docState.set("seniors/s1", { name: "Mary", diagnoses: ["dementia"] });
    const r = await handleToolCall("get_senior_profile", { seniorId: "s1", clientId: "c1" }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("PERMISSION_DENIED");
    // The PHI itself must not leak in the denied response.
    expect(r.results).toBeUndefined();
  });

  it("get_senior_profile allows the owning client", async () => {
    // Profile data lives on senior_profiles (the authorized + primary read source).
    hoisted.docState.set("senior_profiles/s1", { userId: "c1", name: "Mary", diagnoses: ["dementia"] });
    const r = await handleToolCall("get_senior_profile", { seniorId: "s1", clientId: "c1" }) as any;
    expect(r.success).toBe(true);
    expect(r.results?.name).toBe("Mary");
  });

  it("get_care_journal denies cross-tenant access", async () => {
    hoisted.docState.set("senior_profiles/s1", { userId: "OTHER_CLIENT" });
    hoisted.collState.set("care_journal", [{ seniorId: "s1", notes: "private" }]);
    const r = await handleToolCall("get_care_journal", { seniorId: "s1", clientId: "c1" }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("PERMISSION_DENIED");
    expect(r.results).toBeUndefined();
  });

  it("get_care_journal allows the owning client", async () => {
    hoisted.docState.set("senior_profiles/s1", { userId: "c1" });
    hoisted.collState.set("care_journal", [{ seniorId: "s1", notes: "ate well today", timestamp: "2026-01-01T00:00:00Z" }]);
    const r = await handleToolCall("get_care_journal", { seniorId: "s1", clientId: "c1" }) as any;
    expect(r.success).toBe(true);
    expect(r.results).toBeDefined();
  });


  it("allows the owning client of a migrated household senior (clientId back-reference, no userId)", async () => {
    // migrateSeniorsToHousehold writes clientId but no userId — the gate must
    // recognize clientId as the owner so the rightful client keeps access.
    hoisted.docState.set("senior_profiles/random-id", { clientId: "c1", name: "Mary" });
    hoisted.docState.set("seniors/random-id", { name: "Mary", diagnoses: ["dementia"] });
    const r = await handleToolCall("get_senior_profile", { seniorId: "random-id", clientId: "c1" }) as any;
    expect(r.success).toBe(true);
    expect(r.results?.name).toBe("Mary");
  });

  it("denies a migrated household senior to a non-owning client", async () => {
    hoisted.docState.set("senior_profiles/random-id", { clientId: "OTHER_CLIENT", name: "Mary" });
    hoisted.docState.set("seniors/random-id", { name: "Mary", diagnoses: ["dementia"] });
    const r = await handleToolCall("get_senior_profile", { seniorId: "random-id", clientId: "c1" }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("PERMISSION_DENIED");
    expect(r.results).toBeUndefined();
  });

  it("fails closed for an owner-less senior whose id is not the requesting client", async () => {
    // No userId AND no clientId recorded, and seniorId !== clientId → deny.
    // Closes the prior gap where any client could read an unowned senior's PHI.
    hoisted.docState.set("senior_profiles/s1", { name: "Mary" });
    hoisted.docState.set("seniors/s1", { name: "Mary", diagnoses: ["dementia"] });
    const r = await handleToolCall("get_senior_profile", { seniorId: "s1", clientId: "c1" }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("PERMISSION_DENIED");
    expect(r.results).toBeUndefined();
  });

  it("allows the legacy self-owned senior (profile keyed by the client's own uid)", async () => {
    // Legacy single-senior model: the profile doc id IS the client uid and has
    // no owner field. The rightful owner (seniorId === clientId) keeps access.
    hoisted.docState.set("seniors/c1", { name: "Mary" });
    const r = await handleToolCall("get_senior_profile", { seniorId: "c1", clientId: "c1" }) as any;
    expect(r.success).toBe(true);
    expect(r.results?.name).toBe("Mary");
  });
});
