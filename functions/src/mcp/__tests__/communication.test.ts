import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const docState  = new Map<string, any>();
  const collState = new Map<string, any[]>();
  const sets:    Array<{ path: string; data: any; opts?: any }> = [];
  const adds:    Array<{ path: string; data: any; id: string }> = [];

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
    docState, collState, sets, adds,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); collState.clear(); sets.length = 0; adds.length = 0; },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: Object.assign(() => ({ collection: hoisted.collectionMock }), {
    FieldValue: {
      arrayUnion:      (...v: any[]) => ({ __arrayUnion: v }),
      arrayRemove:     (...v: any[]) => ({ __arrayRemove: v }),
      increment:       (n: number) => ({ __increment: n }),
      delete:          () => ({ __delete: true }),
      serverTimestamp: () => ({ __serverTimestamp: true }),
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

vi.mock("../../agents/caregiverSearch", () => ({
  presentCaregiverSearch: vi.fn(async () => ({ status: "shown", total: 0, shown: [], offset: 0, hasMore: false })),
  searchCaregivers: vi.fn(async () => ({ total: 0, caregivers: [], hasLocation: false, filters: {} })),
}));

const trySend = vi.fn().mockResolvedValue({ sent: true });
vi.mock("../../utils/toolNotify", () => ({
  trySend:        (...args: unknown[]) => trySend(...args),
  trySendViaCara: vi.fn().mockResolvedValue({ sent: true }),
}));

import { handleToolCall } from "../server";

describe("communication tools", () => {
  beforeEach(() => { hoisted.reset(); trySend.mockClear(); trySend.mockResolvedValue({ sent: true }); });

  describe("send_client_message (IDOR-protected)", () => {
    it("requires caregiverId + message", async () => {
      const r = await handleToolCall("send_client_message", { caregiverId: "cg1" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("blocks caregivers with no active or recent engagement", async () => {
      // No appointments — caregiver should be blocked
      hoisted.docState.set("caregivers/cg1", { name: "Alice", membershipStatus: "active" });
      const r = await handleToolCall("send_client_message", { caregiverId: "cg1", message: "hi" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("FORBIDDEN");
    });

    it("allows when caregiver has a CONFIRMED appointment with the explicit clientId", async () => {
      hoisted.collState.set("appointments", [
        { caregiverId: "cg1", clientId: "c1", status: "confirmed", date: "2026-06-01" },
      ]);
      hoisted.docState.set("users/c1", { phone: "+15555550100" });
      hoisted.docState.set("caregivers/cg1", { name: "Alice", membershipStatus: "active" });
      const r = await handleToolCall("send_client_message", { caregiverId: "cg1", message: "hi", clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.sent).toBe(true);
      expect(r.notification.sent).toBe(true);
      expect(trySend).toHaveBeenCalledWith("+15555550100", "Alice: hi", "mcp:send_client_message");
    });

    it("blocks an explicit clientId when no relationship exists", async () => {
      // collState is empty for appointments — no relationship
      hoisted.docState.set("users/c1", { phone: "+15555550100" });
      hoisted.docState.set("caregivers/cg1", { name: "Alice", membershipStatus: "active" });
      const r = await handleToolCall("send_client_message", { caregiverId: "cg1", message: "hi", clientId: "c1" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("FORBIDDEN");
    });

    it("surfaces notification.sent=false when Linq send fails", async () => {
      hoisted.collState.set("appointments", [
        { caregiverId: "cg1", clientId: "c1", status: "confirmed", date: "2026-06-01" },
      ]);
      hoisted.docState.set("users/c1", { phone: "+15555550100" });
      hoisted.docState.set("caregivers/cg1", { name: "Alice", membershipStatus: "active" });
      trySend.mockResolvedValueOnce({ sent: false, reason: "linq_send_failed" });
      const r = await handleToolCall("send_client_message", { caregiverId: "cg1", message: "hi", clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.notification.sent).toBe(false);
    });

    // 2026-08-31: Messages/Inbox parity audit — the website blocks a caregiver
    // with an inactive membership from sending in the Inbox composer
    // (useCaregiverGate's gateMembership(), InboxView.tsx); send_client_message
    // had no equivalent check.
    describe("caregiver membership gate (Messages/Inbox parity)", () => {
      it("blocks when the caregiver has no membershipStatus/membershipPaid at all", async () => {
        hoisted.collState.set("appointments", [
          { caregiverId: "cg1", clientId: "c1", status: "confirmed", date: "2026-06-01" },
        ]);
        hoisted.docState.set("users/c1", { phone: "+15555550100" });
        hoisted.docState.set("caregivers/cg1", { name: "Alice" });
        const r = await handleToolCall("send_client_message", { caregiverId: "cg1", message: "hi", clientId: "c1" }) as any;
        expect(r._toolError).toBe(true);
        expect(r.code).toBe("MEMBERSHIP_REQUIRED");
        expect(trySend).not.toHaveBeenCalled();
      });

      it("blocks when membershipStatus is 'inactive'/'canceled'", async () => {
        hoisted.docState.set("caregivers/cg1", { name: "Alice", membershipStatus: "canceled" });
        const r = await handleToolCall("send_client_message", { caregiverId: "cg1", message: "hi", clientId: "c1" }) as any;
        expect(r._toolError).toBe(true);
        expect(r.code).toBe("MEMBERSHIP_REQUIRED");
      });

      it("allows a legacy caregiver with no membershipStatus but membershipPaid:true", async () => {
        hoisted.collState.set("appointments", [
          { caregiverId: "cg1", clientId: "c1", status: "confirmed", date: "2026-06-01" },
        ]);
        hoisted.docState.set("users/c1", { phone: "+15555550100" });
        hoisted.docState.set("caregivers/cg1", { name: "Alice", membershipPaid: true });
        const r = await handleToolCall("send_client_message", { caregiverId: "cg1", message: "hi", clientId: "c1" }) as any;
        expect(r.success).toBe(true);
      });

      it("allows membershipStatus: 'trialing'", async () => {
        hoisted.collState.set("appointments", [
          { caregiverId: "cg1", clientId: "c1", status: "confirmed", date: "2026-06-01" },
        ]);
        hoisted.docState.set("users/c1", { phone: "+15555550100" });
        hoisted.docState.set("caregivers/cg1", { name: "Alice", membershipStatus: "trialing" });
        const r = await handleToolCall("send_client_message", { caregiverId: "cg1", message: "hi", clientId: "c1" }) as any;
        expect(r.success).toBe(true);
      });
    });
  });

  describe("send_caregiver_message", () => {
    // Mirrors the website's own paywall (hooks/useAccessGates.tsx `gate('message', ...)`):
    // identity verification, then an active membership, before a family can message
    // a caregiver at all.
    const seedVerifiedClient = (fields: Record<string, unknown> = {}) => {
      hoisted.docState.set("users/c1", {
        identityCheckStatus: "verified",
        membershipStatus: "active",
        ...fields,
      });
    };

    it("requires caregiverId + message", async () => {
      const r = await handleToolCall("send_caregiver_message", {}) as any;
      expect(r._toolError).toBe(true);
    });

    it("blocks when identity is not verified", async () => {
      hoisted.docState.set("users/c1", { membershipStatus: "active" });
      hoisted.docState.set("caregivers/cg1", { name: "Alice", phone: "+15555550101" });
      const r = await handleToolCall("send_caregiver_message", { caregiverId: "cg1", message: "hi", clientId: "c1" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("IDENTITY_REQUIRED");
      expect(trySend).not.toHaveBeenCalled();
    });

    it("blocks when membership is not active", async () => {
      hoisted.docState.set("users/c1", { identityCheckStatus: "verified" });
      hoisted.docState.set("caregivers/cg1", { name: "Alice", phone: "+15555550101" });
      const r = await handleToolCall("send_caregiver_message", { caregiverId: "cg1", message: "hi", clientId: "c1" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("MEMBERSHIP_REQUIRED");
      expect(trySend).not.toHaveBeenCalled();
    });

    it("blocks when clientId is missing entirely", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Alice", phone: "+15555550101" });
      const r = await handleToolCall("send_caregiver_message", { caregiverId: "cg1", message: "hi" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("PERMISSION_DENIED");
    });

    it("returns NOT_FOUND if caregiver doc missing", async () => {
      seedVerifiedClient();
      const r = await handleToolCall("send_caregiver_message", { caregiverId: "ghost", message: "hi", clientId: "c1" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("returns NOT_FOUND if caregiver has no phone", async () => {
      seedVerifiedClient();
      hoisted.docState.set("caregivers/cg1", { name: "Alice" });
      const r = await handleToolCall("send_caregiver_message", { caregiverId: "cg1", message: "hi", clientId: "c1" }) as any;
      expect(r._toolError).toBe(true);
    });

    // 2026-08-31: Messages/Inbox parity — BrowseCaregivers.tsx never surfaces a
    // hidden profile to browse/message; Evia shouldn't relay to one either.
    it("returns NOT_FOUND for a caregiver with profileVisibility:'hidden'", async () => {
      seedVerifiedClient();
      hoisted.docState.set("caregivers/cg1", { name: "Alice", phone: "+15555550101", profileVisibility: "hidden" });
      const r = await handleToolCall("send_caregiver_message", { caregiverId: "cg1", message: "hi", clientId: "c1" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("NOT_FOUND");
      expect(trySend).not.toHaveBeenCalled();
    });

    it("sends and returns notification status", async () => {
      seedVerifiedClient();
      hoisted.docState.set("caregivers/cg1", { name: "Alice", phone: "+15555550101" });
      const r = await handleToolCall("send_caregiver_message", { caregiverId: "cg1", message: "she napped well", clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.notification.sent).toBe(true);
      expect(r.sent).toBe(true);
    });

    it("surfaces notification failure", async () => {
      seedVerifiedClient();
      hoisted.docState.set("caregivers/cg1", { name: "Alice", phone: "+15555550101" });
      trySend.mockResolvedValueOnce({ sent: false, reason: "linq_send_failed" });
      const r = await handleToolCall("send_caregiver_message", { caregiverId: "cg1", message: "hi", clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.sent).toBe(false);
      expect(r.notification.sent).toBe(false);
    });
  });

  // 2026-08-22: both directions used to ONLY fire a one-way SMS, with no
  // visible thread for the family to see a caregiver's reply (or vice versa).
  // Both now also post into chatRooms/{roomId}/messages — the same collection
  // FindCaregivers.tsx's openChat() reads from — so a relayed message shows up
  // in the real, two-way website Inbox thread, not just this SMS conversation.
  describe("shared chatRooms thread relay", () => {
    it("send_caregiver_message posts into chatRooms/{sortedIds}/messages", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Alice", phone: "+15555550101" });
      hoisted.docState.set("users/c1", { name: "Sarah", phone: "+15555550100", identityCheckStatus: "verified", membershipStatus: "active" });
      const roomId = ["c1", "cg1"].sort().join("_");
      const r = await handleToolCall("send_caregiver_message", { caregiverId: "cg1", message: "she napped well", clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      const roomSets = hoisted.sets.filter((s) => s.path === `chatRooms/${roomId}`);
      expect(roomSets.length).toBeGreaterThan(0);
      const messageSets = hoisted.sets.filter((s) => s.path.startsWith(`chatRooms/${roomId}/messages/`));
      expect(messageSets).toHaveLength(1);
      expect(messageSets[0].data).toMatchObject({
        senderId: "c1", senderName: "Sarah", text: "she napped well", type: "text",
      });
    });

    it("send_client_message posts into the same chatRooms thread as the caregiver sender", async () => {
      hoisted.collState.set("appointments", [
        { caregiverId: "cg1", clientId: "c1", status: "confirmed", date: "2026-06-01" },
      ]);
      hoisted.docState.set("users/c1", { phone: "+15555550100", name: "Sarah" });
      hoisted.docState.set("caregivers/cg1", { name: "Alice", membershipStatus: "active" });
      const roomId = ["c1", "cg1"].sort().join("_");
      const r = await handleToolCall("send_client_message", { caregiverId: "cg1", message: "on my way", clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      const messageSets = hoisted.sets.filter((s) => s.path.startsWith(`chatRooms/${roomId}/messages/`));
      expect(messageSets).toHaveLength(1);
      expect(messageSets[0].data).toMatchObject({
        senderId: "cg1", senderName: "Alice", text: "on my way", type: "text",
      });
    });

    it("send_caregiver_message still sends the SMS even if the thread write fails to resolve names", async () => {
      // users/c1 has no `name` — clientName resolves to "", but the tool must
      // not fail or skip the SMS relay over it. (identity/membership fields
      // are still required to pass the gate above.)
      hoisted.docState.set("users/c1", { identityCheckStatus: "verified", membershipStatus: "active" });
      hoisted.docState.set("caregivers/cg1", { name: "Alice", phone: "+15555550101" });
      const r = await handleToolCall("send_caregiver_message", { caregiverId: "cg1", message: "hi", clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.sent).toBe(true);
    });
  });

  // 2026-08-31: Messages/Inbox parity audit — get_recent_messages previously
  // queried `threads` (the Evia-assistant chat-widget mirror, participants
  // always [uid,'cara']) ordered by a field ('updatedAt') no doc has ever had,
  // so it always returned empty no matter what. Real conversations live in
  // chatRooms/{sortedIds}/messages — the same collection send_caregiver_message
  // and send_client_message write to via relayIntoSharedChatThread.
  describe("get_recent_messages (reads real chatRooms, not threads)", () => {
    it("requires userId", async () => {
      const r = await handleToolCall("get_recent_messages", {}) as any;
      expect(r._toolError).toBe(true);
    });

    it("returns empty when the user has no chatRooms", async () => {
      const r = await handleToolCall("get_recent_messages", { userId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.threads).toEqual([]);
    });

    it("ignores the unrelated `threads` (Evia-assistant) collection entirely", async () => {
      // A cara_c1 doc with participants [c1,'cara'] must never surface here.
      hoisted.docState.set("threads/cara_c1", { participants: ["c1", "cara"], updatedAt: "2026-08-31" });
      const r = await handleToolCall("get_recent_messages", { userId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.threads).toEqual([]);
    });

    it("reads a real caregiver<->client conversation from chatRooms, oldest-to-newest", async () => {
      const roomId = ["c1", "cg1"].sort().join("_");
      hoisted.collState.set("chatRooms", [
        { id: roomId, participants: ["c1", "cg1"], participantNames: ["Sarah", "Alice"], lastMessageTimestamp: "t2" },
      ]);
      // The mock's orderBy() is a no-op passthrough (unlike real Firestore),
      // so the fixture is seeded already in the "orderBy('timestamp','desc')"
      // order (newest first) the real query would return — the code then
      // reverses it to oldest-first for display, same as real Firestore.
      hoisted.collState.set(`chatRooms/${roomId}/messages`, [
        { senderId: "c1",  text: "thank you!",       timestamp: "t2" },
        { senderId: "cg1", text: "she napped well", timestamp: "t1" },
      ]);
      const r = await handleToolCall("get_recent_messages", { userId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.threads).toHaveLength(1);
      expect(r.threads[0]).toMatchObject({ threadId: roomId, with: "Alice", withId: "cg1" });
      expect(r.threads[0].messages).toEqual([
        { from: "Alice", text: "she napped well", timestamp: "t1" },
        { from: "you",   text: "thank you!",       timestamp: "t2" },
      ]);
    });

    it("with counterpartId, looks up the exact deterministic room directly instead of scanning", async () => {
      const roomId = ["c1", "cg1"].sort().join("_");
      hoisted.docState.set(`chatRooms/${roomId}`, { participants: ["c1", "cg1"], participantNames: ["Sarah", "Alice"] });
      hoisted.collState.set(`chatRooms/${roomId}/messages`, [
        { senderId: "cg1", text: "on my way", timestamp: "t1" },
      ]);
      const r = await handleToolCall("get_recent_messages", { userId: "c1", counterpartId: "cg1" }) as any;
      expect(r.success).toBe(true);
      expect(r.threads).toHaveLength(1);
      expect(r.threads[0].messages[0]).toMatchObject({ from: "Alice", text: "on my way" });
    });

    it("returns empty for counterpartId when no room exists between the two", async () => {
      const r = await handleToolCall("get_recent_messages", { userId: "c1", counterpartId: "cg-ghost" }) as any;
      expect(r.success).toBe(true);
      expect(r.threads).toEqual([]);
    });

    it("skips a room the user has soft-deleted (deletedAt set, no new message since)", async () => {
      const roomId = ["c1", "cg1"].sort().join("_");
      hoisted.collState.set("chatRooms", [
        { id: roomId, participants: ["c1", "cg1"], participantNames: ["Sarah", "Alice"], deletedAt: { c1: "2026-08-01" } },
      ]);
      const r = await handleToolCall("get_recent_messages", { userId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.threads).toEqual([]);
    });
  });

  // 2026-08-31: Messages/Inbox parity — the website's "Delete conversation"
  // Inbox menu action (chatService.ts's deleteConversation) had no Evia
  // equivalent at all.
  describe("delete_conversation", () => {
    it("requires userId and counterpartId", async () => {
      const r = await handleToolCall("delete_conversation", { userId: "c1" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("returns NOT_FOUND when no conversation exists with that person", async () => {
      const r = await handleToolCall("delete_conversation", { userId: "c1", counterpartId: "cg1" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("NOT_FOUND");
    });

    it("sets deletedAt only for the requesting user, matching chatService.deleteConversation", async () => {
      const roomId = ["c1", "cg1"].sort().join("_");
      hoisted.docState.set(`chatRooms/${roomId}`, { participants: ["c1", "cg1"].sort() });
      const r = await handleToolCall("delete_conversation", { userId: "c1", counterpartId: "cg1" }) as any;
      expect(r.success).toBe(true);
      expect(r.deleted).toBe(true);
      const roomSet = hoisted.sets.find((s) => s.path === `chatRooms/${roomId}` && s.opts?.merge);
      expect(roomSet?.data["deletedAt.c1"]).toBeTruthy();
      expect(roomSet?.data["deletedAt.cg1"]).toBeUndefined();
    });
  });

  // 2026-08-31: Messages/Inbox parity — the website auto-marks messages read
  // (chatService.ts's markMessagesAsRead) when a conversation is opened; some
  // families/caregivers will just ask Evia to do this directly by text.
  describe("mark_messages_read", () => {
    it("requires userId and counterpartId", async () => {
      const r = await handleToolCall("mark_messages_read", { userId: "c1" }) as any;
      expect(r._toolError).toBe(true);
    });

    it("returns NOT_FOUND when no conversation exists with that person", async () => {
      const r = await handleToolCall("mark_messages_read", { userId: "c1", counterpartId: "cg1" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("NOT_FOUND");
    });

    it("marks every unread message read, adds this user to readBy, and zeroes their unreadCount", async () => {
      const roomId = ["c1", "cg1"].sort().join("_");
      hoisted.docState.set(`chatRooms/${roomId}`, { participants: ["c1", "cg1"].sort(), unreadCount: { c1: 2 } });
      // The mock's .where() is a no-op passthrough, so seed only the messages
      // a real `where('isRead','==',false)` query would actually return.
      hoisted.collState.set(`chatRooms/${roomId}/messages`, [
        { id: "m1", senderId: "cg1", text: "on my way",   isRead: false, readBy: [] },
        { id: "m2", senderId: "cg1", text: "running late", isRead: false, readBy: [] },
      ]);
      const r = await handleToolCall("mark_messages_read", { userId: "c1", counterpartId: "cg1" }) as any;
      expect(r.success).toBe(true);
      expect(r.messagesMarkedRead).toBe(2);
      const m1Set = hoisted.sets.find((s) => s.path === `chatRooms/${roomId}/messages/m1`);
      expect(m1Set?.data).toMatchObject({ isRead: true, readBy: { __arrayUnion: ["c1"] } });
      const roomSet = hoisted.sets.find((s) => s.path === `chatRooms/${roomId}` && s.opts?.merge);
      expect(roomSet?.data["unreadCount.c1"]).toBe(0);
    });

    it("skips a message this user is already in readBy for", async () => {
      const roomId = ["c1", "cg1"].sort().join("_");
      hoisted.docState.set(`chatRooms/${roomId}`, { participants: ["c1", "cg1"].sort() });
      hoisted.collState.set(`chatRooms/${roomId}/messages`, [
        { id: "m1", senderId: "cg1", text: "already seen", isRead: false, readBy: ["c1"] },
      ]);
      const r = await handleToolCall("mark_messages_read", { userId: "c1", counterpartId: "cg1" }) as any;
      expect(r.success).toBe(true);
      expect(r.messagesMarkedRead).toBe(0);
    });
  });
});
