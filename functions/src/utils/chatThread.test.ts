import { describe, it, expect, vi, beforeEach } from "vitest";

// Mirrors chatService.ts's sendMessage exactly (2026-08-24 fix): a relayed
// message must clear deletedAt for BOTH participants (not just the sender),
// preserving any prior deletedAt as messagesCutoff — otherwise a message
// relayed after the RECIPIENT had soft-deleted the conversation went silently
// missing from their inbox.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const sets: Array<{ path: string; data: any; opts?: any }> = [];

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({ exists: docState.has(path), data: () => docState.get(path) }),
    set: async (data: any, opts?: any) => {
      sets.push({ path, data, opts });
      docState.set(path, opts?.merge ? { ...(docState.get(path) ?? {}), ...data } : data);
    },
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });

  const makeCollRef = (path: string): any => ({
    doc: (id?: string) => makeDocRef(`${path}/${id ?? "auto"}`),
    // array-contains on `participants` over the docs seeded under this path (findChatRoomFor).
    where: (_f: string, _op: string, v: any) => ({
      get: async () => {
        const docs = [...docState.entries()]
          .filter(([p, d]) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes("/") && Array.isArray(d?.participants) && d.participants.includes(v))
          .map(([p, d]) => ({ id: p.split("/").pop(), data: () => d }));
        return { docs, empty: docs.length === 0 };
      },
    }),
  });

  return {
    docState, sets,
    collection: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); sets.length = 0; },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collection }) },
  firestore: Object.assign(() => ({ collection: hoisted.collection }), {
    FieldValue: {
      serverTimestamp: () => ({ __serverTimestamp: true }),
      increment:       (n: number) => ({ __increment: n }),
      delete:          () => ({ __delete: true }),
    },
  }),
}));

import { relayIntoSharedChatThread, chatRoomIdFor, findChatRoomFor } from "./chatThread";

const CLIENT = "client_1";
const CAREGIVER = "cg_1";
const ROOM_ID = chatRoomIdFor(CLIENT, CAREGIVER);

