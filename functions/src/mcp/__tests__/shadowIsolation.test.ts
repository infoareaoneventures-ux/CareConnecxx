import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const docState  = new Map<string, any>();
  const collState = new Map<string, any[]>();
  const writes: Array<{ path: string; op: string }> = [];

  const makeDocRef = (path: string) => ({
    id: path.split("/").pop(), path,
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path), ref: makeDocRef(path) })),
    set: vi.fn(async (d: any) => { writes.push({ path, op: "set" }); docState.set(path, d); }),
    update: vi.fn(async () => { writes.push({ path, op: "update" }); }),
  });
  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id?: string) => makeDocRef(`${path}/${id ?? "auto"}`);
    ref.where = () => ref; ref.orderBy = () => ref; ref.limit = () => ref;
    ref.add = vi.fn(async (d: any) => { writes.push({ path, op: "add" }); return { id: "auto" }; });
    ref.get = vi.fn(async () => ({ empty: true, size: 0, docs: [] }));
    return ref;
  };
  return {
    docState, collState, writes,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); collState.clear(); writes.length = 0; },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: { arrayUnion: () => ({}), arrayRemove: () => ({}), increment: () => ({}), delete: () => ({ __delete: true }) },
  }),
}));
vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn().mockResolvedValue(undefined), logHealthDataAccessed: vi.fn().mockResolvedValue(undefined), logBookingCreated: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../memory/memoryFiles", () => ({ readMemoryFile: vi.fn().mockResolvedValue(""), writeMemoryFile: vi.fn().mockResolvedValue(undefined), MemoryFile: {} }));
vi.mock("../../memory/preferences", () => ({ getPreferences: vi.fn().mockResolvedValue(null) }));
vi.mock("../../agents/caregiverSearch", () => ({
  presentCaregiverSearch: vi.fn(async () => ({ status: "shown", total: 0, shown: [], offset: 0, hasMore: false })),
  searchCaregivers: vi.fn(async () => ({ total: 0, caregivers: [], hasLocation: false, filters: {} })),
}));

import { handleToolCall, isReadOnlyTool } from "../server";

describe("shadow/dry-run isolation (U11)", () => {
  beforeEach(() => hoisted.reset());

  it("synthesizes a mutating tool under shadowMode with NO write", async () => {
    const r = await handleToolCall("remove_family_member", { phone: "+1", seniorId: "s1", clientId: "c1", memberPhone: "+15551234567" }, true) as any;
    expect(r._shadow).toBe(true);
    expect(r.simulated).toBe("remove_family_member");
    expect(hoisted.writes.length).toBe(0);
  });

  it("synthesizes a high-risk gated tool under shadowMode (gate never reached, no pending_actions write)", async () => {
    const r = await handleToolCall("cancel_job_post", { phone: "+1", jobId: "j1" }, true) as any;
    expect(r._shadow).toBe(true);
    expect(hoisted.writes.find(w => w.path.startsWith("pending_actions"))).toBeUndefined();
  });

  it("does NOT synthesize a read-only tool under shadowMode (still runs for real)", async () => {
    const r = await handleToolCall("get_membership_page", { phone: "+1", clientId: "c1", userId: "c1" }, true) as any;
    expect(r?._shadow).toBeUndefined();
  });

  it("executes mutating tools normally when shadowMode is off (regression)", async () => {
    const r = await handleToolCall("remove_family_member", { phone: "+1", seniorId: "s1", clientId: "c1", memberPhone: "+15551234567" }, false) as any;
    expect(r?._shadow).toBeUndefined();
  });

  it("classifies tools conservatively (mutating tools are not read-only)", () => {
    expect(isReadOnlyTool("get_membership_page")).toBe(true);
    // 2026-09-14: find_nearby_caregivers took over the removed
    // find_replacement_caregivers' job of texting the family each caregiver's
    // profile card and writing pendingMatches — it sends real SMS, so it is
    // mutating and must be synthesized under shadow (the same double-send
    // audit lesson from 2026-07-06).
    expect(isReadOnlyTool("find_nearby_caregivers")).toBe(false);
    expect(isReadOnlyTool("get_callout_backups")).toBe(false);
    expect(isReadOnlyTool("remove_family_member")).toBe(false);
    expect(isReadOnlyTool("cancel_job_post")).toBe(false);
    expect(isReadOnlyTool("manage_booking")).toBe(false);
  });

  it("synthesizes find_nearby_caregivers under shadowMode — never texts the family", async () => {
    const r = await handleToolCall("find_nearby_caregivers", { phone: "+1", chatId: "c", clientId: "u1" }, true) as any;
    expect(r._shadow).toBe(true);
    expect(r.simulated).toBe("find_nearby_caregivers");
  });
});
