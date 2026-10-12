import { describe, it, expect, vi, beforeEach } from "vitest";

// ONE shared pause/reactivate write for every door (B7, 2026-10-11). An Evia door
// texts its own confirmation line, so the write stamps `accountNoticeTexted`
// {kind, at} on the phone-keyed session BEFORE the record flips — the lifecycle
// notice (triggers/caregiverAccountEvents.ts) then keeps the bell and stands its
// text down. The site's queue action passes door: "site": no stamp, the text goes.

const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();
  const updates: Array<{ path: string; data: any }> = [];
  const makeDoc = (path: string): any => ({
    get: vi.fn(async () => ({ exists: docs.has(path), data: () => docs.get(path) })),
    update: vi.fn(async (data: any) => {
      if (!docs.has(path)) throw new Error(`NOT_FOUND: ${path}`); // Firestore update() never creates
      updates.push({ path, data }); docs.set(path, { ...docs.get(path), ...data });
    }),
  });
  const makeColl = (coll: string): any => ({
    doc: (id: string) => makeDoc(`${coll}/${id}`),
    where: () => ({ limit: () => ({ get: vi.fn(async () => ({ empty: true, docs: [] })) }) }),
  });
  return { docs, updates, collection: vi.fn((c: string) => makeColl(c)), reset: () => { docs.clear(); updates.length = 0; } };
});
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({ collection: hoisted.collection }), { FieldValue: { delete: () => "__DELETE__" } });
  return { __esModule: true, default: { firestore }, firestore };
});

import { pauseCaregiver, reactivateCaregiver, resolvePausedUntil, INDEFINITE_PAUSE_UNTIL } from "../pauseAccount";

const PHONE = "+15551112222";
const order = () => hoisted.updates.map((u) => u.path);

beforeEach(() => {
  hoisted.reset();
  hoisted.docs.set("caregivers/cg1", { name: "A" });
  hoisted.docs.set("users/cg1", { phone: PHONE });
  hoisted.docs.set(`agent_sessions/${PHONE}`, { userId: "cg1" });
});

describe("pauseCaregiver / reactivateCaregiver — one write, the door decides who texts", () => {
  it("an Evia door with the phone: stamps the session with the kind BEFORE the record flips, then writes the page's fields", async () => {
    await pauseCaregiver("cg1", "2026-11-01", { phone: PHONE });
    expect(order()).toEqual([`agent_sessions/${PHONE}`, "caregivers/cg1"]);
    expect(hoisted.docs.get(`agent_sessions/${PHONE}`).accountNoticeTexted).toMatchObject({ kind: "account_paused" });
    expect(Date.now() - Date.parse(hoisted.docs.get(`agent_sessions/${PHONE}`).accountNoticeTexted.at)).toBeLessThan(5000);
    expect(hoisted.docs.get("caregivers/cg1")).toMatchObject({ pausedUntil: "2026-11-01" });
    expect(hoisted.docs.get("caregivers/cg1").pausedAt).toBeTruthy();
  });

  it("an Evia door without the phone (the MCP tools): resolves it from the record and stamps the same way", async () => {
    await reactivateCaregiver("cg1");
    expect(order()).toEqual([`agent_sessions/${PHONE}`, "caregivers/cg1"]);
    expect(hoisted.docs.get(`agent_sessions/${PHONE}`).accountNoticeTexted).toMatchObject({ kind: "account_reactivated" });
    expect(hoisted.docs.get("caregivers/cg1")).toMatchObject({ pausedUntil: "__DELETE__", pausedAt: "__DELETE__" });
    expect(hoisted.docs.get("caregivers/cg1").reactivatedAt).toBeTruthy();
  });

  it("the site door never stamps — the lifecycle text is the site caregiver's only text", async () => {
    await pauseCaregiver("cg1", "indefinite", { door: "site" });
    expect(order()).toEqual(["caregivers/cg1"]);
    expect(hoisted.docs.get(`agent_sessions/${PHONE}`).accountNoticeTexted).toBeUndefined();
    expect(hoisted.docs.get("caregivers/cg1").pausedUntil).toBe(INDEFINITE_PAUSE_UNTIL);
    await reactivateCaregiver("cg1", { door: "site" });
    expect(order()).toEqual(["caregivers/cg1", "caregivers/cg1"]);
  });

  it("no session for the phone (or no phone at all): the stamp is skipped, never a stray session, and the record still flips", async () => {
    hoisted.docs.delete(`agent_sessions/${PHONE}`);
    await pauseCaregiver("cg1", "2026-11-01", { phone: PHONE });
    expect(order()).toEqual(["caregivers/cg1"]);
    expect(hoisted.docs.has(`agent_sessions/${PHONE}`)).toBe(false);
    hoisted.docs.delete("users/cg1");
    await reactivateCaregiver("cg1");
    expect(order()).toEqual(["caregivers/cg1", "caregivers/cg1"]);
  });

  it("an invalid date is rejected before any side effect — no stamp, no write", async () => {
    await expect(pauseCaregiver("cg1", "next Tuesday", { phone: PHONE })).rejects.toThrow(/invalid date/);
    expect(hoisted.updates).toHaveLength(0);
    expect(resolvePausedUntil("indefinite")).toBe(INDEFINITE_PAUSE_UNTIL);
  });
});
