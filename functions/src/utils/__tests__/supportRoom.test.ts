// One support room per person, same shape as the website's; the team is told
// when the person writes, the person is texted when the team replies, and
// Evia's own handoff lands in the same room without being texted back.
import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();
  const added: Array<{ coll: string; data: any }> = [];
  let n = 0;
  const makeDoc = (path: string): any => ({
    id: path.split("/").pop(), path,
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
    set: async (data: any) => { docs.set(path, { ...(docs.get(path) ?? {}), ...data }); },
    collection: (sub: string) => makeColl(`${path}/${sub}`),
  });
  const makeColl = (coll: string): any => ({
    doc: (id: string) => makeDoc(`${coll}/${id}`),
    add: async (data: any) => { const id = `auto-${++n}`; docs.set(`${coll}/${id}`, data); added.push({ coll, data }); return makeDoc(`${coll}/${id}`); },
    where: (f: string, _op: string, v: any) => ({
      get: async () => {
        const out = [...docs.entries()].filter(([p]) => p.startsWith(`${coll}/`) && p.split("/").length === coll.split("/").length + 1)
          .filter(([, d]) => Array.isArray(d?.[f]) && d[f].includes(v))
          .map(([p, d]) => ({ id: p.split("/").pop(), data: () => d }));
        return { docs: out, empty: out.length === 0 };
      },
    }),
  });
  return { docs, added, makeColl, reset: () => { docs.clear(); added.length = 0; n = 0; } };
});
vi.mock("firebase-admin", () => ({
  firestore: Object.assign(() => ({ collection: hoisted.makeColl }), { FieldValue: { serverTimestamp: () => "__ts__" } }),
}));

import { resolveSupportRouting, getOrCreateSupportRoom, relayToTeam, escalateToTeam, SUPPORT_AGENT_ID, SUPPORT_AGENT_NAME } from "../supportRoom";

beforeEach(() => { hoisted.reset(); hoisted.docs.set("users/u1", { firstName: "Hamse", lastName: "M" }); });

describe("resolveSupportRouting — who hears about a message in a support room", () => {
  const room = { participants: ["u1", SUPPORT_AGENT_ID], isSupport: true };
  it("the person wrote → alert the team; an admin wrote → relay to the person; system notes → nobody", () => {
    expect(resolveSupportRouting(room, { senderId: "u1", type: "text" })).toEqual({ kind: "alert_team", userId: "u1" });
    expect(resolveSupportRouting(room, { senderId: "admin-1", type: "text" })).toEqual({ kind: "relay_to_user", userId: "u1" });
    expect(resolveSupportRouting(room, { senderId: SUPPORT_AGENT_ID, type: "system" })).toEqual({ kind: "skip" });
    expect(resolveSupportRouting({ participants: ["u1", "cg1"] }, { senderId: "u1" })).toEqual({ kind: "not_support" });
  });
});

describe("the room", () => {
  it("is created once with the website's shape, then reused", async () => {
    const a = await getOrCreateSupportRoom("u1");
    const b = await getOrCreateSupportRoom("u1");
    expect(a).toBe(b);
    expect(hoisted.docs.get(`chatRooms/${a}`)).toMatchObject({
      participants: ["u1", SUPPORT_AGENT_ID], participantNames: ["Hamse M", SUPPORT_AGENT_NAME], isSupport: true,
      unreadCount: { u1: 0, [SUPPORT_AGENT_ID]: 0 },
    });
  });

  it("relayToTeam posts the person's own words as their message and bumps the team's unread", async () => {
    const { roomId } = await relayToTeam({ userId: "u1", text: "I want to talk to a person about my bill" });
    const msg = hoisted.added.find((a) => a.coll === `chatRooms/${roomId}/messages`)!.data;
    expect(msg).toMatchObject({ senderId: "u1", senderName: "Hamse M", text: "I want to talk to a person about my bill", type: "text" });
    expect(hoisted.docs.get(`chatRooms/${roomId}`)).toMatchObject({ lastMessage: "I want to talk to a person about my bill", unreadCount: { [SUPPORT_AGENT_ID]: 1 } });
    // No direct alert here — the room's onMessageSent trigger raises it, exactly as for the website button.
    expect(hoisted.added.find((a) => a.coll === "admin_alerts")).toBeUndefined();
  });

  it("escalateToTeam posts a system note (never texted back) and raises the team alert", async () => {
    const { roomId } = await escalateToTeam({ userId: "u1", note: "Evia wasn't confident: \"is my caregiver insured?\"", source: "evia_handoff", role: "client" });
    const msg = hoisted.added.find((a) => a.coll === `chatRooms/${roomId}/messages`)!.data;
    expect(msg).toMatchObject({ senderId: SUPPORT_AGENT_ID, senderName: "Evia", type: "system" });
    const alert = hoisted.added.find((a) => a.coll === "admin_alerts")!.data;
    expect(alert).toMatchObject({ type: "support_message", severity: "medium", userId: "u1", roomId, source: "evia_handoff", resolved: false });
  });
});
