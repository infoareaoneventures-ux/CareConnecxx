import { describe, it, expect, beforeEach, vi } from "vitest";

// 2026-09-06: the real SMS/TCPA opt-out (agent_sessions.optedOut, set by the
// STOP keyword — sms.ts's optOutPhoneNumber) used to be checked nowhere in
// the caregiver-matching pipeline. This trigger mirrors it onto the
// caregiver's own doc so the shared isCaregiverBookable() gate (a pure,
// dependency-free function that can't do a second collection lookup itself)
// can see it as a plain field, the same pattern pausedUntil already uses.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const makeDocRef = (path: string): any => {
    const ref: any = {
      id: path.split("/").pop(),
      path,
      update: async (data: Record<string, any>) => {
        docState.set(path, { ...(docState.get(path) ?? {}), ...data });
      },
    };
    ref.get = async () => ({ exists: docState.has(path), data: () => docState.get(path), ref });
    return ref;
  };
  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id: string) => makeDocRef(`${path}/${id}`);
    let whereField = "";
    let whereValue: unknown;
    ref.where = (field: string, _op: string, value: unknown) => { whereField = field; whereValue = value; return ref; };
    ref.limit = () => ref;
    ref.get = async () => {
      const matches = [...docState.entries()]
        .filter(([p]) => p.startsWith(`${path}/`) && p.split("/").length === path.split("/").length + 1)
        .filter(([, d]) => !whereField || d?.[whereField] === whereValue);
      return { docs: matches.map(([p, d]) => ({ id: p.split("/").pop(), data: () => d })) };
    };
    return ref;
  };
  return {
    docState,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => docState.clear(),
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collectionMock }) },
  firestore: () => ({ collection: hoisted.collectionMock }),
}));

vi.mock("firebase-functions/v1", () => {
  const builder: any = { firestore: { document: () => ({ onWrite: (h: any) => h }) } };
  return { __esModule: true, ...builder, default: builder };
});

import { mirrorCaregiverOptOut } from "../caregiverOptOutMirror";

function change(before: any, after: any) {
  return {
    before: { exists: before !== null, data: () => before },
    after: { exists: after !== null, data: () => after },
  };
}

const PHONE = "+15551234567";

beforeEach(() => {
  hoisted.reset();
});

describe("mirrorCaregiverOptOut", () => {
  it("mirrors optedOut:true onto the caregiver doc, resolved via session.caregiverId", async () => {
    hoisted.docState.set("caregivers/cg1", { name: "Alice" });
    const before = { userType: "caregiver", caregiverId: "cg1", optedOut: false };
    const after  = { ...before, optedOut: true };
    await (mirrorCaregiverOptOut as any)(change(before, after), { params: { phone: PHONE } });
    expect(hoisted.docState.get("caregivers/cg1")?.optedOut).toBe(true);
  });

  it("mirrors optedOut:false when a caregiver re-opts-in (START)", async () => {
    hoisted.docState.set("caregivers/cg1", { name: "Alice", optedOut: true });
    const before = { userType: "caregiver", caregiverId: "cg1", optedOut: true };
    const after  = { ...before, optedOut: false };
    await (mirrorCaregiverOptOut as any)(change(before, after), { params: { phone: PHONE } });
    expect(hoisted.docState.get("caregivers/cg1")?.optedOut).toBe(false);
  });

  it("resolves the caregiver by phone when caregiverId isn't on the session", async () => {
    hoisted.docState.set("caregivers/cg1", { name: "Alice", phone: PHONE });
    const before = { userType: "caregiver", optedOut: false };
    const after  = { ...before, optedOut: true };
    await (mirrorCaregiverOptOut as any)(change(before, after), { params: { phone: PHONE } });
    expect(hoisted.docState.get("caregivers/cg1")?.optedOut).toBe(true);
  });

  it("ignores a client session (userType !== 'caregiver')", async () => {
    hoisted.docState.set("caregivers/cg1", { name: "Alice" });
    const before = { userType: "client", optedOut: false };
    const after  = { ...before, optedOut: true };
    await (mirrorCaregiverOptOut as any)(change(before, after), { params: { phone: PHONE } });
    expect(hoisted.docState.get("caregivers/cg1")?.optedOut).toBeUndefined();
  });

  it("skips the write when optedOut didn't actually change", async () => {
    hoisted.docState.set("caregivers/cg1", { name: "Alice", optedOut: false });
    const before = { userType: "caregiver", caregiverId: "cg1", optedOut: false, lastMessageSentAt: "t1" };
    const after  = { ...before, lastMessageSentAt: "t2" };
    await (mirrorCaregiverOptOut as any)(change(before, after), { params: { phone: PHONE } });
    // Unrelated session update — caregiver doc untouched (still exactly as seeded).
    expect(hoisted.docState.get("caregivers/cg1")).toEqual({ name: "Alice", optedOut: false });
  });

  it("no-ops when the session has no matching caregiver at all", async () => {
    const before = { userType: "caregiver", optedOut: false };
    const after  = { ...before, optedOut: true };
    await expect(
      (mirrorCaregiverOptOut as any)(change(before, after), { params: { phone: PHONE } })
    ).resolves.not.toThrow();
  });
});
