import { describe, it, expect, vi, beforeEach } from "vitest";

// Admin "Reset Account" trigger. Locks in the 2026-09-25 fix: the admin page
// sends the phone from caregivers/{uid}, which a unified-identity caregiver
// does not carry (it lives on users/{uid}) — the trigger used to refuse the
// whole reset with "uid and phone are required". Now it resolves the phone
// itself, and a uid with no phone anywhere is still wiped (uid-keyed only).

vi.mock("firebase-functions", () => {
  const builder: any = { firestore: { document: () => ({ onCreate: (h: any) => h }) } };
  return { __esModule: true, ...builder, default: builder };
});

const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();
  const deleted: string[] = [];
  const queried: string[] = [];
  const makeDoc = (path: string): any => ({
    path,
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
    update: async (data: any) => { docs.set(path, { ...(docs.get(path) ?? {}), ...data }); },
  });
  const makeQuery = (coll: string, field: string, value: unknown): any => ({
    limit: () => makeQuery(coll, field, value),
    get: async () => { queried.push(`${coll}.${field}=${String(value)}`); return { empty: true, docs: [], size: 0 }; },
  });
  const coll = (name: string): any => ({
    doc: (id: string) => makeDoc(`${name}/${id}`),
    where: (f: string, _op: string, v: unknown) => makeQuery(name, f, v),
  });
  const authUsers = new Map<string, { phoneNumber?: string }>();
  return { docs, deleted, queried, coll, authUsers, reset: () => { docs.clear(); deleted.length = 0; queried.length = 0; authUsers.clear(); } };
});

vi.mock("firebase-admin", () => {
  const firestore: any = Object.assign(() => ({
    collection: hoisted.coll,
    recursiveDelete: async (ref: any) => { hoisted.deleted.push(ref.path); },
  }), { FieldValue: {} });
  const auth = () => ({
    deleteUser: async () => undefined,
    getUser: async (uid: string) => {
      const u = hoisted.authUsers.get(uid);
      if (!u) throw Object.assign(new Error("no user"), { code: "auth/user-not-found" });
      return u;
    },
  });
  const storage = () => ({ bucket: () => ({ getFiles: async () => [[]] }) });
  return { __esModule: true, firestore, auth, storage, default: { firestore, auth, storage } };
});

import { processResetAccountQueue, resolveResetPhone } from "../resetAccountQueue";

const run = processResetAccountQueue as unknown as (snap: any) => Promise<void>;
const snapFor = (data: Record<string, unknown>) => {
  const ref = hoisted.coll("adminResetQueue").doc("q1");
  hoisted.docs.set("adminResetQueue/q1", data);
  return { data: () => data, ref };
};

beforeEach(() => { hoisted.reset(); process.env.ZEP_API_KEY = ""; });

describe("resolveResetPhone", () => {
  it("keeps a supplied phone", async () => {
    expect(await resolveResetPhone("u1", "+15551112222")).toBe("+15551112222");
  });
  it("falls back to users/{uid}, then caregivers/{uid}, then Auth", async () => {
    hoisted.docs.set("users/u1", { phone: "+15550000001" });
    expect(await resolveResetPhone("u1", "")).toBe("+15550000001");
    hoisted.docs.set("caregivers/u2", { phoneNumber: "+15550000002" });
    expect(await resolveResetPhone("u2", undefined)).toBe("+15550000002");
    hoisted.authUsers.set("u3", { phoneNumber: "+15550000003" });
    expect(await resolveResetPhone("u3", null)).toBe("+15550000003");
    expect(await resolveResetPhone("u4", "")).toBeNull();
  });
});

describe("processResetAccountQueue", () => {
  it("resets a caregiver whose phone is only on the users doc (the admin page sent phone '')", async () => {
    hoisted.docs.set("users/cg1", { phone: "+15550009999" });
    hoisted.docs.set("caregivers/cg1", { name: "Basra" });
    await run(snapFor({ uid: "cg1", phone: "", role: "caregiver" }));
    const q = hoisted.docs.get("adminResetQueue/q1");
    expect(q.error).toBeUndefined();
    expect(q.success).toBe(true);
    expect(q.phoneResolved).toBe(true);
    expect(hoisted.deleted).toContain("caregivers/cg1");
    expect(hoisted.deleted).toContain("users/cg1");
    expect(hoisted.deleted).toContain("agent_sessions/+15550009999");
    expect(hoisted.deleted).toContain("waitlist/cg1");
    expect(hoisted.queried).toContain("shifts.caregiverId=cg1");
    expect(hoisted.queried).toContain("shifts.phone=+15550009999");
  });

  it("still wipes the uid-keyed data when no phone exists anywhere, and says so", async () => {
    await run(snapFor({ uid: "ghost", phone: "", role: "client" }));
    const q = hoisted.docs.get("adminResetQueue/q1");
    expect(q.error).toBeUndefined();
    expect(q.success).toBe(true);
    expect(q.phoneResolved).toBe(false);
    expect(q.note).toMatch(/no phone/);
    expect(hoisted.deleted).toContain("users/ghost");
    expect(hoisted.deleted.some((p) => p.startsWith("agent_sessions/"))).toBe(false);
    expect(hoisted.queried.some((s) => s.includes(".phone="))).toBe(false);
  });

  it("refuses only when the uid itself is missing", async () => {
    await run(snapFor({ phone: "+15550000000", role: "client" }));
    expect(hoisted.docs.get("adminResetQueue/q1").error).toBe("uid is required");
    expect(hoisted.deleted).toHaveLength(0);
  });
});
