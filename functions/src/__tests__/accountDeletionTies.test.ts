import { describe, it, expect, vi, beforeEach } from "vitest";

// Wave 2 (2026-11-09): deleting an account releases what it leaves on the OTHER side — visits and booking
// requests cancelled the normal way, applications withdrawn, a family's open posts cancelled, the care
// provider's public profile removed, conversations closed — and the request is marked done before the
// login is removed.

const hoisted = vi.hoisted(() => {
  const docs = new Map<string, any>();
  const ops: string[] = [];
  const refOf = (path: string): any => ({
    path,
    delete: async () => { ops.push(`delete ${path}`); docs.delete(path); },
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
  });
  const collection = (name: string, filters: Array<[string, string, any]> = []): any => ({
    doc: (id: string) => refOf(`${name}/${id}`),
    where: (f: string, op: string, v: any) => collection(name, [...filters, [f, op, v]]),
    get: async () => {
      const out = [...docs.entries()]
        .filter(([p]) => p.startsWith(`${name}/`) && p.split("/").length === 2)
        .filter(([, d]) => filters.every(([f, op, v]) => (op === "==" ? d?.[f] === v : op === "array-contains" ? Array.isArray(d?.[f]) && d[f].includes(v) : true)))
        .map(([p, d]) => ({ id: p.split("/")[1], data: () => d, ref: refOf(p) }));
      return { empty: out.length === 0, docs: out };
    },
  });
  const batch = () => {
    const pending: Array<() => void> = [];
    return {
      update: (ref: any, data: any) => { pending.push(() => { docs.set(ref.path, { ...(docs.get(ref.path) ?? {}), ...data }); ops.push(`update ${ref.path}`); }); },
      commit: async () => { pending.forEach((f) => f()); },
    };
  };
  const db: any = { collection: (n: string) => collection(n), batch };
  return { docs, ops, db, reset: () => { docs.clear(); ops.length = 0; } };
});

vi.mock("firebase-admin", () => {
  const firestore: any = Object.assign(() => hoisted.db, { FieldValue: { serverTimestamp: () => "TS" } });
  return { __esModule: true, default: { firestore }, firestore };
});

import { releaseAccountTies, ACCOUNT_DELETED_REASON } from "../accountDeletionTies";

const get = (p: string) => hoisted.docs.get(p);
beforeEach(() => hoisted.reset());

describe("a deleted CARE PROVIDER", () => {
  beforeEach(() => {
    hoisted.docs.set("publicCaregiverProfiles/cg1", { name: "Alice" });
    hoisted.docs.set("shifts/s1", { caregiverId: "cg1", clientId: "f1", status: "scheduled" });
    hoisted.docs.set("shifts/s2", { caregiverId: "cg1", clientId: "f1", status: "completed" });
    hoisted.docs.set("shifts/other", { caregiverId: "cg2", clientId: "f1", status: "scheduled" });
    hoisted.docs.set("booking_requests/b1", { caregiverId: "cg1", clientId: "f1", status: "accepted" });
    hoisted.docs.set("booking_requests/b2", { caregiverId: "cg1", clientId: "f1", status: "declined" });
    hoisted.docs.set("job_applications/a1", { caregiverId: "cg1", jobId: "j1", status: "pending" });
    hoisted.docs.set("job_applications/a2", { caregiverId: "cg1", jobId: "j2", status: "rejected" });
    hoisted.docs.set("chatRooms/f1_cg1", { participants: ["f1", "cg1"] });
    hoisted.docs.set("chatRooms/f1_cg2", { participants: ["f1", "cg2"] });
  });

  it("cancels upcoming visits and open bookings as 'system' (the family is told the usual way), leaving finished ones alone", async () => {
    await releaseAccountTies(hoisted.db, "cg1", true);
    expect(get("shifts/s1")).toMatchObject({ status: "cancelled", cancelledBy: "system", cancelReason: ACCOUNT_DELETED_REASON });
    expect(get("shifts/s2").status).toBe("completed");
    expect(get("shifts/other").status).toBe("scheduled");
    expect(get("booking_requests/b1")).toMatchObject({ status: "cancelled", cancelledBy: "system" });
    expect(get("booking_requests/b2").status).toBe("declined");
  });

  it("removes the public profile and withdraws only PENDING applications", async () => {
    await releaseAccountTies(hoisted.db, "cg1", true);
    expect(hoisted.docs.has("publicCaregiverProfiles/cg1")).toBe(false);
    expect(get("job_applications/a1")).toMatchObject({ status: "withdrawn", withdrawnReason: ACCOUNT_DELETED_REASON });
    expect(get("job_applications/a2").status).toBe("rejected");
  });

  it("closes (never deletes) the conversations the person is in", async () => {
    await releaseAccountTies(hoisted.db, "cg1", true);
    expect(get("chatRooms/f1_cg1")).toMatchObject({ closedReason: ACCOUNT_DELETED_REASON, closedBy: "cg1" });
    expect(get("chatRooms/f1_cg2").closedReason).toBeUndefined();
    expect(hoisted.ops.some((o) => o.startsWith("delete chatRooms"))).toBe(false);
  });
});

describe("a deleted FAMILY", () => {
  beforeEach(() => {
    hoisted.docs.set("shifts/s1", { caregiverId: "cg1", clientId: "f1", status: "scheduled" });
    hoisted.docs.set("booking_requests/b1", { caregiverId: "cg1", clientId: "f1", status: "pending" });
    hoisted.docs.set("job_posts/j1", { clientId: "f1", status: "open" });
    hoisted.docs.set("job_posts/j2", { clientId: "f1", status: "filled" });
    hoisted.docs.set("job_posts/j3", { clientId: "someone-else", status: "open" });
    hoisted.docs.set("chatRooms/f1_cg1", { participants: ["f1", "cg1"] });
  });

  it("cancels visits and bookings as 'client' (the care provider hears the family cancelled) and takes the open job post down", async () => {
    await releaseAccountTies(hoisted.db, "f1", false);
    expect(get("shifts/s1")).toMatchObject({ status: "cancelled", cancelledBy: "client" });
    expect(get("booking_requests/b1")).toMatchObject({ status: "cancelled", cancelledBy: "client" });
    expect(get("job_posts/j1")).toMatchObject({ status: "cancelled", cancelledReason: ACCOUNT_DELETED_REASON });
    expect(get("job_posts/j2").status).toBe("filled");
    expect(get("job_posts/j3").status).toBe("open");
    expect(get("chatRooms/f1_cg1").closedReason).toBe(ACCOUNT_DELETED_REASON);
  });
});

describe("failure handling", () => {
  it("a failing step is logged and does not stop the others (the deletion itself comes first)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    hoisted.docs.set("chatRooms/f1_cg1", { participants: ["f1", "cg1"] });
    const real = hoisted.db.collection;
    hoisted.db.collection = (n: string) => { if (n === "shifts") throw new Error("boom"); return real(n); };
    await releaseAccountTies(hoisted.db, "cg1", true);
    hoisted.db.collection = real;
    expect(err).toHaveBeenCalledWith(expect.stringContaining("visits failed"), "boom");
    expect(get("chatRooms/f1_cg1").closedReason).toBe(ACCOUNT_DELETED_REASON);
  });
});
