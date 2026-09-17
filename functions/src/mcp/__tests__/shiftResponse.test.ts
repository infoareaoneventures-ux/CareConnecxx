import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const makeDocRef = (path: string) => ({
    id: path.split("/").pop(), path,
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path), ref: makeDocRef(path) })),
    set: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
  });
  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id?: string) => makeDocRef(`${path}/${id ?? "auto"}`);
    ref.where = () => ref; ref.orderBy = () => ref; ref.limit = () => ref;
    ref.get = vi.fn(async () => ({ empty: true, size: 0, docs: [] }));
    ref.add = vi.fn(async () => ({ id: "auto" }));
    return ref;
  };
  const accept = vi.fn();
  const decline = vi.fn();
  return {
    docState, accept, decline,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); accept.mockReset(); decline.mockReset(); },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: { arrayUnion: (...v: any[]) => ({ __arrayUnion: v }), arrayRemove: (...v: any[]) => ({ __arrayRemove: v }), increment: (n: number) => ({ __increment: n }), delete: () => ({ __delete: true }) },
  }),
}));

vi.mock("../../observability/auditLog", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
  logHealthDataAccessed: vi.fn().mockResolvedValue(undefined),
  logBookingCreated: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../memory/memoryFiles", () => ({ readMemoryFile: vi.fn().mockResolvedValue(""), writeMemoryFile: vi.fn().mockResolvedValue(undefined), MemoryFile: {} }));
vi.mock("../../memory/preferences", () => ({ getPreferences: vi.fn().mockResolvedValue(null) }));
vi.mock("../../agents/caregiverSearch", () => ({
  presentCaregiverSearch: vi.fn(async () => ({ status: "shown", total: 0, shown: [], offset: 0, hasMore: false })),
  searchCaregivers: vi.fn(async () => ({ total: 0, caregivers: [], hasLocation: false, filters: {} })),
}));
vi.mock("../../agents/shiftOffer", () => ({
  acceptCaregiverShiftOffer: (...a: unknown[]) => hoisted.accept(...a),
  declineCaregiverShiftOffer: (...a: unknown[]) => hoisted.decline(...a),
}));

import { handleToolCall } from "../server";

const PHONE = "+15555550100";
const CHAT = "chat-1";

describe("accept_shift / decline_shift (U2)", () => {
  beforeEach(() => hoisted.reset());

  it("accepts the pending offer and reports success", async () => {
    hoisted.accept.mockResolvedValue({ status: "accepted" });
    const r = await handleToolCall("accept_shift", { phone: PHONE, chatId: CHAT }) as any;
    expect(hoisted.accept).toHaveBeenCalledWith(PHONE, CHAT);
    expect(r.success).toBe(true);
    expect(r.resolution).toBe("accepted");
  });

  it("declines the pending offer and reports success", async () => {
    hoisted.decline.mockResolvedValue({ status: "declined" });
    const r = await handleToolCall("decline_shift", { phone: PHONE, chatId: CHAT }) as any;
    expect(hoisted.decline).toHaveBeenCalledWith(PHONE, CHAT);
    expect(r.success).toBe(true);
    expect(r.resolution).toBe("declined");
  });

  it("reports cleanly when there is no pending offer", async () => {
    hoisted.accept.mockResolvedValue({ status: "no_pending_offer" });
    const r = await handleToolCall("accept_shift", { phone: PHONE, chatId: CHAT }) as any;
    expect(r.success).toBe(false);
    expect(r.reason).toBe("no_pending_offer");
  });

  it("reports cleanly when the offer was already closed", async () => {
    hoisted.accept.mockResolvedValue({ status: "already_closed" });
    const r = await handleToolCall("accept_shift", { phone: PHONE, chatId: CHAT }) as any;
    expect(r.success).toBe(false);
    expect(r.reason).toBe("already_closed");
  });

  it("requires injected phone and chatId", async () => {
    const r = await handleToolCall("accept_shift", { phone: PHONE }) as any;
    expect(r._toolError).toBe(true);
    expect(hoisted.accept).not.toHaveBeenCalled();
  });
});
