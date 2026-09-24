import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const adds: Array<{ path: string; data: any }> = [];
  const makeDoc = (path: string): any => ({
    id: path.split("/").pop(), path,
    get: async () => ({ exists: docState.has(path), id: path.split("/").pop(), data: () => docState.get(path) }),
    update: async (data: any) => { docState.set(path, { ...(docState.get(path) ?? {}), ...data }); },
  });
  const makeQuery = (coll: string, conds: Array<[string, any]>): any => ({
    where: (f: string, _op: string, v: any) => makeQuery(coll, [...conds, [f, v]]),
    limit: () => makeQuery(coll, conds),
    get: async () => {
      const docs = [...docState.entries()].filter(([p]) => p.startsWith(`${coll}/`))
        .filter(([, d]) => conds.every(([f, v]) => d?.[f] === v))
        .map(([p, d]) => ({ id: p.slice(coll.length + 1), data: () => d, ref: makeDoc(p) }));
      return { empty: docs.length === 0, docs, size: docs.length };
    },
  });
  let auto = 0;
  const coll = (name: string): any => ({
    doc: (id: string) => makeDoc(`${name}/${id}`),
    where: (f: string, _op: string, v: any) => makeQuery(name, [[f, v]]),
    add: async (data: any) => { const id = `auto${++auto}`; docState.set(`${name}/${id}`, data); adds.push({ path: name, data }); return makeDoc(`${name}/${id}`); },
  });
  return { docState, adds, coll, reset: () => { docState.clear(); adds.length = 0; auto = 0; } };
});
vi.mock("firebase-admin", () => ({ firestore: Object.assign(() => ({ collection: hoisted.coll }), { FieldValue: {} }) }));
const sendViaInteractionAgent = vi.fn(async () => true);
vi.mock("./agents/caraAgent", () => ({ sendViaInteractionAgent: (...a: unknown[]) => sendViaInteractionAgent(...(a as [])) }));
vi.mock("./utils/caregiverPhone", () => ({ resolveCaregiverPhone: async (id: string) => (id === "cg1" ? "+15550001111" : undefined) }));

import { raiseFamilyEmergency } from "./emergency";

beforeEach(() => { hoisted.reset(); sendViaInteractionAgent.mockClear(); });

describe("raiseFamilyEmergency — the one path behind the site button and Evia's tool", () => {
  it("writes the banner's emergency_alerts doc, texts the caregiver on the visit, and pages the team", async () => {
    hoisted.docState.set("shifts/s1", { clientId: "c1", caregiverId: "cg1", status: "in-progress", clientName: "Anahi", careRecipients: [{ name: "Rosie" }] });
    const r = await raiseFamilyEmergency({ clientId: "c1", shiftId: "s1", note: "Mom fell", source: "site" });
    expect(r.status).toBe("active");
    expect(r.deduped).toBe(false);
    expect(r.caregiverNotified).toBe(true);
    const alert = hoisted.adds.find((a) => a.path === "emergency_alerts")!.data;
    expect(alert).toMatchObject({ initiatorId: "c1", initiatorType: "client", status: "active", shiftId: "s1", caregiverId: "cg1", note: "Mom fell", source: "site" });
    expect(sendViaInteractionAgent).toHaveBeenCalledWith("+15550001111", expect.objectContaining({ content: expect.stringContaining("Rosie"), preferredService: "SMS", canDrop: false }));
    expect(hoisted.adds.find((a) => a.path === "admin_alerts")!.data).toMatchObject({ type: "family_emergency", severity: "critical", clientId: "c1", caregiverId: "cg1" });
  });

  it("with no shiftId (Evia's tool) it finds today's visit itself and ignores another family's shift id", async () => {
    const today = new Date().toISOString().slice(0, 10);
    hoisted.docState.set("shifts/other", { clientId: "someone-else", caregiverId: "cgX", status: "in-progress" });
    hoisted.docState.set("shifts/s2", { clientId: "c1", caregiverId: "cg1", status: "scheduled", date: today });
    const r = await raiseFamilyEmergency({ clientId: "c1", shiftId: "other", source: "cara" });
    expect(hoisted.adds.find((a) => a.path === "emergency_alerts")!.data).toMatchObject({ shiftId: "s2", caregiverId: "cg1", source: "cara" });
    expect(r.caregiverNotified).toBe(true);
  });

  it("still raises the alert and pages the team when there is no visit to attach", async () => {
    const r = await raiseFamilyEmergency({ clientId: "c1", source: "cara", note: "fell" });
    expect(r.status).toBe("active");
    expect(r.caregiverNotified).toBe(false);
    expect(sendViaInteractionAgent).not.toHaveBeenCalled();
    expect(hoisted.adds.filter((a) => a.path === "admin_alerts")).toHaveLength(1);
  });

  it("a second call within two minutes returns the same active alert instead of paging twice", async () => {
    const first = await raiseFamilyEmergency({ clientId: "c1", source: "site" });
    const second = await raiseFamilyEmergency({ clientId: "c1", source: "cara" });
    expect(second.deduped).toBe(true);
    expect(second.alertId).toBe(first.alertId);
    expect(hoisted.adds.filter((a) => a.path === "admin_alerts")).toHaveLength(1);
  });
});