describe("relayIntoSharedChatThread", () => {
  beforeEach(() => hoisted.reset());

  it("clears deletedAt for BOTH participants, not just the sender", async () => {
    hoisted.docState.set(`chatRooms/${ROOM_ID}`, {
      participants: [CAREGIVER, CLIENT].sort(),
      deletedAt: { [CLIENT]: { __ts: "old" } }, // client had soft-deleted the thread
    });

    await relayIntoSharedChatThread({
      clientId: CLIENT, clientName: "Sarah",
      caregiverId: CAREGIVER, caregiverName: "Alice",
      senderId: CAREGIVER, senderName: "Alice",
      text: "on my way",
    });

    const roomSet = hoisted.sets.find(s => s.path === `chatRooms/${ROOM_ID}` && s.opts?.merge);
    expect(roomSet).toBeTruthy();
    expect(roomSet!.data[`deletedAt.${CLIENT}`]).toEqual({ __delete: true });
    expect(roomSet!.data[`deletedAt.${CAREGIVER}`]).toEqual({ __delete: true });
  });

  it("preserves a cleared deletedAt as messagesCutoff so pre-deletion history stays hidden", async () => {
    const oldDeletedAt = { __ts: "old" };
    hoisted.docState.set(`chatRooms/${ROOM_ID}`, {
      participants: [CAREGIVER, CLIENT].sort(),
      deletedAt: { [CLIENT]: oldDeletedAt },
    });

    await relayIntoSharedChatThread({
      clientId: CLIENT, clientName: "Sarah",
      caregiverId: CAREGIVER, caregiverName: "Alice",
      senderId: CAREGIVER, senderName: "Alice",
      text: "on my way",
    });

    const roomSet = hoisted.sets.find(s => s.path === `chatRooms/${ROOM_ID}` && s.opts?.merge);
    expect(roomSet!.data[`messagesCutoff.${CLIENT}`]).toBe(oldDeletedAt);
  });

  it("increments unreadCount only for the recipient, not the sender", async () => {
    await relayIntoSharedChatThread({
      clientId: CLIENT, clientName: "Sarah",
      caregiverId: CAREGIVER, caregiverName: "Alice",
      senderId: CLIENT, senderName: "Sarah",
      text: "hi",
    });

    const roomSet = hoisted.sets.find(s => s.path === `chatRooms/${ROOM_ID}` && s.opts?.merge);
    expect(roomSet!.data[`unreadCount.${CAREGIVER}`]).toEqual({ __increment: 1 });
    expect(roomSet!.data[`unreadCount.${CLIENT}`]).toBeUndefined();
  });

  it("reuses the pair's existing room even when the site created it with a random id (Families page getOrCreateChatRoom) — never a second room", async () => {
    hoisted.docState.set("chatRooms/rAnDoM123", { participants: [CAREGIVER, CLIENT], participantNames: ["Alice", "Sarah"], lastMessageTimestamp: { seconds: 100 } });
    hoisted.docState.set("chatRooms/support_x", { participants: [CAREGIVER, "careconnex-support"], isSupport: true });
    expect((await findChatRoomFor(CAREGIVER, CLIENT))?.id).toBe("rAnDoM123");
    expect(await findChatRoomFor(CAREGIVER, "nobody")).toBeNull();
    await relayIntoSharedChatThread({
      clientId: CLIENT, clientName: "Sarah",
      caregiverId: CAREGIVER, caregiverName: "Alice",
      senderId: CAREGIVER, senderName: "Alice",
      text: "on my way",
    });
    expect(hoisted.sets.some((s) => s.path.startsWith("chatRooms/rAnDoM123/messages/"))).toBe(true);
    expect(hoisted.sets.some((s) => s.path === `chatRooms/${ROOM_ID}`)).toBe(false);
  });

  it("creates the room doc with both participants when it doesn't exist yet", async () => {
    await relayIntoSharedChatThread({
      clientId: CLIENT, clientName: "Sarah",
      caregiverId: CAREGIVER, caregiverName: "Alice",
      senderId: CLIENT, senderName: "Sarah",
      text: "hi",
    });

    const created = hoisted.sets.find(s => s.path === `chatRooms/${ROOM_ID}` && !s.opts?.merge);
    expect(created?.data.participants).toEqual([CAREGIVER, CLIENT].sort());
  });

  it("writes the message into the room's messages subcollection", async () => {
    await relayIntoSharedChatThread({
      clientId: CLIENT, clientName: "Sarah",
      caregiverId: CAREGIVER, caregiverName: "Alice",
      senderId: CLIENT, senderName: "Sarah",
      text: "hi there",
    });

    const messageSet = hoisted.sets.find(s => s.path.startsWith(`chatRooms/${ROOM_ID}/messages/`));
    expect(messageSet?.data).toMatchObject({ senderId: CLIENT, senderName: "Sarah", text: "hi there", type: "text" });
  });

  // 2026-09-17: Inbox parity — the message doc is exactly chatService.sendMessage's
  // shape. No Evia-only marker: the chatRooms message-created trigger notifies
  // the recipient for this message the same way it does for one typed on the site.
  it("writes the site's message shape with no Evia-only marker (no viaAgent)", async () => {
    await relayIntoSharedChatThread({
      clientId: CLIENT, clientName: "Sarah",
      caregiverId: CAREGIVER, caregiverName: "Alice",
      senderId: CLIENT, senderName: "Sarah",
      text: "hi there",
    });

    const messageSet = hoisted.sets.find(s => s.path.startsWith(`chatRooms/${ROOM_ID}/messages/`));
    expect(messageSet?.data.viaAgent).toBeUndefined();
    expect(messageSet?.data).toMatchObject({ senderId: CLIENT, senderName: "Sarah", text: "hi there", type: "text", isRead: false, readBy: [], imageUrl: null });
  });
});
