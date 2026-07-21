import { describe, it, expect } from "vitest";
import { resolveFamilyOwnerUid, isNotFound } from "./activityOwner";

// Fake Firestore: users/{uid}.userType drives the family-only gate.
const fakeDb = (usersByUid: Record<string, { userType?: string }>) => ({
  collection: () => ({
    doc: (uid: string) => ({
      get: async () => ({ exists: uid in usersByUid, data: () => usersByUid[uid] }),
    }),
  }),
}) as any;

// Fake Auth with configurable phone->uid and uid validity.
const fakeAuth = (opts: {
  byPhone?: Record<string, string>;
  validUids?: string[];
  phoneError?: any;
  uidError?: any;
}) => ({
  getUserByPhoneNumber: async (phone: string) => {
    if (opts.phoneError) throw opts.phoneError;
    const uid = opts.byPhone?.[phone];
    if (!uid) { const e: any = new Error("nf"); e.code = "auth/user-not-found"; throw e; }
    return { uid };
  },
  getUser: async (uid: string) => {
    if (opts.uidError) throw opts.uidError;
    if (!opts.validUids?.includes(uid)) { const e: any = new Error("nf"); e.code = "auth/user-not-found"; throw e; }
    return { uid };
  },
}) as any;

describe("resolveFamilyOwnerUid", () => {
  it("resolves a phone to a CLIENT uid", async () => {
    const db = fakeDb({ uidClient: { userType: "client" } });
    const auth = fakeAuth({ byPhone: { "+15551112222": "uidClient" } });
    const uid = await resolveFamilyOwnerUid(db, auth, { phone: "+15551112222" });
    expect(uid).toBe("uidClient");
  });

  it("returns null when the phone resolves to a CAREGIVER (family-only gate)", async () => {
    const db = fakeDb({ uidCg: { userType: "caregiver" } });
    const auth = fakeAuth({ byPhone: { "+15553334444": "uidCg" } });
    const uid = await resolveFamilyOwnerUid(db, auth, { phone: "+15553334444" });
    expect(uid).toBeNull();
  });

  it("falls back to a valid uidCandidate when the phone is unknown", async () => {
    const db = fakeDb({ uidClient: { userType: "client" } });
    const auth = fakeAuth({ byPhone: {}, validUids: ["uidClient"] });
    const uid = await resolveFamilyOwnerUid(db, auth, { phone: "+19998887777", uidCandidate: "uidClient" });
    expect(uid).toBe("uidClient");
  });

  it("returns null when neither phone nor uid candidate resolves", async () => {
    const db = fakeDb({});
    const auth = fakeAuth({ byPhone: {}, validUids: [] });
    const uid = await resolveFamilyOwnerUid(db, auth, { phone: "+10000000000", uidCandidate: "nope" });
    expect(uid).toBeNull();
  });

  it("treats a user doc with no userType as a family owner (not a caregiver)", async () => {
    const db = fakeDb({ uidUnknown: {} });
    const auth = fakeAuth({ validUids: ["uidUnknown"] });
    const uid = await resolveFamilyOwnerUid(db, auth, { uidCandidate: "uidUnknown" });
    expect(uid).toBe("uidUnknown");
  });

  it("THROWS on a transient (non-not-found) Auth error so the trigger retries", async () => {
    const db = fakeDb({});
    const transient: any = new Error("backend unavailable");
    transient.code = "auth/internal-error";
    const auth = fakeAuth({ phoneError: transient });
    await expect(resolveFamilyOwnerUid(db, auth, { phone: "+15551112222" })).rejects.toThrow();
  });
});

describe("isNotFound", () => {
  it("classifies expected skip errors", () => {
    expect(isNotFound({ code: "auth/user-not-found" })).toBe(true);
    expect(isNotFound({ code: "auth/invalid-phone-number" })).toBe(true);
    expect(isNotFound({ code: "auth/internal-error" })).toBe(false);
    expect(isNotFound(new Error("x"))).toBe(false);
  });
});
