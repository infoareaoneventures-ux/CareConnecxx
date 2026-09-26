import { describe, it, expect, vi, beforeEach } from "vitest";

// Firestore harness + server-import mocks are the same set server.ts needs to
// import cleanly, plus a mock of the Linq client so the reaction POST never
// hits the network.

const hoisted = vi.hoisted(() => {
  const docState  = new Map<string, any>();
  const adds:    Array<{ path: string; data: any }> = [];
  const sets:    Array<{ path: string; data: any; opts?: any }> = [];

  const makeDocRef = (path: string) => ({
    id: path.split("/").pop(),
    path,
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path), ref: makeDocRef(path) })),
    set: vi.fn(async (data: any, opts?: any) => {
      sets.push({ path, data, opts });
      docState.set(path, opts?.merge ? { ...(docState.get(path) ?? {}), ...data } : data);
    }),
    update: vi.fn(async (data: any) => { docState.set(path, { ...(docState.get(path) ?? {}), ...data }); }),
  });

  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id?: string) => makeDocRef(`${path}/${id ?? `auto-${sets.length}`}`);
    ref.add = vi.fn(async (data: any) => { adds.push({ path, data }); return makeDocRef(`${path}/auto-${adds.length}`); });
    ref.where = (..._a: any[]) => ref;
    ref.limit = (..._a: any[]) => ref;
    ref.get = vi.fn(async () => ({ empty: true, size: 0, docs: [] }));
    return ref;
  };

  const addReactionMock = vi.fn();

  return {
    docState, adds, sets,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    addReactionMock,
    reset: () => { docState.clear(); adds.length = 0; sets.length = 0; addReactionMock.mockReset(); },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: { arrayUnion: (...v: any[]) => ({ __arrayUnion: v }), delete: () => ({ __delete: true }) },
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
vi.mock("../../utils/toolNotify", () => ({ trySend: vi.fn().mockResolvedValue({ sent: true }), trySendViaCara: vi.fn().mockResolvedValue({ sent: true }) }));

// The unit under test: stub only addReaction — the handler imports it dynamically.
vi.mock("../../linq/client", () => ({
  addReaction: (...a: unknown[]) => hoisted.addReactionMock(...a),
}));

import { handleToolCall } from "../server";

const PHONE = "+15555550100";
const SESSION_PATH = `agent_sessions/${PHONE}`;
const IMESSAGE_SESSION = { service: "iMessage", chatId: "chat_x", lastInboundMessageId: "msg_123" };

describe("react_to_message tool", () => {
  beforeEach(() => hoisted.reset());

  it("errors when phone/type missing", async () => {
    const r1 = await handleToolCall("react_to_message", { type: "love" }) as any;
    expect(r1._toolError).toBe(true);
    expect(r1.code).toBe("INVALID_INPUT");
    const r2 = await handleToolCall("react_to_message", { phone: PHONE }) as any;
    expect(r2._toolError).toBe(true);
  });

  it("rejects an unknown reaction type", async () => {
    const r = await handleToolCall("react_to_message", { phone: PHONE, type: "wave" }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("INVALID_INPUT");
    expect(hoisted.addReactionMock).not.toHaveBeenCalled();
  });

  it("requires customEmoji when type is custom", async () => {
    const r = await handleToolCall("react_to_message", { phone: PHONE, type: "custom" }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("adds a tapback to the last inbound message on iMessage + audit-logs it", async () => {
    hoisted.docState.set(SESSION_PATH, IMESSAGE_SESSION);
    hoisted.addReactionMock.mockResolvedValueOnce(undefined);
    const r = await handleToolCall("react_to_message", { phone: PHONE, type: "love" }) as any;
    expect(r.success).toBe(true);
    expect(r.reacted).toBe(true);
    expect(hoisted.addReactionMock).toHaveBeenCalledWith({
      messageId: "msg_123", type: "love", customEmoji: undefined,
    });
    const audit = hoisted.adds.find(a => a.path === "agent_reactions");
    expect(audit?.data).toMatchObject({
      messageId: "msg_123", reaction: "love", phone: PHONE, direction: "outbound", operation: "added",
    });
  });

  it("passes the custom emoji through and audit-logs the emoji itself", async () => {
    hoisted.docState.set(SESSION_PATH, IMESSAGE_SESSION);
    hoisted.addReactionMock.mockResolvedValueOnce(undefined);
    const r = await handleToolCall("react_to_message", { phone: PHONE, type: "custom", customEmoji: "🎉" }) as any;
    expect(r.reacted).toBe(true);
    expect(hoisted.addReactionMock).toHaveBeenCalledWith({
      messageId: "msg_123", type: "custom", customEmoji: "🎉",
    });
    const audit = hoisted.adds.find(a => a.path === "agent_reactions");
    expect(audit?.data.reaction).toBe("🎉");
  });

  it("does NOT call addReaction on SMS — returns express-in-text fallback", async () => {
    hoisted.docState.set(SESSION_PATH, { ...IMESSAGE_SESSION, service: "SMS" });
    const r = await handleToolCall("react_to_message", { phone: PHONE, type: "like" }) as any;
    expect(r.success).toBe(true);
    expect(r.reacted).toBe(false);
    expect(r.fallback).toBe("express_in_text");
    expect(hoisted.addReactionMock).not.toHaveBeenCalled();
  });

  it("falls back when the session has no lastInboundMessageId", async () => {
    hoisted.docState.set(SESSION_PATH, { service: "iMessage", chatId: "chat_x" });
    const r = await handleToolCall("react_to_message", { phone: PHONE, type: "like" }) as any;
    expect(r.success).toBe(true);
    expect(r.reacted).toBe(false);
    expect(r.fallback).toBe("express_in_text");
    expect(hoisted.addReactionMock).not.toHaveBeenCalled();
  });

  it("soft-falls back (no tool error) when the Linq call throws", async () => {
    hoisted.docState.set(SESSION_PATH, IMESSAGE_SESSION);
    hoisted.addReactionMock.mockRejectedValueOnce(new Error("409 not iMessage"));
    const r = await handleToolCall("react_to_message", { phone: PHONE, type: "love" }) as any;
    expect(r._toolError).toBeUndefined();
    expect(r.success).toBe(true);
    expect(r.reacted).toBe(false);
    expect(r.fallback).toBe("express_in_text");
    // No audit row for a reaction that never landed.
    expect(hoisted.adds.find(a => a.path === "agent_reactions")).toBeUndefined();
  });
});
