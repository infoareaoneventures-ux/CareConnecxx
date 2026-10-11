// Caregiver reads of a family's data (2026-10-11, caregiver sweep E4/E5).
//
// get_senior_profile used to compare the senior's owning client against the
// CAREGIVER's own uid (clientId ?? userId — on a caregiver turn qaAgent injects
// userId = the caregiver) → PERMISSION_DENIED every time, or, when the model
// passed a clientId, trusted that guess. get_upcoming_appointments took any
// clientId with no relationship check → any caregiver could read any family's
// schedule. Rule now (the site's): a caregiver sees the care recipient of a
// family she has an accepted booking or a visit (scheduled / in-progress /
// completed) with, and only the visits that are HERS.
//
// Same firebase-admin mock shape as seniorIsolation.test.ts: docState backs
// .doc().get(), collState backs .where().get() (filters ignored — the handlers
// filter in memory, which is exactly what these tests exercise).

import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const docState  = new Map<string, any>();
  const collState = new Map<string, any[]>();

  const makeDocRef = (path: string) => ({
    id: path.split("/").pop(),
    path,
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path), ref: makeDocRef(path) })),
    set: vi.fn(async (data: any, opts?: any) => { docState.set(path, opts?.merge ? { ...(docState.get(path) ?? {}), ...data } : data); }),
    update: vi.fn(async (data: any) => { docState.set(path, { ...(docState.get(path) ?? {}), ...data }); }),
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });

  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id?: string) => makeDocRef(`${path}/${id ?? "auto"}`);
    ref.where   = (..._a: any[]) => ref;
    ref.orderBy = (..._a: any[]) => ref;
    ref.limit   = (..._a: any[]) => ref;
    ref.add = vi.fn(async (data: any) => { const id = "auto"; docState.set(`${path}/${id}`, data); return { id }; });
    ref.get = vi.fn(async () => {
      const items = collState.get(path) ?? [];
      return { empty: items.length === 0, size: items.length, docs: items.map((d: any, i: number) => ({ id: d.id ?? `doc-${i}`, data: () => d, ref: makeDocRef(`${path}/${d.id ?? `doc-${i}`}`) })) };
    });
    return ref;
  };

  return {
    docState, collState,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); collState.clear(); },
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
vi.mock("../../memory/preferences", () => ({ getPreferences: vi.fn().mockResolvedValue(null) }));
vi.mock("../../agents/caregiverSearch", () => ({
  presentCaregiverSearch: vi.fn(async () => ({ status: "shown", total: 0, shown: [], offset: 0, hasMore: false })),
  searchCaregivers: vi.fn(async () => ({ total: 0, caregivers: [], hasLocation: false, filters: {} })),
}));
vi.mock("../../utils/toolNotify", () => ({
  trySend:        vi.fn().mockResolvedValue({ sent: true }),
  trySendViaCara: vi.fn().mockResolvedValue({ sent: true }),
}));

import { handleToolCall, handleToolCallForCaregiver } from "../server";

const CG = "cg-1";
const FAMILY = "client-A";
// What qaAgent injects on a caregiver turn: userId = the caregiver's uid, caregiverId = the same, never a clientId.
const caregiverTurn = (extra: Record<string, unknown> = {}) => ({ phone: "+15550001111", chatId: "chat", userId: CG, caregiverId: CG, ...extra });

beforeEach(() => hoisted.reset());

