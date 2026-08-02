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

  it("mirrors a direct chatId (non-group) by resolving agent_sessions.chatId", async () => {
    hoisted.collState.set("agent_sessions", [
      { id: "primary", chatId: "direct-chat-A", groupChatId: "some-group", userId: "soloClient" },
    ]);

    await mirrorToWebThread({ chatId: "direct-chat-A", direction: "outbound", text: "Hi there" });

    expect(hoisted.docState.get("threads/cara_soloClient")).toMatchObject({
      participants: ["soloClient", "cara"],
      lastMessage: "Hi there",
      unreadCount: { __increment: 1 },
    });
    // The other group members must NOT be mirrored — the direct match wins.
    expect(hoisted.adds).toHaveLength(1);
  });

  it("omits unreadCount for inbound messages and preserves any existing unread", async () => {
    hoisted.collState.set("agent_sessions", [
      { id: "primary", chatId: "direct-chat-B", userId: "inboundClient" },
    ]);
    // Pre-existing unread from earlier unopened Evia replies must survive a
    // merge:true write that omits unreadCount.
    hoisted.docState.set("threads/cara_inboundClient", { unreadCount: 3 });

    await mirrorToWebThread({ chatId: "direct-chat-B", direction: "inbound", text: "Thanks!" });

    const thread = hoisted.docState.get("threads/cara_inboundClient");
    expect(thread.unreadCount).toBe(3); // not overwritten, not incremented
    expect(hoisted.adds).toContainEqual({
      path: "threads/cara_inboundClient/messages",
      data: expect.objectContaining({
        text: "Thanks!",
        senderId: "inboundClient",
        isRead: true,
        source: "cara_sms",
      }),
    });
  });

  it("ignores empty/whitespace text without writing anything", async () => {
    hoisted.collState.set("agent_sessions", [
      { id: "primary", chatId: "direct-chat-C", userId: "c9" },
    ]);

    await mirrorToWebThread({ chatId: "direct-chat-C", direction: "outbound", text: "   " });

    expect(hoisted.sets).toHaveLength(0);
    expect(hoisted.adds).toHaveLength(0);
  });

  it("warns and truncates only when group members EXCEED the 50-member cap", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Exactly 50 members → complete, no warning.
    const exactly50 = Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, groupChatId: "group-50", userId: `u50_${i}` }));
    hoisted.collState.set("agent_sessions", exactly50);
    await mirrorToWebThread({ chatId: "group-50", direction: "outbound", text: "cap-edge" });
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockClear();
    hoisted.reset();

    // 51 members → truncated, warning fires, and only 50 get mirrored.
    const fiftyOne = Array.from({ length: 51 }, (_, i) => ({ id: `n${i}`, groupChatId: "group-51", userId: `u51_${i}` }));
    hoisted.collState.set("agent_sessions", fiftyOne);
    await mirrorToWebThread({ chatId: "group-51", direction: "outbound", text: "over-cap" });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("exceeded the 50-member mirror cap"));
    expect(hoisted.adds).toHaveLength(50);

    warnSpy.mockRestore();
  });

  it("reuses cached userIds within the TTL (no re-query needed)", async () => {
    hoisted.collState.set("agent_sessions", [
      { id: "primary", chatId: "direct-chat-cache", userId: "cachedUser" },
    ]);

    await mirrorToWebThread({ chatId: "direct-chat-cache", direction: "outbound", text: "first" });
    expect(hoisted.docState.get("threads/cara_cachedUser")).toBeDefined();

    // Drop the session data — a cache hit must still resolve the same userId.
    hoisted.collState.clear();
    await mirrorToWebThread({ chatId: "direct-chat-cache", direction: "outbound", text: "second" });

    expect(hoisted.docState.get("threads/cara_cachedUser").lastMessage).toBe("second");
  });

  // ── Childcare U9 (plan 2026-07-22-002, R41/R50/KTD14) ──────────────────────

  it("CHILDCARE: a child-vertical turn is never mirrored into the senior thread structures", async () => {
    hoisted.collState.set("agent_sessions", [
      { id: "primary", chatId: "direct-chat-cc", userId: "ccParent" },
    ]);

    await mirrorToWebThread({
      chatId: "direct-chat-cc",
      direction: "outbound",
      text: "Your childcare booking update",
      careVertical: "child",
    });

    // NOTHING written: no thread doc, no message row, no unread increment.
    expect(hoisted.sets).toHaveLength(0);
    expect(hoisted.adds).toHaveLength(0);
    expect(hoisted.docState.get("threads/cara_ccParent")).toBeUndefined();
  });

  it("CHILDCARE: senior and unclassified turns mirror exactly as before (compat)", async () => {
    hoisted.collState.set("agent_sessions", [
      { id: "primary", chatId: "direct-chat-sv", userId: "seniorClient" },
    ]);

    // Explicit senior classification behaves like the historical default.
    await mirrorToWebThread({
      chatId: "direct-chat-sv",
      direction: "outbound",
      text: "senior turn",
      careVertical: "senior",
    });
    expect(hoisted.docState.get("threads/cara_seniorClient").lastMessage).toBe("senior turn");

    // Unclassified (no careVertical) is the senior-compatible default.
    await mirrorToWebThread({ chatId: "direct-chat-sv", direction: "outbound", text: "plain turn" });
    expect(hoisted.docState.get("threads/cara_seniorClient").lastMessage).toBe("plain turn");
  });
});
