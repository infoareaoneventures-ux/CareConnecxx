import { describe, it, expect, vi, beforeEach } from "vitest";

// Caregiver sweep C15 (2026-10-11): the day-7 lock re-reads the record INSIDE
// the write — a consent given (or a clear landed) between the sweep's query and
// the lock is never locked over.

const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();
  const sets: Array<{ path: string; data: any }> = [];
  const makeDoc = (path: string): any => ({
    path,
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
    set: async (d: any) => { sets.push({ path, data: d }); docs.set(path, { ...(docs.get(path) ?? {}), ...d }); },
  });
  const firestore: any = () => ({
    collection: (c: string) => ({ doc: (id: string) => makeDoc(`${c}/${id}`), where: () => ({ get: async () => ({ docs: [] }) }) }),
    runTransaction: async (fn: (tx: any) => Promise<any>) => fn({
      get: async (ref: any) => ref.get(),
      set: (ref: any, d: any, _o?: any) => { sets.push({ path: ref.path, data: d }); docs.set(ref.path, { ...(docs.get(ref.path) ?? {}), ...d }); },
    }),
  });
  firestore.FieldValue = {};
  return { docs, sets, firestore };
});
vi.mock("firebase-admin", () => ({ __esModule: true, firestore: hoisted.firestore, default: { firestore: hoisted.firestore } }));
vi.mock("firebase-functions/v1", () => {
  const builder: any = { pubsub: { schedule: () => ({ timeZone: () => ({ onRun: (h: any) => h }) }) } };
  return { __esModule: true, ...builder, default: builder };
});

import { lockUnauthorizedRefresh } from "../renewalRefresh";

const DAY = 24 * 3600 * 1000;
const T0 = Date.parse("2026-10-01T12:00:00Z");
const asked = new Date(T0).toISOString();
const cleared = { verified: true, backgroundCheckStatus: "clear", backgroundCheckComplete: true, verificationStatus: "approved", backgroundCheckData: { status: "clear", checkrClearedAt: "2025-10-01T00:00:00Z" } };

beforeEach(() => { hoisted.docs.clear(); hoisted.sets.length = 0; });

describe("lockUnauthorizedRefresh", () => {
  it("still awaiting consent past day 7 → locked (the same reset the old renewal did), users mirror stamped", async () => {
    hoisted.docs.set("caregivers/cg1", { ...cleared, renewalRefresh: { status: "awaiting_consent", requestedAt: asked } });
    expect(await lockUnauthorizedRefresh("cg1", T0 + 7 * DAY)).toBe(true);
    expect(hoisted.docs.get("caregivers/cg1")).toMatchObject({ verified: false, backgroundCheckStatus: "pending", renewalRefresh: { status: "locked" } });
    expect(hoisted.sets.find((s) => s.path === "users/cg1")?.data).toEqual({ verificationStatus: "submitted" });
  });

  it("consent landed since the sweep read (status running) → NOT locked, record untouched", async () => {
    hoisted.docs.set("caregivers/cg1", { ...cleared, renewalRefresh: { status: "running", requestedAt: asked, authorizedAt: new Date(T0 + 7 * DAY - 60_000).toISOString() } });
    expect(await lockUnauthorizedRefresh("cg1", T0 + 7 * DAY)).toBe(false);
    expect(hoisted.sets).toHaveLength(0);
    expect(hoisted.docs.get("caregivers/cg1").verified).toBe(true);
  });

  it("the clear landed (status cleared) → NOT locked; a fresh consent stamp on the record also wins", async () => {
    hoisted.docs.set("caregivers/cg1", { ...cleared, renewalRefresh: { status: "cleared", requestedAt: asked } });
    expect(await lockUnauthorizedRefresh("cg1", T0 + 9 * DAY)).toBe(false);
    hoisted.docs.set("caregivers/cg2", { ...cleared, backgroundCheckData: { ...cleared.backgroundCheckData, consentGiven: true, consentGivenAt: new Date(T0 + 6 * DAY).toISOString() }, renewalRefresh: { status: "awaiting_consent", requestedAt: asked } });
    expect(await lockUnauthorizedRefresh("cg2", T0 + 7 * DAY)).toBe(false);
    expect(hoisted.sets).toHaveLength(0);
  });

  it("not yet day 7 on the fresh clock, or no record → nothing", async () => {
    hoisted.docs.set("caregivers/cg1", { ...cleared, renewalRefresh: { status: "awaiting_consent", requestedAt: asked } });
    expect(await lockUnauthorizedRefresh("cg1", T0 + 6 * DAY)).toBe(false);
    expect(await lockUnauthorizedRefresh("ghost", T0 + 30 * DAY)).toBe(false);
    expect(hoisted.sets).toHaveLength(0);
  });
});
