import { describe, it, expect, vi, beforeEach } from "vitest";

// Flat membership (2026-09-25): Transportation added after the criminal check
// cleared → the MVR-only check, with no charge. Consent-first (2026-10-06): this
// trigger only PARKS the record on mvrStatus 'awaiting_consent'; the shared consent
// function (backgroundCheckConsent.ts) is what calls Checkr once she authorizes.

vi.mock("firebase-functions/v1", () => {
  const builder: any = { firestore: { document: () => ({ onUpdate: (h: any) => h }) } };
  return { __esModule: true, ...builder, default: builder };
});

const hoisted = vi.hoisted(() => {
  const adds: any[] = [];
  const docs = new Map<string, any>();
  const initiate = vi.fn(async () => {});
  const failWrites = { on: false };
  return { adds, docs, initiate, failWrites };
});
vi.mock("firebase-admin", () => {
  const firestore: any = Object.assign(() => ({
    collection: (name: string) => ({
      add: async (d: any) => { hoisted.adds.push(d); return { id: "a" }; },
      doc: (id: string) => {
        const key = `${name}/${id}`;
        return {
          get: async () => ({ exists: hoisted.docs.has(key), id, data: () => hoisted.docs.get(key) }),
          set: async (d: any) => { if (hoisted.failWrites.on) throw new Error("write failed"); hoisted.docs.set(key, { ...(hoisted.docs.get(key) ?? {}), ...d }); },
          update: async (d: any) => { if (!hoisted.docs.has(key)) throw new Error("not found"); hoisted.docs.set(key, { ...hoisted.docs.get(key), ...d }); },
        };
      },
    }),
  }), { FieldValue: {} });
  return { __esModule: true, firestore, default: { firestore } };
});
vi.mock("../../checkr", () => ({ initiateMvrOnlyCheck: (...a: unknown[]) => hoisted.initiate(...(a as [])) }));

import { needsMvrOnlyCheck, startMvrOnTransportationAdded, requestDrivingRecordConsent } from "../transportationMvr";

const run = startMvrOnTransportationAdded as unknown as (change: any, ctx: any) => Promise<void>;
const change = (before: any, after: any) => ({ before: { data: () => before }, after: { data: () => after } });
const ctx = { params: { uid: "cg1" } };

const cleared = {
  services: ["Companionship"], membershipStatus: "active", membershipPaid: true,
  backgroundCheckData: { status: "clear" },
};

beforeEach(() => { hoisted.adds.length = 0; hoisted.docs.clear(); hoisted.initiate.mockClear(); hoisted.failWrites.on = false; });

describe("needsMvrOnlyCheck", () => {
  it("is true only for an active-membership, criminal-cleared caregiver who offers Transportation with no MVR yet", () => {
    expect(needsMvrOnlyCheck({ ...cleared, services: ["Transportation"] })).toBe(true);
    expect(needsMvrOnlyCheck({ ...cleared, services: [], skills: ["Transportation"] })).toBe(true);
    expect(needsMvrOnlyCheck(cleared)).toBe(false);
    expect(needsMvrOnlyCheck({ ...cleared, services: ["Transportation"], backgroundCheckData: { status: "pending" } })).toBe(false);
  });
  it("needs an ACTIVE membership — the legacy paid flag alone is not enough once it lapsed (2026-10-06)", () => {
    expect(needsMvrOnlyCheck({ ...cleared, services: ["Transportation"], membershipStatus: "canceled", membershipPaid: true })).toBe(false);
    expect(needsMvrOnlyCheck({ ...cleared, services: ["Transportation"], membershipStatus: undefined, membershipPaid: true })).toBe(true); // legacy: paid, no status yet
    expect(needsMvrOnlyCheck({ ...cleared, services: ["Transportation"], membershipStatus: undefined, membershipPaid: false })).toBe(false);
  });
  it("is false when the MVR is already covered or already asked: bundled report, badge granted, check initiated, pending, awaiting consent", () => {
    const t = { ...cleared, services: ["Transportation"] };
    expect(needsMvrOnlyCheck({ ...t, backgroundCheckData: { status: "clear", mvrIncluded: true } })).toBe(false);
    expect(needsMvrOnlyCheck({ ...t, isApprovedDriver: true })).toBe(false);
    expect(needsMvrOnlyCheck({ ...t, mvrCheckInitiated: true })).toBe(false);
    expect(needsMvrOnlyCheck({ ...t, mvrStatus: "pending" })).toBe(false);
    expect(needsMvrOnlyCheck({ ...t, mvrStatus: "awaiting_consent" })).toBe(false);
  });
});

