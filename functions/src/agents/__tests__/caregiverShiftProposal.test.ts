import { describe, it, expect, vi, beforeEach } from "vitest";

// The Active Bookings visit's reschedule strip by text (caregiver sweep B1 + B4,
// 2026-10-11): Accept new time / Decline / Withdraw — ONE implementation
// (caregiverShiftProposal.ts) behind the manage_shift_reschedule tool, the parked
// ACCEPT / DECLINE reply and the WITHDRAW keyword. Asserted against the page's
// own writes (CaregiverBookingsPage.tsx handleAcceptReschedule /
// handleClearReschedule) field for field, and its alert text verbatim.

const hoisted = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  updates: [] as Array<{ path: string; data: any }>,
  sessionSets: [] as any[],
  sessionUpdates: [] as any[],
  said: [] as string[],
}));
vi.mock("firebase-admin", () => {
  const where = (name: string, filters: Array<[string, string, any]>): any => ({
    where: (f: string, op: string, v: any) => where(name, [...filters, [f, op, v]]),
    get: vi.fn(async () => {
      const docs = [...hoisted.docs.entries()]
        .filter(([p]) => p.startsWith(`${name}/`))
        .filter(([, d]) => filters.every(([f, op, v]) => (op === "in" ? (v as any[]).includes(d[f]) : d[f] === v)))
        .map(([p, d]) => ({ id: p.split("/")[1], data: () => d }));
      return { docs, empty: docs.length === 0 };
    }),
  });
  const firestore = Object.assign(() => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: vi.fn(async () => ({ exists: hoisted.docs.has(`${name}/${id}`), data: () => hoisted.docs.get(`${name}/${id}`) })),
        update: vi.fn(async (d: any) => {
          if (name === "agent_sessions") { hoisted.sessionUpdates.push({ id, d }); return; }
          hoisted.updates.push({ path: `${name}/${id}`, data: d });
          const next = { ...(hoisted.docs.get(`${name}/${id}`) ?? {}) };
          for (const [k, v] of Object.entries(d)) { if ((v as any)?.__delete) delete next[k]; else next[k] = v; }
          hoisted.docs.set(`${name}/${id}`, next);
        }),
        set: vi.fn(async (d: any) => { if (name === "agent_sessions") hoisted.sessionSets.push({ id, d }); }),
      }),
      where: (f: string, op: string, v: any) => where(name, [[f, op, v]]),
    }),
  }), { FieldValue: { serverTimestamp: () => ({ __ts: true }), delete: () => ({ __delete: true }), arrayUnion: (...v: any[]) => ({ __arrayUnion: v }) } });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("../../linq/client", () => ({ sendMessage: vi.fn(async () => ({ message_id: "m" })) }));

import {
  acceptFamilyShiftProposal, declineFamilyShiftProposal, withdrawOwnShiftProposal, listPendingProposals, handleWithdrawKeyword,
  conflictAlert, visitWhen, proposalWhen, whichProposalPrompt, WITHDRAW_CHOICE_TTL_MS,
} from "../caregiverShiftProposal";

const CG = "cg1";
const base = { caregiverId: CG, clientId: "fam1", clientName: "Basra Yousuf", status: "scheduled", date: "2099-10-05", startTime: "11:00", endTime: "14:00" };
const familyProposal = { ...base, reschedulePendingDate: "2099-10-06", reschedulePendingStartTime: "12:00", reschedulePendingEndTime: "15:00", reschedulePendingAt: "2099-09-30T10:00:00.000Z", rescheduledBy: "client" };
const ownProposal = { ...familyProposal, rescheduledBy: "caregiver" };
const CLEARED = { reschedulePendingDate: { __delete: true }, reschedulePendingStartTime: { __delete: true }, reschedulePendingEndTime: { __delete: true }, reschedulePendingAt: { __delete: true }, rescheduledBy: { __delete: true } };
const say = async (m: string) => { hoisted.said.push(m); };

beforeEach(() => { hoisted.docs.clear(); hoisted.updates.length = 0; hoisted.sessionSets.length = 0; hoisted.sessionUpdates.length = 0; hoisted.said.length = 0; });

describe("display", () => {
  it("renders the strip's date + range and the page's conflict alert verbatim", () => {
    expect(visitWhen(base)).toBe("Mon, Oct 5, 2099, 11:00 AM – 2:00 PM");
    expect(proposalWhen(familyProposal)).toBe("Tue, Oct 6, 2099, 12:00 PM – 3:00 PM");
    expect(conflictAlert({ startTime: "12:30", endTime: "14:00" })).toBe("You already have another shift at 12:30 PM–2:00 PM that day — choose a different time.");
    expect(conflictAlert({ startTime: "12:30" })).toBe("You already have another shift at 12:30 PM that day — choose a different time.");
  });
});

