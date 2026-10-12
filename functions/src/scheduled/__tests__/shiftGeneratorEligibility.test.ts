import { describe, it, expect, vi, beforeEach } from "vitest";

// Caregiver sweep C17 (2026-10-11): generateRollingShifts never creates visits
// for a LOCKED caregiver (renewal lock / membership canceled / check not
// clear) — the one gate rule (utils/caregiverCanWork.ts canWork), skip + log.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const batchSets: any[] = [];
  const logs: string[] = [];
  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(), path,
    get: async () => ({ exists: docState.has(path), data: () => docState.get(path) }),
    set: async (d: any) => docState.set(path, d),
    update: async (d: any) => docState.set(path, { ...(docState.get(path) ?? {}), ...d }),
  });
  const makeCollRef = (path: string, filters: Array<[string, string, any]> = []): any => ({
    doc: (id?: string) => makeDocRef(`${path}/${id ?? `auto${batchSets.length}`}`),
    where: (f: string, op: string, v: any) => makeCollRef(path, [...filters, [f, op, v]]),
    orderBy: () => makeCollRef(path, filters),
    limit: () => makeCollRef(path, filters),
    get: async () => {
      const prefix = `${path}/`;
      const docs = [...docState.entries()]
        .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
        .filter(([, d]) => filters.every(([f, op, v]) => (op === "==" ? d?.[f] === v : op === "in" ? v.includes(d?.[f]) : true)))
        .map(([k, d]) => ({ id: k.slice(prefix.length), data: () => d, ref: makeDocRef(k) }));
      return { empty: docs.length === 0, docs };
    },
  });
  const dbMock = {
    collection: (p: string) => makeCollRef(p),
    batch: () => ({ set: (ref: any, d: any) => batchSets.push({ path: ref.path, data: d }), delete: () => {}, commit: async () => {} }),
  };
  return { docState, batchSets, logs, dbMock, reset: () => { docState.clear(); batchSets.length = 0; logs.length = 0; } };
});
vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => hoisted.dbMock },
  firestore: Object.assign(() => hoisted.dbMock, { FieldValue: { serverTimestamp: () => ({ __ts: true }), delete: () => ({ __delete: true }) }, Timestamp: { fromMillis: (ms: number) => ({ seconds: Math.floor(ms / 1000) }) } }),
}));
vi.mock("firebase-functions/v1", () => {
  const builder: any = { firestore: { document: () => ({ onWrite: (h: any) => h, onUpdate: (h: any) => h }) }, pubsub: { schedule: () => ({ onRun: (h: any) => h }) } };
  return { __esModule: true, ...builder, default: builder };
});
vi.mock("../../billing/membershipLapse", () => ({ applyMembershipLapse: vi.fn(async () => "ok") }));

import { generateRollingShifts, caregiverEligibleForNewVisits } from "../shiftGenerator";

const ACTIVE = { membershipStatus: "active", backgroundCheckStatus: "clear" };
const booking = (caregiverId: string) => ({
  status: "accepted", clientId: "fam1", caregiverId, caregiverName: "Alice", clientName: "The Nguyens",
  schedule: { ongoing: true, dayShiftTimes: { Mon: [{ start: "09:00", end: "12:00" }] } },
});

beforeEach(() => {
  hoisted.reset();
  hoisted.docState.set("_meta/shiftsCleanedUp", { cleanedAt: "x" }); // the one-time cleanup already ran
  vi.spyOn(console, "info").mockImplementation((...a: any[]) => { hoisted.logs.push(a.join(" ")); });
});

describe("caregiverEligibleForNewVisits — the one gate rule", () => {
  it("active membership (incl. Stripe's retry states) + cleared check → eligible; canceled / not clear / missing → not", async () => {
    hoisted.docState.set("caregivers/ok", ACTIVE);
    hoisted.docState.set("caregivers/retry", { membershipStatus: "past_due", verified: true });
    hoisted.docState.set("caregivers/legacy", { membershipPaid: true, backgroundCheckComplete: true });
    hoisted.docState.set("caregivers/canceled", { membershipStatus: "canceled", backgroundCheckStatus: "clear" });
    hoisted.docState.set("caregivers/locked", { membershipStatus: "active", backgroundCheckStatus: "pending", verified: false, renewalRefresh: { status: "locked" } });
    expect(await caregiverEligibleForNewVisits("ok")).toBe(true);
    expect(await caregiverEligibleForNewVisits("retry")).toBe(true);
    expect(await caregiverEligibleForNewVisits("legacy")).toBe(true);
    expect(await caregiverEligibleForNewVisits("canceled")).toBe(false);
    expect(await caregiverEligibleForNewVisits("locked")).toBe(false);
    expect(await caregiverEligibleForNewVisits("ghost")).toBe(false);
    expect(await caregiverEligibleForNewVisits("")).toBe(false);
  });
  it("one read per care provider per run (the cache)", async () => {
    hoisted.docState.set("caregivers/ok", ACTIVE);
    const cache = new Map<string, boolean>();
    expect(await caregiverEligibleForNewVisits("ok", cache)).toBe(true);
    hoisted.docState.set("caregivers/ok", { membershipStatus: "canceled" });
    expect(await caregiverEligibleForNewVisits("ok", cache)).toBe(true); // cached for this run
  });
});

describe("generateRollingShifts", () => {
  it("creates visits for an eligible care provider's booking and NONE for a locked one — skipped with a log line", async () => {
    hoisted.docState.set("caregivers/alice", ACTIVE);
    hoisted.docState.set("caregivers/bob", { membershipStatus: "canceled", backgroundCheckStatus: "clear" });
    hoisted.docState.set("booking_requests/br-alice", booking("alice"));
    hoisted.docState.set("booking_requests/br-bob", booking("bob"));
    await (generateRollingShifts as any)();
    const created = hoisted.batchSets.map((s) => s.data);
    expect(created.length).toBeGreaterThan(0);
    expect(created.every((s) => s.caregiverId === "alice" && s.bookingRequestId === "br-alice")).toBe(true);
    expect(hoisted.logs.some((l) => l.includes("caregiver bob is not eligible") && l.includes("br-bob"))).toBe(true);
  });
});
