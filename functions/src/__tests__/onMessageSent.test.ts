import { describe, it, expect, vi, beforeEach } from "vitest";

// Messages/Inbox parity audit (2026-08-31): onMessageSent was bound to
// `threads/{threadId}/messages`, the Evia-assistant chat-widget mirror
// (threads/cara_{uid}) — real caregiver<->client conversations live in
// `chatRooms`, so this trigger fired on every Evia-chat message and
// immediately no-opped, and never fired for a real website message at all.
// Re-pointed at chatRooms; these tests lock in the fixed behavior and the
// no-double-text guard for messages Evia already relayed by SMS.

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
  });

  return {
    docState, sets,
    collection: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); sets.length = 0; },
  };
});

vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({ collection: hoisted.collection }), {
    FieldValue: { serverTimestamp: () => ({ __serverTimestamp: true }) },
  });
  const stub = { apps: [{}], initializeApp: () => ({}), firestore };
  return { __esModule: true, default: stub, ...stub };
});

vi.mock("firebase-functions/v1", () => {
  const builder: any = {
    firestore: { document: () => ({ onCreate: (h: any) => h, onUpdate: (h: any) => h }) },
    pubsub: { schedule: () => ({ onRun: (h: any) => h }) },
  };
  return { __esModule: true, ...builder, default: builder };
});

const sendSMSToUser = vi.fn().mockResolvedValue({ success: true });
vi.mock("../sms", () => ({
  sendSMSToUser: (...a: unknown[]) => sendSMSToUser(...a),
  SMS_TEMPLATES: { newMessage: (name: string, text?: string) => text ? `Evia: New message from ${name}: "${text}" — reply here and I'll pass it along.` : `Evia: New message from ${name}. Open the app to reply.` },
}));

import { onMessageSent } from "../notifications";

function snap(data: any) {
  return { data: () => data };
}

const CLIENT = "client1";
const CAREGIVER = "cg1";
const ROOM_ID = [CLIENT, CAREGIVER].sort().join("_");

beforeEach(() => {
  hoisted.reset();
  sendSMSToUser.mockClear();
});

describe("onMessageSent (Messages/Inbox parity — reads chatRooms, not threads)", () => {
  it("texts the recipient for a real website-composed message", async () => {
    hoisted.docState.set(`chatRooms/${ROOM_ID}`, { participants: [CAREGIVER, CLIENT].sort() });
    const message = { senderId: CAREGIVER, senderName: "Alice", text: "on my way", type: "text" };
    await (onMessageSent as any)(snap(message), { params: { chatRoomId: ROOM_ID, messageId: "m1" } });
    expect(sendSMSToUser).toHaveBeenCalledWith(CLIENT, expect.stringContaining("New message from Alice"));
    // The message itself rides along — the family gets what was said, not just "open the app".
    expect(sendSMSToUser).toHaveBeenCalledWith(CLIENT, expect.stringContaining("on my way"));
  });

  it("writes an in-app notification for the recipient, not the sender", async () => {
    hoisted.docState.set(`chatRooms/${ROOM_ID}`, { participants: [CAREGIVER, CLIENT].sort() });
    const message = { senderId: CLIENT, senderName: "Sarah", text: "thank you!", type: "text" };
    await (onMessageSent as any)(snap(message), { params: { chatRoomId: ROOM_ID, messageId: "m1" } });
    const notifSet = hoisted.sets.find(s => s.path.startsWith(`users/${CAREGIVER}/notifications/`));
    expect(notifSet?.data).toMatchObject({ type: "message", title: expect.stringContaining("Sarah") });
  });

  it("texts a message Evia posted on someone's behalf too — one path for every chatRooms message (2026-09-17)", async () => {
    hoisted.docState.set(`chatRooms/${ROOM_ID}`, { participants: [CAREGIVER, CLIENT].sort() });
    const message = { senderId: CAREGIVER, senderName: "Alice", text: "on my way", type: "text" };
    await (onMessageSent as any)(snap(message), { params: { chatRoomId: ROOM_ID, messageId: "m1" } });
    expect(sendSMSToUser).toHaveBeenCalledTimes(1);
  });

  it("ignores system messages", async () => {
    hoisted.docState.set(`chatRooms/${ROOM_ID}`, { participants: [CAREGIVER, CLIENT].sort() });
    const message = { senderId: CAREGIVER, senderName: "Alice", text: "Booking confirmed", type: "system" };
    await (onMessageSent as any)(snap(message), { params: { chatRoomId: ROOM_ID, messageId: "m1" } });
    expect(sendSMSToUser).not.toHaveBeenCalled();
  });

  it("does not throttle — every message reaches the recipient as it happens", async () => {
    hoisted.docState.set(`chatRooms/${ROOM_ID}`, { participants: [CAREGIVER, CLIENT].sort() });
    hoisted.docState.set(`smsThrottles/lastMessageSMS_${ROOM_ID}_${CLIENT}`, { timestamp: { toMillis: () => Date.now() } });
    const message = { senderId: CAREGIVER, senderName: "Alice", text: "one more thing", type: "text" };
    await (onMessageSent as any)(snap(message), { params: { chatRoomId: ROOM_ID, messageId: "m2" } });
    expect(sendSMSToUser).toHaveBeenCalledWith(CLIENT, expect.stringContaining("one more thing"));
  });

  it("does nothing if the chatRoom doc is missing", async () => {
    const message = { senderId: CAREGIVER, senderName: "Alice", text: "hi", type: "text" };
    await (onMessageSent as any)(snap(message), { params: { chatRoomId: "ghost_room", messageId: "m1" } });
    expect(sendSMSToUser).not.toHaveBeenCalled();
  });
});
