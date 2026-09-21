import { describe, it, expect, vi, beforeEach } from "vitest";

// "Your membership is active" — once per account, whichever Stripe event lands first.

const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();
  const adds: Array<{ path: string; data: any }> = [];
  const docRef = (path: string): any => ({
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
    set: async (data: any, opts?: any) => { docs.set(path, { ...(opts?.merge ? docs.get(path) ?? {} : {}), ...data }); },
    collection: (sub: string) => ({ add: async (data: any) => { adds.push({ path: `${path}/${sub}`, data }); return { id: "n1" }; } }),
  });
  return {
    docs, adds,
    firestore: () => ({
      collection: (name: string) => ({ doc: (id: string) => docRef(`${name}/${id}`) }),
      runTransaction: async (fn: (tx: any) => Promise<any>) => fn({
        get: async (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => { void ref.set(data, opts); },
      }),
    }),
    reset: () => { docs.clear(); adds.length = 0; },
  };
});
vi.mock("firebase-admin", () => {
  const firestore: any = hoisted.firestore; firestore.FieldValue = { serverTimestamp: () => "TS" };
  const stub = { apps: [{}], initializeApp: () => ({}), firestore };
  return { __esModule: true, default: stub, ...stub };
});
const sendSMSToUser = vi.fn(async (..._a: unknown[]) => ({ success: true }));
vi.mock("../sms", () => ({ sendSMSToUser: (...a: unknown[]) => sendSMSToUser(...a) }));

import { notifyClientMembershipActivatedOnce, MEMBERSHIP_ACTIVE_TEXT } from "../membershipNotify";

beforeEach(() => { hoisted.reset(); sendSMSToUser.mockClear(); });

describe("notifyClientMembershipActivatedOnce", () => {
  it("bells + texts the family once, then never again for the same account", async () => {
    hoisted.docs.set("users/u1", { userType: "client", phone: "+1" });
    expect(await notifyClientMembershipActivatedOnce("u1")).toBe(true);
    expect(hoisted.adds[0]).toMatchObject({ path: "users/u1/notifications", data: { type: "membership_activated", title: "Membership active" } });
    expect(sendSMSToUser).toHaveBeenCalledWith("u1", MEMBERSHIP_ACTIVE_TEXT);
    expect(hoisted.docs.get("users/u1").membershipActivatedNotifiedAt).toBeTruthy();
    expect(await notifyClientMembershipActivatedOnce("u1")).toBe(false);
    expect(sendSMSToUser).toHaveBeenCalledTimes(1);
  });
  it("is client-only", async () => {
    hoisted.docs.set("users/cg", { userType: "caregiver" });
    expect(await notifyClientMembershipActivatedOnce("cg")).toBe(false);
    expect(sendSMSToUser).not.toHaveBeenCalled();
  });
});
