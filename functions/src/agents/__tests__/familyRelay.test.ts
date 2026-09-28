import { describe, it, expect, vi, beforeEach } from "vitest";

// "Running late" the marketplace way (familyRelay.ts): the caregiver's own
// words go into the family's Inbox thread — the site's Message write — and
// Evia writes nothing to the family itself.

const hoisted = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  sent: [] as string[],
  relayed: [] as any[],
  sessionWrites: [] as any[],
}));
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: vi.fn(async () => ({ exists: hoisted.docs.has(`${name}/${id}`), data: () => hoisted.docs.get(`${name}/${id}`) })),
        update: vi.fn(async (d: any) => { if (name === "agent_sessions") hoisted.sessionWrites.push(d); }),
        set: vi.fn(async (d: any) => { if (name === "agent_sessions") hoisted.sessionWrites.push(d); }),
      }),
      where: (f: string, _o: string, v: any) => {
        const q = (filters: Array<[string, any]>) => ({
          where: (f2: string, _o2: string, v2: any) => q([...filters, [f2, v2]]),
          orderBy: () => ({ limit: () => ({ get: run(filters) }) }),
          get: run(filters),
        });
        const run = (filters: Array<[string, any]>) => vi.fn(async () => {
          const docs = [...hoisted.docs.entries()].filter(([p, d]) => p.startsWith(`${name}/`) && filters.every(([ff, vv]) => Array.isArray(vv) ? vv.includes(d[ff]) : d[ff] === vv)).map(([, d]) => ({ data: () => d }));
          return { docs, empty: docs.length === 0 };
        });
        return q([[f, v]]);
      },
    }),
  }), { FieldValue: { delete: () => "__delete__" } });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("../../linq/client", () => ({ sendMessage: vi.fn(async (_c: string, m: string) => { hoisted.sent.push(m); return { message_id: "m" }; }) }));
vi.mock("../../utils/chatThread", () => ({ relayIntoSharedChatThread: vi.fn(async (o: any) => { hoisted.relayed.push(o); }) }));

import { handleLateKeyword, relayLateSentence, relayCaregiverMessageToFamily } from "../familyRelay";
import { businessTodayStr } from "../../utils/scheduledTime";

beforeEach(() => {
  hoisted.docs.clear(); hoisted.sent.length = 0; hoisted.relayed.length = 0; hoisted.sessionWrites.length = 0;
  hoisted.docs.set("caregivers/cg1", { name: "Maria Garcia", membershipStatus: "active" });
  hoisted.docs.set("shifts/s1", { caregiverId: "cg1", clientId: "fam1", clientName: "Basra Yousuf", status: "scheduled", date: businessTodayStr(), startTime: "14:00" });
});

describe("LATE — the caregiver's words, posted as their Inbox message", () => {
  it("LATE asks what to tell the family and parks; the next text is relayed verbatim as the caregiver's message", async () => {
    expect(await handleLateKeyword("+1", "chat", "cg1", "LATE", {})).toBe("handled");
    expect(hoisted.sent[0]).toBe("What should I tell Basra Yousuf? I'll send it as your message.");
    expect(hoisted.sessionWrites[0].pendingFamilyMessage).toMatchObject({ clientId: "fam1", clientName: "Basra Yousuf" });
    expect(await handleLateKeyword("+1", "chat", "cg1", "Running about 15 minutes late, on my way!", { pendingFamilyMessage: { clientId: "fam1", clientName: "Basra Yousuf" } })).toBe("handled");
    expect(hoisted.relayed[0]).toEqual({ clientId: "fam1", clientName: "Basra Yousuf", caregiverId: "cg1", caregiverName: "Maria Garcia", senderId: "cg1", senderName: "Maria Garcia", text: "Running about 15 minutes late, on my way!" });
    expect(hoisted.sent.at(-1)).toBe("Sent to Basra Yousuf as your message.");
    expect(hoisted.sessionWrites.at(-1)).toEqual({ pendingFamilyMessage: "__delete__" });
  });
  it("NO / CANCEL backs out without sending; a plain late sentence is relayed as is", async () => {
    expect(await handleLateKeyword("+1", "chat", "cg1", "no", { pendingFamilyMessage: { clientId: "fam1", clientName: "Basra Yousuf" } })).toBe("handled");
    expect(hoisted.relayed).toHaveLength(0);
    expect(hoisted.sent.at(-1)).toBe("Okay — nothing sent.");
    expect(await relayLateSentence("chat", "cg1", "stuck in traffic, there by 2:15")).toBe(true);
    expect(hoisted.relayed[0].text).toBe("stuck in traffic, there by 2:15");
    expect(hoisted.sent.at(-1)).toBe('Sent to Basra Yousuf as your message: "stuck in traffic, there by 2:15"');
  });
  it("no visit on the schedule → says so; inactive membership → the Inbox's own block; anything else → passthrough", async () => {
    hoisted.docs.delete("shifts/s1");
    expect(await handleLateKeyword("+1", "chat", "cg1", "LATE", {})).toBe("handled");
    expect(hoisted.sent[0]).toMatch(/not sure which family/);
    hoisted.docs.set("caregivers/cg1", { name: "Maria Garcia", membershipStatus: "canceled" });
    const r = await relayCaregiverMessageToFamily("cg1", "hi", { clientId: "fam1", clientName: "Basra Yousuf" });
    expect(r).toMatchObject({ ok: false, reason: "membership" });
    expect(await handleLateKeyword("+1", "chat", "cg1", "what's my schedule?", {})).toBe("passthrough");
  });
});
