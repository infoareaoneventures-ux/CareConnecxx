import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const collState = new Map<string, any[]>();
  const sets: Array<{ path: string; data: any; opts?: any }> = [];
  const adds: Array<{ path: string; data: any }> = [];

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    set: vi.fn(async (data: any, opts?: any) => {
      sets.push({ path, data, opts });
      docState.set(path, opts?.merge ? { ...(docState.get(path) ?? {}), ...data } : data);
    }),
    collection: (sub: string) => ({
      add: vi.fn(async (data: any) => {
        adds.push({ path: `${path}/${sub}`, data });
        return { id: `msg-${adds.length}` };
      }),
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
        if (op === "==") return item[field] === value;
        return true;
      }));
      return {
        empty: items.length === 0,
        docs: items.map((d: any, i: number) => ({ id: d.id ?? `doc-${i}`, data: () => d })),
      };
    });
    return ref;
  };

  return {
    docState,
    collState,
    sets,
    adds,
    collectionMock: vi.fn((path: string) => makeCollRef(path)),
    reset: () => {
      docState.clear();
      collState.clear();
      sets.length = 0;
      adds.length = 0;
    },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: {
      increment: (n: number) => ({ __increment: n }),
      serverTimestamp: () => ({ __serverTimestamp: true }),
    },
  }),
}));

import { mirrorToWebThread } from "./threadMirror";

describe("mirrorToWebThread", () => {
  beforeEach(() => {
    hoisted.reset();
    vi.clearAllMocks();
  });

  it("mirrors group-routed outbound messages by resolving agent_sessions.groupChatId", async () => {
    hoisted.collState.set("agent_sessions", [
      { id: "primary", chatId: "direct-chat", groupChatId: "family-group-chat", userId: "client1" },
      { id: "sibling", chatId: "sibling-chat", groupChatId: "family-group-chat", userId: "client2" },
    ]);

    await mirrorToWebThread({
      chatId: "family-group-chat",
      direction: "outbound",
      text: "Visit update",
    });

    // Both distinct group members get their own mirrored thread + message.
    for (const uid of ["client1", "client2"]) {
      expect(hoisted.docState.get(`threads/cara_${uid}`)).toMatchObject({
        participants: [uid, "cara"],
        lastMessage: "Visit update",
        unreadCount: { __increment: 1 },
      });
      expect(hoisted.adds).toContainEqual({
        path: `threads/cara_${uid}/messages`,
        data: expect.objectContaining({
          text: "Visit update",
          senderId: "cara",
          isRead: false,
          source: "cara_sms",
        }),
      });
    }
  });
});