describe("Accept new time — the page's handleAcceptReschedule", () => {
  it("checks the care provider's OTHER visits that day first (fetchOwnShiftsForDate + rangeConflicts) and refuses with the page's alert", async () => {
    hoisted.docs.set("shifts/s1", familyProposal);
    hoisted.docs.set("shifts/s2", { caregiverId: CG, status: "in-progress", date: "2099-10-06", startTime: "14:30", endTime: "16:00" });
    const r = await acceptFamilyShiftProposal(CG, "s1", "2099-10-01T00:00:00.000Z", "test");
    expect(r).toMatchObject({ ok: false, code: "CONFLICT", message: "You already have another shift at 2:30 PM–4:00 PM that day — choose a different time." });
    expect(hoisted.updates).toHaveLength(0);
  });
  it("moves the real date/startTime/endTime, clears the five pending fields, appends the history entry, stamps updatedAt — the page's write", async () => {
    hoisted.docs.set("shifts/s1", familyProposal);
    hoisted.docs.set("shifts/s3", { caregiverId: CG, status: "scheduled", date: "2099-10-06", startTime: "15:00", endTime: "17:00" }); // touching, not overlapping
    hoisted.docs.set("shifts/s4", { caregiverId: CG, status: "cancelled", date: "2099-10-06", startTime: "12:00", endTime: "13:00" }); // not active
    const r = await acceptFamilyShiftProposal(CG, "s1", "2099-10-01T00:00:00.000Z", "test");
    expect(r).toEqual({ ok: true, shiftId: "s1", clientName: "Basra Yousuf", from: { date: "2099-10-05", startTime: "11:00", endTime: "14:00" }, to: { date: "2099-10-06", startTime: "12:00", endTime: "15:00" } });
    expect(hoisted.updates[0].data).toEqual({
      date: "2099-10-06", startTime: "12:00", endTime: "15:00",
      ...CLEARED,
      rescheduleHistory: { __arrayUnion: [{
        from: { date: "2099-10-05", startTime: "11:00", endTime: "14:00" },
        to:   { date: "2099-10-06", startTime: "12:00", endTime: "15:00" },
        proposedBy: "client", proposedAt: "2099-09-30T10:00:00.000Z", acceptedBy: "caregiver", acceptedAt: "2099-10-01T00:00:00.000Z",
      }] },
      updatedAt: { __ts: true },
    });
  });
  it("refuses your own proposal, a visit that isn't yours, no proposal, a non-scheduled visit", async () => {
    hoisted.docs.set("shifts/s1", ownProposal);
    expect((await acceptFamilyShiftProposal(CG, "s1", "now", "t")) as any).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    hoisted.docs.set("shifts/s1", { ...familyProposal, caregiverId: "other" });
    expect((await acceptFamilyShiftProposal(CG, "s1", "now", "t")) as any).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    hoisted.docs.set("shifts/s1", base);
    expect((await acceptFamilyShiftProposal(CG, "s1", "now", "t")) as any).toMatchObject({ ok: false, code: "INVALID_INPUT", message: "There's no pending reschedule proposal on this visit" });
    hoisted.docs.set("shifts/s1", { ...familyProposal, status: "in-progress" });
    expect((await acceptFamilyShiftProposal(CG, "s1", "now", "t")) as any).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect((await acceptFamilyShiftProposal(CG, "nope", "now", "t")) as any).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(hoisted.updates).toHaveLength(0);
  });
});

describe("Decline / Withdraw — the page's handleClearReschedule (pending fields only, confirmed time untouched)", () => {
  it("decline clears the family's proposal", async () => {
    hoisted.docs.set("shifts/s1", familyProposal);
    const r = await declineFamilyShiftProposal(CG, "s1", "test");
    expect(r).toEqual({ ok: true, shiftId: "s1", clientName: "Basra Yousuf", from: { date: "2099-10-05", startTime: "11:00", endTime: "14:00" }, to: null });
    expect(hoisted.updates[0].data).toEqual({ ...CLEARED, updatedAt: { __ts: true } });
    expect(hoisted.docs.get("shifts/s1")).toMatchObject({ date: "2099-10-05", startTime: "11:00", endTime: "14:00" });
  });
  it("withdraw clears YOUR proposal; each refuses the other side's", async () => {
    hoisted.docs.set("shifts/s1", ownProposal);
    expect((await declineFamilyShiftProposal(CG, "s1", "t")) as any).toMatchObject({ ok: false, code: "INVALID_INPUT", message: "This proposal is your own — withdraw it instead of declining it" });
    const r = await withdrawOwnShiftProposal(CG, "s1", "t");
    expect(r).toMatchObject({ ok: true, clientName: "Basra Yousuf" });
    expect(hoisted.updates[0].data).toEqual({ ...CLEARED, updatedAt: { __ts: true } });
    hoisted.docs.set("shifts/s1", familyProposal);
    expect((await withdrawOwnShiftProposal(CG, "s1", "t")) as any).toMatchObject({ ok: false, code: "INVALID_INPUT", message: "This is the family's proposal — accept or decline it; there is nothing of yours to withdraw" });
  });
});