describe("get_senior_profile for a caregiver (E4)", () => {
  beforeEach(() => {
    hoisted.docState.set("senior_profiles/s1", { userId: FAMILY, name: "Mary", age: 82, careNeeds: ["Companionship"] });
  });

  it("allows a caregiver with an accepted booking request from that family", async () => {
    hoisted.collState.set("booking_requests", [{ id: "br1", caregiverId: CG, clientId: FAMILY, status: "accepted" }]);
    hoisted.collState.set("shifts", []);
    const r = await handleToolCallForCaregiver("get_senior_profile", caregiverTurn({ seniorId: "s1" })) as any;
    expect(r.success).toBe(true);
    expect(r.results?.name).toBe("Mary");
  });

  it("allows a caregiver with a completed visit for that family (no booking row needed)", async () => {
    hoisted.collState.set("booking_requests", []);
    hoisted.collState.set("shifts", [{ id: "sh1", caregiverId: CG, clientId: FAMILY, status: "completed", date: "2026-10-01" }]);
    const r = await handleToolCallForCaregiver("get_senior_profile", caregiverTurn({ seniorId: "s1" })) as any;
    expect(r.success).toBe(true);
  });

  it("denies a caregiver with no booking or visit with that family — even when the model passes the family's clientId", async () => {
    hoisted.collState.set("booking_requests", [{ id: "br1", caregiverId: CG, clientId: "client-B", status: "accepted" }]);
    hoisted.collState.set("shifts", [{ id: "sh1", caregiverId: "other-cg", clientId: FAMILY, status: "scheduled", date: "2099-01-01" }]);
    const r = await handleToolCallForCaregiver("get_senior_profile", caregiverTurn({ seniorId: "s1", clientId: FAMILY })) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("PERMISSION_DENIED");
    expect(r.results).toBeUndefined();
  });

  it("a pending (not accepted) booking request or a cancelled visit is not a relationship", async () => {
    hoisted.collState.set("booking_requests", [{ id: "br1", caregiverId: CG, clientId: FAMILY, status: "pending" }]);
    hoisted.collState.set("shifts", [{ id: "sh1", caregiverId: CG, clientId: FAMILY, status: "cancelled", date: "2026-10-01" }]);
    const r = await handleToolCallForCaregiver("get_senior_profile", caregiverTurn({ seniorId: "s1" })) as any;
    expect(r.code).toBe("PERMISSION_DENIED");
  });

  it("the legacy profile keyed by the family's own uid resolves its owner to that uid", async () => {
    hoisted.docState.delete("senior_profiles/s1");
    hoisted.docState.set("senior_profiles/client-A", { name: "Mary" }); // no owner field: legacy single-senior doc
    hoisted.collState.set("booking_requests", [{ id: "br1", caregiverId: CG, clientId: FAMILY, status: "accepted" }]);
    hoisted.collState.set("shifts", []);
    const r = await handleToolCallForCaregiver("get_senior_profile", caregiverTurn({ seniorId: FAMILY })) as any;
    expect(r.success).toBe(true);
  });

  it("a family turn is unchanged: the owning client reads, a stranger is denied", async () => {
    const own = await handleToolCall("get_senior_profile", { seniorId: "s1", clientId: FAMILY, userId: FAMILY }) as any;
    expect(own.success).toBe(true);
    const other = await handleToolCall("get_senior_profile", { seniorId: "s1", clientId: "client-Z", userId: "client-Z", caregiverId: CG }) as any;
    expect(other.code).toBe("PERMISSION_DENIED");
  });
});

describe("get_upcoming_appointments for a caregiver (E5)", () => {
  it("returns only the caregiver's OWN upcoming visits with that family — never another caregiver's, never a needs_replacement one", async () => {
    hoisted.collState.set("shifts", [
      { id: "mine-1",   caregiverId: CG,         clientId: FAMILY,     status: "scheduled",         date: "2099-01-02", startTime: "09:00" },
      { id: "mine-2",   caregiverId: CG,         clientId: FAMILY,     status: "in-progress",       date: "2099-01-01", startTime: "09:00" },
      { id: "theirs",   caregiverId: "other-cg", clientId: FAMILY,     status: "scheduled",         date: "2099-01-03", startTime: "09:00" },
      { id: "dropped",  caregiverId: CG,         clientId: FAMILY,     status: "needs_replacement", date: "2099-01-04", startTime: "09:00" },
      { id: "otherfam", caregiverId: CG,         clientId: "client-B", status: "scheduled",         date: "2099-01-05", startTime: "09:00" },
      { id: "past",     caregiverId: CG,         clientId: FAMILY,     status: "scheduled",         date: "2000-01-01", startTime: "09:00" },
    ]);
    const r = await handleToolCallForCaregiver("get_upcoming_appointments", caregiverTurn({ clientId: FAMILY })) as any;
    expect(r.success).toBe(true);
    expect(r.results.map((x: any) => x.id)).toEqual(["mine-2", "mine-1"]);
  });

  it("a caregiver with no visits with that family gets an empty list, not the family's schedule", async () => {
    hoisted.collState.set("shifts", [
      { id: "theirs", caregiverId: "other-cg", clientId: FAMILY, status: "scheduled", date: "2099-01-03", startTime: "09:00" },
    ]);
    const r = await handleToolCallForCaregiver("get_upcoming_appointments", caregiverTurn({ clientId: FAMILY })) as any;
    expect(r.success).toBe(true);
    expect(r.results).toEqual([]);
  });

  it("a family turn is unchanged: the whole UPCOMING SHIFTS list incl. needs_replacement, ids returned", async () => {
    hoisted.collState.set("shifts", [
      { id: "s1", clientId: FAMILY, caregiverId: CG, date: "2099-01-15", status: "needs_replacement", startTime: "11:00" },
      { id: "s2", clientId: FAMILY, caregiverId: "other-cg", date: "2099-01-16", status: "scheduled", startTime: "11:00" },
    ]);
    const r = await handleToolCall("get_upcoming_appointments", { clientId: FAMILY, userId: FAMILY, phone: "+15550002222" }) as any;
    expect(r.results.map((x: any) => x.id)).toEqual(["s1", "s2"]);
  });
});
