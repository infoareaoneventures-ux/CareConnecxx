import { describe, it, expect, vi, beforeEach } from "vitest";

// The caregiver My Families page, texted (caregiverFamilies.ts): the page's two
// reads, its Active / Past rule, the card, View Details, and the keywords.

const hoisted = vi.hoisted(() => ({ docs: new Map<string, any>(), sent: [] as string[], sessionWrites: [] as any[], session: {} as Record<string, unknown> }));
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({
    collection: (name: string) => {
      const q = (filters: Array<[string, string, any]>): any => ({
        where: (f: string, op: string, v: any) => q([...filters, [f, op, v]]),
        orderBy: () => q(filters), limit: () => q(filters),
        get: vi.fn(async () => {
          const docs = [...hoisted.docs.entries()].filter(([p, d]) => p.startsWith(`${name}/`) && filters.every(([f, op, v]) => (op === "in" ? (v as any[]).includes(d[f]) : d[f] === v)))
            .map(([p, d]) => ({ id: p.split("/")[1], data: () => d }));
          return { docs, empty: docs.length === 0 };
        }),
      });
      return {
        where: (f: string, op: string, v: any) => q([[f, op, v]]),
        doc: (id: string) => ({
          get: vi.fn(async () => (name === "agent_sessions" ? { exists: true, data: () => hoisted.session } : { exists: hoisted.docs.has(`${name}/${id}`), id, data: () => hoisted.docs.get(`${name}/${id}`) })),
          set: vi.fn(async (d: any) => { if (name === "agent_sessions") { hoisted.sessionWrites.push(d); hoisted.session = { ...hoisted.session, ...d }; } }),
        }),
      };
    },
  }), { FieldValue: { delete: () => "__delete__" } });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("../../linq/client", () => ({ sendMessage: vi.fn(async (_c: string, m: string) => { hoisted.sent.push(m); return { message_id: "m" }; }) }));

import { loadFamilies, familiesText, familyDetailsText, handleFamiliesKeyword, sendCaregiverFamilies, EMPTY_ACTIVE, EMPTY_PAST } from "../caregiverFamilies";

const RECIPIENTS = [{ name: "H M", relationship: "parent", age: 82, notes: "Likes tea at 3.", careNeeds: ["Companionship", "Mobility Assistance"], careNeedDetails: { "Mobility Assistance": ["Transfer Assist"] }, lifestyle: { favoriteActivities: ["Gardening"], helpActivities: [], entertainment: [], enjoysConversation: true, prefersQuiet: null, familyInArea: true, familyVisitFreq: "Weekly", friendsVisitors: null, hasAppointments: true, appointmentsDetails: "Cardiology on Tuesdays" } }];
const booking = (id: string, over: Record<string, unknown>) => hoisted.docs.set(`booking_requests/${id}`, { caregiverId: "cg1", clientId: "fam1", clientName: "Basra Yousuf", status: "accepted", rate: 25, schedule: { dayShiftTimes: { Wed: [{ start: "19:30", end: "19:45" }], Mon: [{ start: "09:00", end: "12:00" }] } }, careRecipients: RECIPIENTS, emergencyContact: { name: "Ali", relationship: "son", phone: "555-1212" }, createdAt: { seconds: 100 }, ...over });
const shift = (id: string, over: Record<string, unknown>) => hoisted.docs.set(`shifts/${id}`, { caregiverId: "cg1", clientId: "fam1", bookingRequestId: "br1", status: "scheduled", date: "2099-01-01", ...over });

beforeEach(() => { hoisted.docs.clear(); hoisted.sent.length = 0; hoisted.sessionWrites.length = 0; hoisted.session = {}; });

describe("the page's Active / Past rule", () => {
  it("accepted + a visit left = Active; cancelled / completed / accepted-with-nothing-left = Past (most recent per family); a family is never in both", async () => {
    booking("br1", {});                                   // accepted, has a scheduled visit → Active
    shift("s1", {});
    booking("br0", { status: "completed", createdAt: { seconds: 50 } }); // same family earlier → NOT in Past (family is active)
    booking("br2", { clientId: "fam2", clientName: "Tom Nguyen", status: "cancelled", createdAt: { seconds: 10 } });
    booking("br3", { clientId: "fam2", clientName: "Tom Nguyen", status: "completed", createdAt: { seconds: 20 } }); // most recent past for fam2
    booking("br4", { clientId: "fam3", clientName: "Old Accepted", status: "accepted", createdAt: { seconds: 5 } });   // accepted but no visit left → Past
    booking("br5", { clientId: "fam4", clientName: "Still Pending", status: "pending" });                            // pending → neither tab
    const { active, past } = await loadFamilies("cg1");
    expect(active.map((f) => [f.name, f.bookingId, f.scheduleDays])).toEqual([["Basra Yousuf", "br1", ["Wed", "Mon"]]]); // the booking's own order, like the page
    expect(past.map((f) => [f.name, f.bookingId])).toEqual([["Tom Nguyen", "br3"], ["Old Accepted", "br4"]]);
  });
});