describe("WITHDRAW by text — the strip's Withdraw button (B4)", () => {
  it("lists only YOUR pending proposals on scheduled visits, date order", async () => {
    hoisted.docs.set("shifts/a", { ...ownProposal, date: "2099-10-12" });
    hoisted.docs.set("shifts/b", { ...ownProposal, date: "2099-10-05" });
    hoisted.docs.set("shifts/c", familyProposal);
    hoisted.docs.set("shifts/d", { ...ownProposal, status: "completed" });
    hoisted.docs.set("shifts/e", { ...ownProposal, caregiverId: "other" });
    const mine = await listPendingProposals(CG, "caregiver");
    expect(mine.map((m) => m.shiftId)).toEqual(["b", "a"]);
    expect(mine[0]).toMatchObject({ clientName: "Basra Yousuf", by: "caregiver", when: "Mon, Oct 5, 2099, 11:00 AM – 2:00 PM", proposed: "Tue, Oct 6, 2099, 12:00 PM – 3:00 PM", line: "your visit with Basra Yousuf on Mon, Oct 5, 2099, 11:00 AM – 2:00 PM" });
    expect((await listPendingProposals(CG, "client")).map((m) => m.shiftId)).toEqual(["c"]);
  });
  it("nothing out → told; one out → withdrawn (the page's write) and confirmed naming the family and the time that stands", async () => {
    expect(await handleWithdrawKeyword("+1", "chat", CG, "WITHDRAW", {}, { say })).toBe("handled");
    expect(hoisted.said).toEqual(["You don't have a reschedule proposal out on any visit — nothing to withdraw."]);
    hoisted.said.length = 0;
    hoisted.docs.set("shifts/s1", ownProposal);
    expect(await handleWithdrawKeyword("+1", "chat", CG, "withdraw", {}, { say })).toBe("handled");
    expect(hoisted.updates[0]).toEqual({ path: "shifts/s1", data: { ...CLEARED, updatedAt: { __ts: true } } });
    expect(hoisted.said).toEqual(["Withdrawn — your visit with Basra Yousuf stays at Mon, Oct 5, 2099, 11:00 AM – 2:00 PM."]);
    expect(hoisted.sessionSets).toHaveLength(0);
  });
  it("several out → 'Which visit?' parked (30 min); a number or the family's name picks; CANCEL backs out; anything else re-asks", async () => {
    hoisted.docs.set("shifts/a", { ...ownProposal, date: "2099-10-12", clientName: "Fam Two" });
    hoisted.docs.set("shifts/b", ownProposal);
    expect(await handleWithdrawKeyword("+1", "chat", CG, "WITHDRAW", {}, { say, nowMs: 1_000_000 })).toBe("handled");
    const parked = hoisted.sessionSets[0].d.pendingWithdrawChoice;
    expect(parked.candidates.map((c: any) => c.shiftId)).toEqual(["b", "a"]);
    expect(parked.expiresAt).toBe(new Date(1_000_000 + WITHDRAW_CHOICE_TTL_MS).toISOString());
    expect(hoisted.said[0]).toBe(whichProposalPrompt(parked.candidates));
    expect(hoisted.said[0]).toMatch(/^Which visit\? Reply 1 for your visit with Basra Yousuf on Mon, Oct 5, 2099, 11:00 AM – 2:00 PM \(proposed Tue, Oct 6, 2099, 12:00 PM – 3:00 PM\), Reply 2 for your visit with Fam Two on /);
    expect(hoisted.updates).toHaveLength(0);
    hoisted.said.length = 0;
    const session = { pendingWithdrawChoice: parked };
    expect(await handleWithdrawKeyword("+1", "chat", CG, "maybe", session, { say, nowMs: 1_000_000 })).toBe("handled");
    expect(hoisted.said[0]).toMatch(/^Which visit\?/);
    expect(await handleWithdrawKeyword("+1", "chat", CG, "2", session, { say, nowMs: 1_000_000 })).toBe("handled");
    expect(hoisted.updates[0].path).toBe("shifts/a");
    expect(hoisted.said.at(-1)).toBe("Withdrawn — your visit with Fam Two stays at Mon, Oct 12, 2099, 11:00 AM – 2:00 PM.");
    expect(hoisted.sessionUpdates.at(-1)?.d).toEqual({ pendingWithdrawChoice: { __delete: true } });
    hoisted.updates.length = 0;
    expect(await handleWithdrawKeyword("+1", "chat", CG, "Basra", session, { say, nowMs: 1_000_000 })).toBe("handled");
    expect(hoisted.updates[0].path).toBe("shifts/b");
    hoisted.said.length = 0; hoisted.updates.length = 0;
    expect(await handleWithdrawKeyword("+1", "chat", CG, "CANCEL", session, { say, nowMs: 1_000_000 })).toBe("handled");
    expect(hoisted.said).toEqual(["Okay — nothing changed."]);
    expect(hoisted.updates).toHaveLength(0);
    // Expired pick → dropped, and the text routes on as if nothing were parked.
    expect(await handleWithdrawKeyword("+1", "chat", CG, "2", { pendingWithdrawChoice: { ...parked, expiresAt: new Date(1_000).toISOString() } }, { say, nowMs: 1_000_000 })).toBe("passthrough");
  });
  it("any other text passes through untouched (no reads)", async () => {
    expect(await handleWithdrawKeyword("+1", "chat", CG, "what jobs are near me?", {}, { say })).toBe("passthrough");
    expect(hoisted.said).toHaveLength(0);
  });
});
