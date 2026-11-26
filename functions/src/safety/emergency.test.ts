// Who is told, what they are told, and that the reply never claims more than happened (founders, 2026-11-26).
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ docs: new Map<string, any>(), visits: [] as any[], alerts: [] as any[], sends: [] as any[], held: [] as any[] }));
vi.mock("firebase-admin", () => {
  const ref = (path: string): any => ({
    get: async () => ({ exists: h.docs.has(path), data: () => h.docs.get(path) }),
    set: async (d: any) => { h.docs.set(path, { ...(h.docs.get(path) ?? {}), ...d }); },
    delete: async () => { h.docs.delete(path); },
    update: async (d: any) => { Object.assign(h.alerts[h.alerts.length - 1], d); },
  });
  const firestore = () => ({ collection: (c: string) => ({ doc: (id: string) => ref(`${c}/${id}`), add: async (d: any) => { h.alerts.push({ ...d }); return ref(`${c}/a`); } }) });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("../linq/client", () => ({ sendToPhone: vi.fn(async (phone: string, text: string) => { h.sends.push({ phone, text }); h.docs.set(`agent_sessions/${phone}`, h.docs.get(`agent_sessions/${phone}`) ?? { phone }); return "sent"; }) }));
vi.mock("../utils/visitQuery", () => ({
  queryVisits: vi.fn(async (p: any) => h.visits.filter((v) => p.shiftStatuses.includes(v.status) && p.extraWhere.every(([f, , x]: any) => v[f] === x)).map((v) => ({ data: () => v }))),
}));
vi.mock("../utils/caregiverPhone", () => ({ resolveCaregiverPhone: async () => "(408) 555-0102" }));
vi.mock("../utils/scheduledTime", () => ({ businessTodayStr: () => "2099-01-01" }));
vi.mock("../utils/openaiClient", () => ({ quickComplete: vi.fn(async () => "NONE") }));
vi.mock("../agents/humanMode", () => ({ setHumanMode: vi.fn(async (a: any) => { h.held.push(a); return {}; }) }));

import { escalateEmergency, contactText, toE164 } from "./emergency";

const FAMILY = "+14085550101", CG = "+14085550102", SON = "+14085550103";
const medical = { kind: "medical" as const, aboutSelf: false };
const selfHarm = { kind: "emotional" as const, aboutSelf: true };
const visit = (over = {}) => ({ clientId: "fam", caregiverId: "cg", caregiverName: "Riya", status: "in-progress", date: "2099-01-01", ...over });
const run = (phone: string, assessment: any, session: any, text = "The client fell") => escalateEmergency({ phone, text, assessment, session, channel: "text" });

beforeEach(() => {
  h.docs.clear(); h.visits.length = 0; h.alerts.length = 0; h.sends.length = 0; h.held.length = 0;
  h.docs.set("users/fam", { firstName: "Usman", phone: FAMILY });
  h.docs.set("users/cg", { firstName: "Riya", phone: CG });
  h.docs.set("care_plans/fam", { emergencyContacts: [{ name: "Sam", phone: "408-555-0103" }] });
});

describe("care provider reports a medical emergency during a visit", () => {
  it("texts the family and their emergency contact with what was said, pages the team and pauses nothing", async () => {
    h.visits.push(visit());
    const r = await run(CG, medical, { userId: "cg", userType: "caregiver" });
    expect(h.sends.map((s) => s.phone).sort()).toEqual([FAMILY, SON]);
    expect(h.sends[0].text).toContain('"The client fell"');
    expect(h.sends[0].text).toContain("call 911");
    expect(r.notified.sort()).toEqual(["Sam", "Usman"]);
    expect(h.alerts[0]).toMatchObject({ type: "emergency", severity: "critical", kind: "medical", said: "The client fell" });
    expect(h.held).toHaveLength(0); // the visit keywords and the conversation carry on
    // The contact was not a user: no session is left behind for them.
    expect(h.docs.has(`agent_sessions/${SON}`)).toBe(false);
  });
  it("with two families today and no visit running, texts nobody and says why", async () => {
    h.visits.push(visit({ status: "scheduled" }), visit({ status: "scheduled", clientId: "other" }));
    const r = await run(CG, medical, { userId: "cg", userType: "caregiver" });
    expect(h.sends).toHaveLength(0);
    expect(r.teamAlerted).toBe(true);
    expect(h.alerts[0].note).toContain("Several families");
  });
});

describe("self-harm", () => {
  it("a care provider's own crisis goes to the team only — never the family", async () => {
    h.visits.push(visit());
    const r = await run(CG, selfHarm, { userId: "cg", userType: "caregiver" }, "I want to die");
    expect(h.sends).toHaveLength(0);
    expect(r).toEqual({ notified: [], teamAlerted: true });
  });
  it("a family member's crisis texts their contact and today's care provider WITHOUT quoting it", async () => {
    h.visits.push(visit());
    await run(FAMILY, selfHarm, { userId: "fam", userType: "client" }, "I want to die");
    expect(h.sends.map((s) => s.phone).sort()).toEqual([CG, SON]);
    for (const s of h.sends) expect(s.text).not.toContain("I want to die");
  });
});

describe("limits", () => {
  it("an unexplained plea pages the team only", async () => {
    h.visits.push(visit());
    await run(CG, { kind: "help", aboutSelf: true }, { userId: "cg", userType: "caregiver" }, "I need help");
    expect(h.sends).toHaveLength(0);
    expect(h.held).toHaveLength(0);
    expect(h.alerts[0]).toMatchObject({ severity: "high", kind: "help" });
  });
  it("a number with no account pages the team and texts nobody", async () => {
    const r = await run("+14085550999", medical, null);
    expect(h.sends).toHaveLength(0);
    expect(r.teamAlerted).toBe(true);
  });
  it("does not text the same people again within 30 minutes", async () => {
    h.visits.push(visit());
    await run(CG, medical, { userId: "cg", userType: "caregiver", emergencyNotified: { at: new Date().toISOString(), kind: "medical" } });
    expect(h.sends).toHaveLength(0);
    expect(h.held).toHaveLength(0);
    expect(h.alerts).toHaveLength(1);
  });
  it("normalises numbers and refuses junk", () => {
    expect(toE164("(408) 555-0103")).toBe(SON);
    expect(toE164("n/a")).toBeNull();
    expect(contactText("emotional", "Usman", false, "secret")).not.toContain("secret");
  });
});
