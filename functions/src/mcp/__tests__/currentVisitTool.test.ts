import { describe, it, expect, vi, beforeEach } from "vitest";

// get_current_visit: "do I have a shift in progress / when does it end / how many tasks are done" answered from the visit
// record by code (agents/currentVisit.ts), after the founders' 2026-11-23 questions each went to the fact-checker and were refused.

const hoisted = vi.hoisted(() => {
  const state = { live: [] as any[], next: [] as any[], wheres: [] as any[][] };
  const makeShifts = (): any => {
    const wheres: any[][] = [];
    const ref: any = {
      where: (...a: any[]) => { wheres.push(a); state.wheres.push(a); return ref; },
      orderBy: () => ref, limit: () => ref,
      get: vi.fn(async () => {
        const wantsLive = wheres.some((w) => w[0] === "status" && w[2] === "in-progress");
        const docs = (wantsLive ? state.live : state.next).map((d) => ({ id: d.id, data: () => d.data }));
        return { empty: docs.length === 0, size: docs.length, docs };
      }),
    };
    return ref;
  };
  const makeColl = (path: string): any => (path === "shifts" ? makeShifts() : { doc: () => ({ get: async () => ({ exists: false, data: () => undefined }), set: async () => undefined, update: async () => undefined }), where: () => makeColl(path), limit: () => makeColl(path), get: async () => ({ empty: true, docs: [] }), orderBy: () => makeColl(path) });
  return { state, collectionMock: vi.fn((p: string) => makeColl(p)) };
});

vi.mock("firebase-admin", () => {
  const firestoreFn = () => ({ collection: hoisted.collectionMock, batch: () => ({ set: vi.fn(), update: vi.fn(), commit: vi.fn(async () => undefined) }) });
  return { __esModule: true, default: { firestore: firestoreFn }, firestore: Object.assign(firestoreFn, { FieldValue: { delete: () => ({}), arrayUnion: () => ({}), serverTimestamp: () => ({}) } }) };
});
vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../observability/actionLedger", () => ({ logAgentAction: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../memory/memoryFiles", () => ({ readMemoryFile: vi.fn().mockResolvedValue(""), writeMemoryFile: vi.fn().mockResolvedValue(undefined), MemoryFile: {} }));
vi.mock("../../memory/preferences", () => ({ getPreferences: vi.fn().mockResolvedValue(null) }));
vi.mock("../../linq/client", () => ({ sendToPhone: vi.fn().mockResolvedValue("sent"), sendMessage: vi.fn().mockResolvedValue({ message_id: "m" }) }));

import { handleToolCall, MCP_TOOLS } from "../server";

const live = {
  status: "in-progress", date: "2026-11-23", startTime: "09:00", endTime: "13:00", caregiverName: "Imran Mohammed", clientName: "Usman", clientId: "fam1", caregiverId: "cg1",
  timeZone: "America/Los_Angeles", startedAt: { toMillis: () => Date.parse("2026-11-23T17:05:00Z") },
  careRecipients: [{ name: "Henry x", careNeeds: ["Personal Care", "Companionship", "Meal Preparation"] }], tasksCompleted: ["0_Personal Care", "0_Companionship"],
};

describe("get_current_visit", () => {
  beforeEach(() => { hoisted.state.live = []; hoisted.state.next = []; hoisted.state.wheres = []; });

  it("is offered to the agent, and its description points the in-progress questions at it", () => {
    const t = MCP_TOOLS.find((x) => x.name === "get_current_visit")!;
    expect(t).toBeTruthy();
    expect(t.description).toMatch(/in progress/i);
    expect(t.description).toMatch(/when does the shift end/i);
  });

  it("a family asking gets one finished sentence about the visit happening now", async () => {
    hoisted.state.live = [{ id: "s1", data: live }];
    const r: any = await handleToolCall("get_current_visit", { clientId: "fam1" });
    expect(r.success).toBe(true);
    expect(r.sentence).toContain("Imran Mohammed's visit is in progress, scheduled 9:00 AM–1:00 PM");
    expect(r.sentence).toContain("2 of 3 tasks done (Personal Care, Companionship)");
    // the in-progress lookup has no date filter, so an overnight visit that started yesterday still counts
    expect(hoisted.state.wheres.some((w) => w[0] === "status" && w[2] === "in-progress")).toBe(true);
    expect(hoisted.state.wheres.filter((w) => w[0] === "date")).toHaveLength(1); // only the "next visit" lookup
  });

  it("a care provider asking gets her own visit, spoken about the family", async () => {
    hoisted.state.live = [{ id: "s1", data: live }];
    const r: any = await handleToolCall("get_current_visit", { caregiverId: "cg1" });
    expect(r.sentence).toContain("Your visit with Usman is in progress");
    expect(hoisted.state.wheres.some((w) => w[0] === "caregiverId" && w[2] === "cg1")).toBe(true);
  });

  it("says so plainly when nothing is in progress", async () => {
    const r: any = await handleToolCall("get_current_visit", { clientId: "fam1" });
    expect(r.sentence).toBe("No visit is in progress right now, and nothing else is scheduled.");
  });

  it("needs an id", async () => {
    const r: any = await handleToolCall("get_current_visit", {});
    expect(r.success).not.toBe(true);
  });
});
