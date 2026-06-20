import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const collState = new Map<string, any[]>();
  const sets: Array<{ path: string; data: any; opts?: any }> = [];
  const updates: Array<{ path: string; data: any }> = [];

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: vi.fn(async () => ({
      exists: docState.has(path),
      data: () => docState.get(path),
      ref: makeDocRef(path),
    })),
    set: vi.fn(async (data: any, opts?: any) => {
      sets.push({ path, data, opts });
      docState.set(path, opts?.merge ? { ...(docState.get(path) ?? {}), ...data } : data);
    }),
    update: vi.fn(async (data: any) => {
      // Mirror Firestore: update() on a non-existent document rejects with
      // NOT_FOUND (gRPC code 5) rather than creating it. This is what lets the
      // tests verify the production .catch handlers around the groupChatId
      // backfill actually swallow the missing-session case (no phantom docs).
      if (!docState.has(path)) {
        const err: any = new Error(`5 NOT_FOUND: no document to update: ${path}`);
        err.code = 5;
        throw err;
      }
      updates.push({ path, data });
      docState.set(path, { ...(docState.get(path) ?? {}), ...data });
    }),
  });

  const makeCollRef = (path: string): any => {
    const filters: Array<[string, string, any]> = [];
    const ref: any = {};
    ref.doc = (id?: string) => makeDocRef(`${path}/${id ?? "auto"}`);
    ref.where = (field: string, op: string, value: any) => {
      filters.push([field, op, value]);
      return ref;
    };
    ref.limit = () => ref;
    ref.get = vi.fn(async () => {
      const items = (collState.get(path) ?? []).filter((item) => filters.every(([field, op, value]) => {
        const actual = item[field];
        if (op === "==") return actual === value;
        if (op === "array-contains") return Array.isArray(actual) && actual.includes(value);
        return true;
      }));
      return {
        empty: items.length === 0,
        docs: items.map((d: any, i: number) => ({
          id: d.id ?? `doc-${i}`,
          data: () => d,
          ref: makeDocRef(`${path}/${d.id ?? `doc-${i}`}`),
        })),
      };
    });
    ref.add = vi.fn(async (data: any) => {
      const id = `auto-${collState.get(path)?.length ?? 0}`;
      collState.set(path, [...(collState.get(path) ?? []), { id, ...data }]);
      return { id };
    });
    return ref;
  };

  return {
    docState,
    collState,
    sets,
    updates,
    collectionMock: vi.fn((path: string) => makeCollRef(path)),
    reset: () => {
      docState.clear();
      collState.clear();
      sets.length = 0;
      updates.length = 0;
    },
  };
});

const addParticipant = vi.fn(async () => {});
const sendMessage = vi.fn(async () => ({ message_id: "m1" }));

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: {
      arrayUnion: (...v: any[]) => ({ __arrayUnion: v }),
      arrayRemove: (...v: any[]) => ({ __arrayRemove: v }),
      delete: () => ({ __delete: true }),
    },
  }),
}));

vi.mock("firebase-functions/v1", () => ({
  __esModule: true,
  default: { https: { onCall: vi.fn((fn) => fn), HttpsError: class HttpsError extends Error {} } },
  https: { onCall: vi.fn((fn) => fn), HttpsError: class HttpsError extends Error {} },
}));

vi.mock("../linq/client", () => ({
  createChat: vi.fn(async () => ({ chat_id: "new-group" })),
  sendMessage: (...args: any[]) => sendMessage(...args),
  sendToPhone: vi.fn(async () => ({ message_id: "m2" })),
  addParticipant: (...args: any[]) => addParticipant(...args),
  updateChatName: vi.fn(async () => {}),
  removeParticipant: vi.fn(async () => {}),
}));

vi.mock("../observability/auditLog", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("../observability/actionLedger", () => ({ logAgentAction: vi.fn(async () => {}) }));
vi.mock("./tokenService", () => ({ generateToken: vi.fn(() => "token"), verifyToken: vi.fn(() => null) }));

import { buildOrUpdateFamilyGroup } from "./familyGroupManager";

describe("buildOrUpdateFamilyGroup", () => {
  beforeEach(() => {
    hoisted.reset();
    vi.clearAllMocks();
  });

  it("backfills groupChatId onto existing sessions and skips phones with no session", async () => {
    hoisted.docState.set("senior_profiles/client1", {
      name: "Jane",
      familyMembers: [{ phone: "+15550002222" }],
    });
    hoisted.docState.set("users/client1", { phone: "+15550001111" });
    // The group doc and the primary's session already exist. The family member
    // (+15550002222) has NOT onboarded, so there is no agent_sessions doc for it.
    hoisted.docState.set("family_groups/groupDoc", {
      seniorId: "client1", chatId: "linq-group-1", phones: ["+15550001111"],
    });
    hoisted.docState.set("agent_sessions/+15550001111", { userId: "client1" });
    hoisted.collState.set("family_groups", [{
      id: "groupDoc",
      seniorId: "client1",
      chatId: "linq-group-1",
      phones: ["+15550001111"],
    }]);

    await buildOrUpdateFamilyGroup("client1");

    expect(addParticipant).toHaveBeenCalledWith("linq-group-1", "+15550002222");
    // Existing session gets the backfill via update()...
    expect(hoisted.docState.get("agent_sessions/+15550001111")).toMatchObject({ groupChatId: "linq-group-1" });
    // ...the un-onboarded member's update rejects NOT_FOUND and is swallowed —
    // no phantom session doc is created.
    expect(hoisted.docState.has("agent_sessions/+15550002222")).toBe(false);
    expect(hoisted.updates).toContainEqual({
      path: "family_groups/groupDoc",
      data: { phones: { __arrayUnion: ["+15550002222"] } },
    });
    expect(sendMessage).toHaveBeenCalledWith("linq-group-1", expect.stringContaining("Welcome to the group"));
  });

  it("creates a new family group and backfills groupChatId via update (no phantom sessions)", async () => {
    hoisted.docState.set("senior_profiles/client1", {
      name: "Jane",
      familyMembers: [{ phone: "+15550002222" }],
    });
    hoisted.docState.set("users/client1", { phone: "+15550001111" });
    // Primary has a session; the family member has not onboarded (no session).
    hoisted.docState.set("agent_sessions/+15550001111", { userId: "client1" });
    // No family_groups doc → exercises the new-group creation path.

    await buildOrUpdateFamilyGroup("client1");

    // A new Linq group chat is created and the family member is added to it.
    expect(addParticipant).toHaveBeenCalledWith("new-group", "+15550002222");

    // The new group is persisted.
    const groups = hoisted.collState.get("family_groups") ?? [];
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ seniorId: "client1", chatId: "new-group" });

    // Existing session is backfilled via update()...
    expect(hoisted.updates).toContainEqual({
      path: "agent_sessions/+15550001111",
      data: { groupChatId: "new-group" },
    });
    // ...the un-onboarded member's update rejects NOT_FOUND and is swallowed —
    // no phantom session doc...
    expect(hoisted.docState.has("agent_sessions/+15550002222")).toBe(false);
    // ...and set/merge is never used for sessions (that would create phantoms).
    expect(hoisted.sets.filter((s) => s.path.startsWith("agent_sessions/"))).toHaveLength(0);
  });
});