describe("startMvrOnTransportationAdded (consent-first, 2026-10-06)", () => {
  it("parks the record on 'awaiting_consent' when Transportation is added to a cleared caregiver — and calls Checkr NOT at all", async () => {
    const after = { ...cleared, services: ["Transportation"], phone: "+15550001111" };
    hoisted.docs.set("caregivers/cg1", after);
    hoisted.docs.set("agent_sessions/+15550001111", { bgcheckInviteUrl: "https://checkr/old", bgcheckInviteSentAt: "2025-01-01" });
    await run(change(cleared, after), ctx);
    expect(hoisted.initiate).not.toHaveBeenCalled();
    expect(hoisted.docs.get("caregivers/cg1")).toMatchObject({ mvrStatus: "awaiting_consent" });
    expect(hoisted.docs.get("caregivers/cg1").mvrConsentRequestedAt).toBeTruthy();
    // last year's cached Checkr link must not be re-sent as "the link" — the consent page is.
    expect(hoisted.docs.get("agent_sessions/+15550001111")).toMatchObject({ bgcheckInviteUrl: null, bgcheckInviteSentAt: null });
  });
  it("parks it when the criminal check clears for someone who already listed Transportation", async () => {
    const before = { ...cleared, services: ["Transportation"], backgroundCheckData: { status: "pending" } };
    const after = { ...cleared, services: ["Transportation"] };
    hoisted.docs.set("caregivers/cg1", after);
    await run(change(before, after), ctx);
    expect(hoisted.docs.get("caregivers/cg1").mvrStatus).toBe("awaiting_consent");
    expect(hoisted.initiate).not.toHaveBeenCalled();
  });
  it("does nothing on an unrelated update once the need already existed", async () => {
    const t = { ...cleared, services: ["Transportation"] };
    hoisted.docs.set("caregivers/cg1", { ...t, bio: "y" });
    await run(change(t, { ...t, bio: "y" }), ctx);
    expect(hoisted.docs.get("caregivers/cg1").mvrStatus).toBeUndefined();
  });
  it("does nothing for a caregiver who never offered Transportation", async () => {
    hoisted.docs.set("caregivers/cg1", { ...cleared, bio: "y" });
    await run(change(cleared, { ...cleared, bio: "y" }), ctx);
    expect(hoisted.docs.get("caregivers/cg1").mvrStatus).toBeUndefined();
  });
  it("is idempotent — an already-parked record is left alone", async () => {
    hoisted.docs.set("caregivers/cg1", { ...cleared, services: ["Transportation"], mvrStatus: "awaiting_consent", mvrConsentRequestedAt: "2026-10-01" });
    await requestDrivingRecordConsent("cg1");
    expect(hoisted.docs.get("caregivers/cg1").mvrConsentRequestedAt).toBe("2026-10-01");
  });
  it("raises an admin alert instead of throwing when the record write fails", async () => {
    const after = { ...cleared, services: ["Transportation"] };
    hoisted.docs.set("caregivers/cg1", after);
    hoisted.failWrites.on = true;
    await expect(run(change(cleared, after), ctx)).resolves.toBeUndefined();
    expect(hoisted.adds[0]).toMatchObject({ type: "mvr_init_failed", caregiverId: "cg1", severity: "high" });
  });
});