describe("the cards", () => {
  it("name · pill · $rate/hr · days · Caring for; 2 per text + MORE; empty states are the page's; search by name", () => {
    const f = (n: string, cid: string, source: "active" | "past") => ({ clientId: cid, bookingId: "b" + cid, name: n, source, scheduleDays: ["Mon", "Wed"], rate: 25, bookingStatus: "accepted", careRecipients: RECIPIENTS as any });
    const t = familiesText([f("Basra Yousuf", "fam1", "active"), f("Tom Nguyen", "fam2", "active"), f("Ana Silva", "fam3", "active")], { tab: "active" });
    expect(t.text).toBe("My Families · Active (3)\n\n1. Basra Yousuf · Active booking\n$25/hr\nMon · Wed\nCaring for: H M\n\n2. Tom Nguyen · Active booking\n$25/hr\nMon · Wed\nCaring for: H M\n\nReply FAMILY n for care details. To message a family, just tell me what to send. Reply PAST FAMILIES for past families. Reply MORE for more.");
    expect(t.items.map((i) => `${i.number}:${i.clientId}`)).toEqual(["1:fam1", "2:fam2", "3:fam3"]);
    expect(t.remaining).toBe(1);
    expect(familiesText([], { tab: "active" }).text).toBe(EMPTY_ACTIVE);
    expect(familiesText([], { tab: "past" }).text).toBe(EMPTY_PAST);
    expect(familiesText([f("Basra Yousuf", "fam1", "past")], { tab: "past", query: "bas" }).text).toContain('My Families · Past · "bas"\n\n1. Basra Yousuf · Past booking');
    expect(familiesText([f("Basra Yousuf", "fam1", "past")], { tab: "past", query: "zzz" }).text).toBe('No past families match "zzz".');
  });
});

describe("View Details", () => {
  it("per recipient: name, relationship · age, the note, Care Plan needs (no subtasks — the modal lists needs), Lifestyle; then Emergency Contact", () => {
    booking("br1", {});
    expect(familyDetailsText("Basra Yousuf", hoisted.docs.get("booking_requests/br1"))).toBe([
      "Basra Yousuf — Care details", "",
      "H M — parent · Age 82", '"Likes tea at 3."', "Care Plan", "• Companionship", "• Mobility Assistance",
      "Lifestyle", "Enjoys: Gardening", "Enjoys conversation: Yes", "Family in area: Yes", "Family visit frequency: Weekly", "Has appointments: Yes", "Appointments: Cardiology on Tuesdays",
      "", "Emergency Contact", "Ali · son · 555-1212",
    ].join("\n"));
    expect(familyDetailsText("X", null)).toBe("X — No details available.");
  });
});

describe("keywords", () => {
  it("FAMILIES / PAST FAMILIES text the tab and store the numbered list; FAMILY n texts the modal; MORE pages", async () => {
    booking("br1", {}); shift("s1", {});
    booking("br2", { clientId: "fam2", clientName: "Tom Nguyen", status: "completed" });
    expect(await handleFamiliesKeyword("+1", "chat", "cg1", "families", {})).toBe("handled");
    expect(hoisted.sent.at(-1)).toMatch(/^My Families · Active \(1\)\n\n1\. Basra Yousuf · Active booking/);
    const list = hoisted.sessionWrites.at(-1).lastFamilyList;
    expect(list.items[0]).toMatchObject({ number: 1, clientId: "fam1", bookingId: "br1" });
    expect(await handleFamiliesKeyword("+1", "chat", "cg1", "FAMILY 1", { lastFamilyList: list })).toBe("handled");
    expect(hoisted.sent.at(-1)).toMatch(/^Basra Yousuf — Care details\n\nH M — parent · Age 82/);
    expect(await handleFamiliesKeyword("+1", "chat", "cg1", "family 4", { lastFamilyList: list })).toBe("handled");
    expect(hoisted.sent.at(-1)).toMatch(/don't have a family 4/);
    expect(await handleFamiliesKeyword("+1", "chat", "cg1", "PAST FAMILIES", {})).toBe("handled");
    expect(hoisted.sent.at(-1)).toMatch(/^My Families · Past\n\n1\. Tom Nguyen · Past booking/);
    expect(await handleFamiliesKeyword("+1", "chat", "cg1", "who do I work with", {})).toBe("passthrough");
    const r = await sendCaregiverFamilies("+1", "chat", "cg1", { more: true });
    expect(r.tab).toBe("past"); // MORE continues the last tab
  });
});
