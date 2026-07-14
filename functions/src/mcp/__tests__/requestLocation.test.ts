import { describe, it, expect, vi, beforeEach } from "vitest";

// Firestore harness + server-import mocks mirror family.test.ts (the same set
// server.ts needs to import cleanly), plus a mock of the Linq client so the
// native request never hits the network.

const hoisted = vi.hoisted(() => {
  const docState  = new Map<string, any>();
  const sets:    Array<{ path: string; data: any; opts?: any }> = [];
  const updates: Array<{ path: string; data: any }> = [];

  const makeDocRef = (path: string) => ({
    id: path.split("/").pop(),
    path,
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path), ref: makeDocRef(path) })),
    set: vi.fn(async (data: any, opts?: any) => {
      sets.push({ path, data, opts });
      docState.set(path, opts?.merge ? { ...(docState.get(path) ?? {}), ...data } : data);
    }),
    update: vi.fn(async (data: any) => { updates.push({ path, data }); docState.set(path, { ...(docState.get(path) ?? {}), ...data }); }),
  });

  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id?: string) => makeDocRef(`${path}/${id ?? `auto-${sets.length}`}`);
    ref.where = (..._a: any[]) => ref;
    ref.limit = (..._a: any[]) => ref;
    ref.get = vi.fn(async () => ({ empty: true, size: 0, docs: [] }));
    return ref;
  };

  const requestLocationMock = vi.fn();

  return {
    docState, sets, updates,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    requestLocationMock,
    reset: () => { docState.clear(); sets.length = 0; updates.length = 0; requestLocationMock.mockReset(); },
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
vi.mock("../../agents/matchingAgent", () => ({ runMatchingForClient: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../agents/familyGroupManager", () => ({ buildOrUpdateFamilyGroup: vi.fn().mockResolvedValue(undefined), removeMemberFromGroup: vi.fn().mockResolvedValue({ removed: true }) }));
vi.mock("../../utils/toolNotify", () => ({ trySend: vi.fn().mockResolvedValue({ sent: true }), trySendViaCara: vi.fn().mockResolvedValue({ sent: true }) }));

// The unit under test: stub only requestLocation; canRequestNativeLocation stays real (pure).
vi.mock("../../linq/client", () => ({
  requestLocation: (...a: unknown[]) => hoisted.requestLocationMock(...a),
}));

import { handleToolCall } from "../server";

const INPUT = { phone: "+15555550100", chatId: "chat_x" };

describe("request_location tool", () => {
  beforeEach(() => hoisted.reset());

  it("errors when phone/chatId missing", async () => {
    const r = await handleToolCall("request_location", { reason: "x" }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("fires native prompt + persists pending marker on 1:1 iMessage", async () => {
    hoisted.docState.set("agent_sessions/+15555550100", { service: "iMessage" });
    hoisted.requestLocationMock.mockResolvedValueOnce({ requested: true });
    const r = await handleToolCall("request_location", INPUT) as any;
    expect(r.success).toBe(true);
    expect(r.nativePromptSent).toBe(true);
    expect(hoisted.requestLocationMock).toHaveBeenCalledWith("chat_x");
    const pending = hoisted.docState.get("agent_sessions/+15555550100").pendingLocationRequest;
    expect(pending).toMatchObject({ source: "mcp", nudgeSent: false });
  });

  it("does NOT call requestLocation on SMS — returns typed-ask fallback", async () => {
    hoisted.docState.set("agent_sessions/+15555550100", { service: "SMS" });
    const r = await handleToolCall("request_location", INPUT) as any;
    expect(r.success).toBe(true);
    expect(r.nativePromptSent).toBe(false);
    expect(r.fallback).toBe("ask_typed_city_zip");
    expect(hoisted.requestLocationMock).not.toHaveBeenCalled();
  });

  it("falls back to typed ask when a stale-iMessage request 409s", async () => {
    hoisted.docState.set("agent_sessions/+15555550100", { service: "iMessage" });
    hoisted.requestLocationMock.mockResolvedValueOnce({ requested: false, status: 409 });
    const r = await handleToolCall("request_location", INPUT) as any;
    expect(r.success).toBe(true);
    expect(r.nativePromptSent).toBe(false);
    expect(r.fallback).toBe("ask_typed_city_zip");
  });
});
