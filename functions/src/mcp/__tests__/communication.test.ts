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
      // No shifts — caregiver should be blocked
      hoisted.docState.set("caregivers/cg1", { name: "Alice", membershipStatus: "active" });
      const r = await handleToolCall("send_client_message", { caregiverId: "cg1", message: "hi" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("FORBIDDEN");
    });

    it("allows when caregiver has a CONFIRMED appointment with the explicit clientId", async () => {
      hoisted.collState.set("shifts", [
        { caregiverId: "cg1", clientId: "c1", status: "scheduled", date: "2099-06-01" },
      ]);
      hoisted.docState.set("users/c1", { phone: "+15555550100" });
      hoisted.docState.set("caregivers/cg1", { name: "Alice", membershipStatus: "active" });
      const r = await handleToolCall("send_client_message", { caregiverId: "cg1", message: "hi", clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.sent).toBe(true);
      expect(r.notification.sent).toBe(true);
      // No direct SMS from the tool — onMessageSent notifies the family like a website message.
      expect(trySend).not.toHaveBeenCalled();
    });

    it("no clientId: ONE related family resolves by the visit's clientId; several → the families come back and nothing is sent", async () => {
      hoisted.docState.set("caregivers/cg1", { name: "Alice", membershipStatus: "active" });
      hoisted.docState.set("users/c1", { name: "Sarah" });
      hoisted.collState.set("shifts", [{ caregiverId: "cg1", clientId: "c1", clientName: "Sarah", status: "scheduled", date: "2099-06-01" }]);
      const one = await handleToolCall("send_client_message", { caregiverId: "cg1", message: "hi" }) as any;
      expect(one).toMatchObject({ success: true, sentTo: "c1" });
      hoisted.collState.set("shifts", [
        { caregiverId: "cg1", clientId: "c1", clientName: "Sarah", status: "scheduled", date: "2099-06-01" },
        { caregiverId: "cg1", clientId: "c2", clientName: "Tom", status: "in-progress", date: "2099-06-01" },
      ]);
      const many = await handleToolCall("send_client_message", { caregiverId: "cg1", message: "hi" }) as any;
      expect(many.success).toBe(false);
      expect(many.reason).toBe("ambiguous_family");
      expect(many.families).toEqual([{ clientId: "c1", clientName: "Sarah" }, { clientId: "c2", clientName: "Tom" }]);
      expect(hoisted.sets.some((s) => s.path.includes("/messages/") && s.data?.text === "hi" && s.data?.senderId === "cg1" && s.path.includes("c2"))).toBe(false);
    });

    it("a PAST family (a finished booking, no visit in 30 days) can still be messaged — the My Families page's Message button", async () => {
      hoisted.docState.set("users/c7", { name: "Old Family" });
      hoisted.docState.set("caregivers/cg1", { name: "Alice", membershipStatus: "active" });
      hoisted.collState.set("booking_requests", [{ id: "br7", caregiverId: "cg1", clientId: "c7", clientName: "Old Family", status: "completed" }]);
      const r = await handleToolCall("send_client_message", { caregiverId: "cg1", message: "hello again", clientId: "c7" }) as any;
      expect(r).toMatchObject({ success: true, sentTo: "c7" });
    });

    it("blocks an explicit clientId when no relationship exists", async () => {
      // collState is empty for shifts — no relationship
      hoisted.docState.set("users/c1", { phone: "+15555550100" });
      hoisted.docState.set("caregivers/cg1", { name: "Alice", membershipStatus: "active" });
      const r = await handleToolCall("send_client_message", { caregiverId: "cg1", message: "hi", clientId: "c1" }) as any;
      expect(r._toolError).toBe(true);
      expect(r.code).toBe("FORBIDDEN");
    });

    it("posts into the shared thread and does not text the family directly (the trigger does, like a website message)", async () => {
      hoisted.collState.set("shifts", [{ caregiverId: "cg1", clientId: "c1", status: "scheduled", date: "2099-06-01" }]);
      hoisted.docState.set("users/c1", { phone: "+15555550100", name: "Sarah" });
      hoisted.docState.set("caregivers/cg1", { name: "Alice", membershipStatus: "active" });
      const r = await handleToolCall("send_client_message", { caregiverId: "cg1", message: "on my way", clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.sent).toBe(true);
      expect(trySend).not.toHaveBeenCalled();
    });

    describe("caregiver membership gate (Messages/Inbox parity)", () => {
      it("blocks when the caregiver has no membershipStatus/membershipPaid at all", async () => {
        hoisted.collState.set("shifts", [
          { caregiverId: "cg1", clientId: "c1", status: "scheduled", date: "2099-06-01" },
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
        hoisted.collState.set("shifts", [
          { caregiverId: "cg1", clientId: "c1", status: "scheduled", date: "2099-06-01" },
        ]);
        hoisted.docState.set("users/c1", { phone: "+15555550100" });
        hoisted.docState.set("caregivers/cg1", { name: "Alice", membershipPaid: true });
        const r = await handleToolCall("send_client_message", { caregiverId: "cg1", message: "hi", clientId: "c1" }) as any;
        expect(r.success).toBe(true);
      });

      it("allows membershipStatus: 'trialing'", async () => {
        hoisted.collState.set("shifts", [
          { caregiverId: "cg1", clientId: "c1", status: "scheduled", date: "2099-06-01" },
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

    it("posts the message and reports it sent — with no phone on file at all (the Inbox needs none)", async () => {
      seedVerifiedClient();
      hoisted.docState.set("caregivers/cg1", { name: "Alice" });
      const r = await handleToolCall("send_caregiver_message", { caregiverId: "cg1", message: "she napped well", clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.notification.sent).toBe(true);
      expect(r.sent).toBe(true);
    });

    it("does not text the caregiver itself — the chatRooms trigger notifies them exactly like a website message", async () => {
      seedVerifiedClient();
      hoisted.docState.set("caregivers/cg1", { name: "Alice", phone: "+15555550101" });
      const r = await handleToolCall("send_caregiver_message", { caregiverId: "cg1", message: "hi", clientId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(trySend).not.toHaveBeenCalled();
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
      hoisted.collState.set("shifts", [
        { caregiverId: "cg1", clientId: "c1", status: "scheduled", date: "2099-06-01" },
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

    it("send_caregiver_message still posts when the family's name is missing", async () => {
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
  describe("get_recent_messages — the website's Inbox page", () => {
    const roomId = ["c1", "cg1"].sort().join("_");

    it("requires userId", async () => {
      const r = await handleToolCall("get_recent_messages", {}) as any;
      expect(r._toolError).toBe(true);
    });

    it("returns an empty inbox when the user has no chatRooms", async () => {
      const r = await handleToolCall("get_recent_messages", { userId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.rooms).toEqual([]);
      expect(r.total).toBe(0);
      expect(r.unreadTotal).toBe(0);
    });

    it("ignores the unrelated `threads` (Evia-assistant) collection entirely", async () => {
      hoisted.docState.set("threads/cara_c1", { participants: ["c1", "cara"], updatedAt: "2026-08-31" });
      const r = await handleToolCall("get_recent_messages", { userId: "c1" }) as any;
      expect(r.rooms).toEqual([]);
    });

    it("lists the page: My Care Team / Other Caregivers / Support sections, last message or Start a conversation, unread, blocked hidden", async () => {
      hoisted.collState.set("chatRooms", [
        { id: roomId, participants: ["c1", "cg1"], participantNames: ["Sarah", "Alice"], lastMessage: "she napped well", lastMessageTime: "2026-09-16T20:00:00.000Z", unreadCount: { c1: 2, cg1: 0 } },
        { id: "c1_cg2", participants: ["c1", "cg2"], participantNames: ["Sarah", "Bob"], lastMessage: "", lastMessageTime: "", unreadCount: { c1: 0, cg2: 0 } },
        { id: "c1_support", participants: ["c1", "careconnex-support"], participantNames: ["Sarah", "Evia Support"], isSupport: true, lastMessage: "How can we help?", unreadCount: { c1: 1 } },
        { id: "c1_cg3", participants: ["c1", "cg3"], participantNames: ["Sarah", "Blocked Guy"], lastMessage: "hey", unreadCount: { c1: 5 } },
        { id: "c1_cg4", participants: ["c1", "cg4"], participantNames: ["Sarah", "Gone"], lastMessage: "bye", deletedAt: { c1: "2026-09-01T00:00:00.000Z" }, unreadCount: { c1: 1 } },
      ]);
      hoisted.collState.set("booking_requests", [{ id: "br1", clientId: "c1", caregiverId: "cg1", status: "accepted" }]);
      hoisted.docState.set("users/c1", { blockedUsers: ["cg3"] });
      const r = await handleToolCall("get_recent_messages", { userId: "c1" }) as any;
      expect(r.success).toBe(true);
      expect(r.sections.careTeam.map((x: any) => x.withName)).toEqual(["Alice"]);
      expect(r.sections.careTeam[0]).toMatchObject({ roomId, withId: "cg1", unread: 2, lastMessagePreview: "she napped well" });
      expect(r.sections.other.map((x: any) => x.withName)).toEqual(["Bob"]);
      expect(r.sections.other[0].lastMessagePreview).toBe("Start a conversation");
      expect(r.sections.support).toHaveLength(1);
      expect(r.rooms.some((x: any) => x.withId === "cg3" || x.withId === "cg4")).toBe(false);
      expect(r.unreadTotal).toBe(3);
    });

    it("query = the search box (contact name or last message)", async () => {
      hoisted.collState.set("chatRooms", [
        { id: roomId, participants: ["c1", "cg1"], participantNames: ["Sarah", "Alice"], lastMessage: "she napped well" },
        { id: "c1_cg2", participants: ["c1", "cg2"], participantNames: ["Sarah", "Bob"], lastMessage: "" },
      ]);
      const byName = await handleToolCall("get_recent_messages", { userId: "c1", query: "bob" }) as any;
      expect(byName.rooms.map((x: any) => x.withName)).toEqual(["Bob"]);
      const byText = await handleToolCall("get_recent_messages", { userId: "c1", query: "napped" }) as any;
      expect(byText.rooms.map((x: any) => x.withName)).toEqual(["Alice"]);
    });

    it("with counterpartId opens that conversation: oldest → newest, and marks it read like the page", async () => {
      hoisted.docState.set(`chatRooms/${roomId}`, { participants: ["c1", "cg1"], participantNames: ["Sarah", "Alice"], unreadCount: { c1: 1 } });
      // The mock's orderBy() is a passthrough, so seed newest-first like the real query; the code reverses it.
      hoisted.collState.set(`chatRooms/${roomId}/messages`, [
        { id: "m2", senderId: "c1",  senderName: "Sarah", text: "thank you!",       timestamp: "2026-09-16T20:05:00.000Z", isRead: true,  readBy: ["c1"] },
        { id: "m1", senderId: "cg1", senderName: "Alice", text: "she napped well", timestamp: "2026-09-16T20:00:00.000Z", isRead: false, readBy: [] },
      ]);
      const r = await handleToolCall("get_recent_messages", { userId: "c1", counterpartId: "cg1" }) as any;
      expect(r.success).toBe(true);
      expect(r.thread).toMatchObject({ roomId, withId: "cg1", withName: "Alice" });
      expect(r.thread.messages.map((m: any) => [m.from, m.text])).toEqual([["Alice", "she napped well"], ["you", "thank you!"]]);
      expect(r.thread.messages[0].date).toBe("2026-09-16");
      const readSet = hoisted.sets.find((s) => s.path === `chatRooms/${roomId}/messages/m1`);
      expect(readSet?.data).toMatchObject({ isRead: true, readBy: { __arrayUnion: ["c1"] } });
      const roomSet = hoisted.sets.find((s) => s.path === `chatRooms/${roomId}` && "unreadCount.c1" in s.data);
      expect(roomSet?.data["unreadCount.c1"]).toBe(0);
      expect(r.thread.messagesMarkedRead).toBe(1);
    });

    it("hides messages before the family's cutoff (deleted-then-resumed conversation), like the page", async () => {
      hoisted.docState.set(`chatRooms/${roomId}`, { participants: ["c1", "cg1"], participantNames: ["Sarah", "Alice"], messagesCutoff: { c1: "2026-09-10T00:00:00.000Z" } });
      hoisted.collState.set(`chatRooms/${roomId}/messages`, [
        { id: "m2", senderId: "cg1", senderName: "Alice", text: "new one", timestamp: "2026-09-16T20:00:00.000Z" },
        { id: "m1", senderId: "cg1", senderName: "Alice", text: "old one", timestamp: "2026-09-01T20:00:00.000Z" },
      ]);
      const r = await handleToolCall("get_recent_messages", { userId: "c1", counterpartId: "cg1" }) as any;
      expect(r.thread.messages.map((m: any) => m.text)).toEqual(["new one"]);
    });

    it("returns no thread for counterpartId when no room exists between the two", async () => {
      const r = await handleToolCall("get_recent_messages", { userId: "c1", counterpartId: "cg-ghost" }) as any;
      expect(r.success).toBe(true);
      expect(r.thread).toBeNull();
    });

    it("a soft-deleted room is hidden from the list and cannot be opened (deletedAt set, no new message since)", async () => {
      hoisted.collState.set("chatRooms", [
        { id: roomId, participants: ["c1", "cg1"], participantNames: ["Sarah", "Alice"], deletedAt: { c1: "2026-08-01" } },
      ]);
      hoisted.docState.set(`chatRooms/${roomId}`, { participants: ["c1", "cg1"], participantNames: ["Sarah", "Alice"], deletedAt: { c1: "2026-08-01" } });
      const list = await handleToolCall("get_recent_messages", { userId: "c1" }) as any;
      expect(list.rooms).toEqual([]);
      const open = await handleToolCall("get_recent_messages", { userId: "c1", counterpartId: "cg1" }) as any;
      expect(open.thread).toBeNull();
    });
  });

  // 2026-09-30: the caregiver's Inbox page — the same page, sections My Families /
  // Other Clients / Support; rooms the site created with a random id
  // (Families page getOrCreateChatRoom) are found by participants; the ⋮ menu
  // (Block / Report / Delete) is not offered for a care-team contact or the
  // Evia team thread.
  describe("caregiver Inbox", () => {
    it("role caregiver: My Families = partners on an accepted booking", async () => {
      hoisted.collState.set("chatRooms", [
        { id: "rAnDoM1", participants: ["cg1", "c1"], participantNames: ["Alice", "Sarah"], lastMessage: "see you at 7", unreadCount: { cg1: 1 } },
        { id: "c2_cg1", participants: ["c2", "cg1"], participantNames: ["Tom", "Alice"], lastMessage: "", unreadCount: { cg1: 0 } },
      ]);
      hoisted.collState.set("booking_requests", [{ id: "br1", clientId: "c1", caregiverId: "cg1", status: "accepted" }]);
      const r = await handleToolCall("get_recent_messages", { userId: "cg1", role: "caregiver" }) as any;
      expect(r.sections.careTeam.map((x: any) => x.withName)).toEqual(["Sarah"]);
      expect(r.sections.other.map((x: any) => x.withName)).toEqual(["Tom"]);
      expect(r.unreadTotal).toBe(1);
    });

    it("opens / marks read / deletes the room that EXISTS, even under a random id", async () => {
      hoisted.collState.set("chatRooms", [{ id: "rAnDoM1", participants: ["cg1", "c1"], participantNames: ["Alice", "Sarah"], unreadCount: { cg1: 1 } }]);
      hoisted.docState.set("chatRooms/rAnDoM1", { participants: ["cg1", "c1"], participantNames: ["Alice", "Sarah"], unreadCount: { cg1: 1 } });
      hoisted.collState.set("chatRooms/rAnDoM1/messages", [{ id: "m1", senderId: "c1", senderName: "Sarah", text: "see you at 7", timestamp: "2026-09-30T01:00:00.000Z", isRead: false, readBy: [] }]);
      const open = await handleToolCall("get_recent_messages", { userId: "cg1", counterpartId: "c1", role: "caregiver" }) as any;
      expect(open.thread).toMatchObject({ roomId: "rAnDoM1", withName: "Sarah" });
      expect(open.thread.messages.map((m: any) => m.text)).toEqual(["see you at 7"]);
      const marked = await handleToolCall("mark_messages_read", { userId: "cg1", counterpartId: "c1" }) as any;
      expect(marked.success).toBe(true);
      expect(hoisted.sets.some((s) => s.path === "chatRooms/rAnDoM1" && s.data["unreadCount.cg1"] === 0)).toBe(true);
      const del = await handleToolCall("delete_conversation", { userId: "cg1", counterpartId: "c1" }) as any;
      expect(del.deleted).toBe(true);
      expect(hoisted.sets.some((s) => s.path === "chatRooms/rAnDoM1" && s.data["deletedAt.cg1"])).toBe(true);
      expect(hoisted.sets.some((s) => s.path === `chatRooms/${["c1", "cg1"].sort().join("_")}`)).toBe(false); // no second room
    });

    it("the ⋮ menu rule: no delete / block / report for a care-team family or the Evia team thread", async () => {
      hoisted.docState.set("chatRooms/c1_cg1", { participants: ["c1", "cg1"] });
      hoisted.collState.set("booking_requests", [{ id: "br1", clientId: "c1", caregiverId: "cg1", status: "accepted" }]);
      const del = await handleToolCall("delete_conversation", { userId: "cg1", counterpartId: "c1" }) as any;
      expect(del._toolError).toBe(true);
      expect(del.message ?? del.error ?? JSON.stringify(del)).toMatch(/care team/);
      // _confirmedActionId bypasses the runtime HITL gate once a pending doc exists (see safety.test.ts).
      hoisted.docState.set("pending_actions/test", { toolName: "set_block_status", status: "awaiting", expiresAt: "2999-01-01T00:00:00.000Z" }); 
      const block = await handleToolCall("set_block_status", { userId: "cg1", targetUserId: "c1", action: "block", _confirmedActionId: "test" }) as any;
      expect(block._toolError).toBe(true);
      hoisted.docState.set("pending_actions/test", { toolName: "set_block_status", status: "awaiting", expiresAt: "2999-01-01T00:00:00.000Z" }); 
      const report = await handleToolCall("set_block_status", { userId: "cg1", targetUserId: "careconnex-support", action: "report", category: "other", description: "x", _confirmedActionId: "test" }) as any;
      expect(report._toolError).toBe(true);
      expect(JSON.stringify(report)).toMatch(/Evia team thread/);
      // Someone NOT on the care team can still be blocked, like the page.
      hoisted.collState.set("booking_requests", []);
      hoisted.docState.set("users/c9", { name: "Stranger" });
      hoisted.docState.set("pending_actions/test", { toolName: "set_block_status", status: "awaiting", expiresAt: "2999-01-01T00:00:00.000Z" }); 
      const ok = await handleToolCall("set_block_status", { userId: "cg1", targetUserId: "c9", action: "block", _confirmedActionId: "test" }) as any;
      expect(ok.blocked).toBe(true);
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
