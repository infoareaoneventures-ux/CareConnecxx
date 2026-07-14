import { describe, it, expect, vi, beforeEach } from "vitest";

// Callable-level coverage for B1 (billing caps on the correction paths):
// the helper-level cap tests live in billing/shiftBillingAmounts.test.ts;
// these exercise the actual reviewShiftHours callable and the
// autoAcceptCorrection scheduled sweep against an in-memory Firestore.

const hoisted = vi.hoisted(() => {
  const docs = new Map<string, Record<string, any>>();
  const updates: Array<{ path: string; data: Record<string, any> }> = [];
  const batchSets: Array<{ path: string; data: Record<string, any> }> = [];
  return { docs, updates, batchSets };
});

vi.mock("firebase-admin", () => {
  const { docs, updates, batchSets } = hoisted;
  let autoId = 0;

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({
      exists: docs.has(path),
      id: path.split("/").pop(),
      data: () => docs.get(path),
      ref: makeDocRef(path),
    }),
    update: async (data: Record<string, any>) => {
      updates.push({ path, data });
      docs.set(path, { ...(docs.get(path) ?? {}), ...data });
    },
    set: async (data: Record<string, any>) => {
      docs.set(path, data);
    },
    collection: (name: string) => makeCollection(`${path}/${name}`),
  });

  const makeQuery = (colPath: string, filters: Array<[string, string, any]>): any => ({
    where: (f: string, op: string, v: any) => makeQuery(colPath, [...filters, [f, op, v]]),
    limit: () => makeQuery(colPath, filters),
    get: async () => {
      const depth = colPath.split("/").length + 1;
      const matched = [...docs.entries()]
        .filter(([p]) => p.startsWith(`${colPath}/`) && p.split("/").length === depth)
        .filter(([, d]) => filters.every(([f, op, v]) => {
          if (op === "==") return d[f] === v;
          if (op === "<=") return d[f] != null && d[f] <= v;
          if (op === ">=") return d[f] != null && d[f] >= v;
          return true;
        }))
        .map(([p, d]) => ({ id: p.split("/").pop(), data: () => d, ref: makeDocRef(p) }));
      return {
        empty: matched.length === 0,
        docs: matched,
        forEach: (cb: (doc: any) => void) => matched.forEach(cb),
      };
    },
  });

  const makeCollection = (colPath: string): any => ({
    doc: (id?: string) => makeDocRef(`${colPath}/${id ?? `auto-${++autoId}`}`),
    add: async (data: Record<string, any>) => {
      const path = `${colPath}/auto-${++autoId}`;
      docs.set(path, data);
      return makeDocRef(path);
    },
    where: (f: string, op: string, v: any) => makeQuery(colPath, [[f, op, v]]),
  });

  const firestore: any = () => ({
    collection: (name: string) => makeCollection(name),
    batch: () => ({
      set: (ref: any, data: Record<string, any>) => { batchSets.push({ path: ref.path, data }); },
      update: (ref: any, data: Record<string, any>) => { updates.push({ path: ref.path, data }); },
      commit: async () => {},
    }),
  });
  firestore.FieldValue = {
    serverTimestamp: () => "server-ts",
    arrayUnion: (...items: any[]) => ({ __arrayUnion: items }),
  };
  const stub = { apps: [{}], initializeApp: () => ({}), firestore };
  return { __esModule: true, default: stub, ...stub };
});

vi.mock("firebase-functions/v1", () => {
  class HttpsError extends Error {
    constructor(public code: string, msg: string) { super(msg); }
  }
  return {
    https: { HttpsError, onCall: (f: any) => f },
    firestore: { document: () => ({ onWrite: (f: any) => f, onUpdate: (f: any) => f, onCreate: (f: any) => f }) },
    pubsub: { schedule: () => ({ onRun: (f: any) => f }) },
    config: () => ({}),
  };
});

vi.mock("stripe", () => ({
  __esModule: true,
  default: class StripeMock { constructor(_key?: string, _opts?: any) {} },
}));

import { reviewShiftHours, autoAcceptCorrection } from "./shiftHours";

beforeEach(() => {
  hoisted.docs.clear();
  hoisted.updates.length = 0;
  hoisted.batchSets.length = 0;
});

describe("B1 — reviewShiftHours enforces billing caps on propose_correction", () => {
  const baseShift = {
    clientId: "c1",
    caregiverId: "cg1",
    status: "pending_client_review",
    payRate: 30,
    submittedTotalHours: 4,
    submittedStartTime: "2026-07-13T09:00:00.000Z",
    submittedEndTime: "2026-07-13T13:00:00.000Z",
  };

  it("rejects a 500-hour correction with invalid-argument and writes nothing", async () => {
    hoisted.docs.set("shiftHours/appt1", { ...baseShift });

    await expect((reviewShiftHours as any)({
      appointmentId: "appt1",
      action: "propose_correction",
      proposedStartTime: "2026-07-01T00:00:00.000Z",
      proposedEndTime: "2026-07-21T20:00:00.000Z",
    }, { auth: { uid: "c1" } })).rejects.toMatchObject({ code: "invalid-argument" });

    expect(hoisted.updates.filter((u) => u.path === "shiftHours/appt1")).toHaveLength(0);
    expect(hoisted.docs.get("shiftHours/appt1")!.status).toBe("pending_client_review");
  });

  it("rejects a legal-duration but over-$2500 correction with invalid-argument", async () => {
    hoisted.docs.set("shiftHours/appt1", { ...baseShift, payRate: 150 });

    await expect((reviewShiftHours as any)({
      appointmentId: "appt1",
      action: "propose_correction",
      proposedStartTime: "2026-07-13T00:00:00.000Z",
      proposedEndTime: "2026-07-13T20:00:00.000Z", // 20h * $150 = $3,000
    }, { auth: { uid: "c1" } })).rejects.toMatchObject({ code: "invalid-argument" });

    expect(hoisted.updates.filter((u) => u.path === "shiftHours/appt1")).toHaveLength(0);
  });

  it("still accepts a legal correction (no regression)", async () => {
    hoisted.docs.set("shiftHours/appt1", { ...baseShift });

    const result = await (reviewShiftHours as any)({
      appointmentId: "appt1",
      action: "propose_correction",
      proposedStartTime: "2026-07-13T09:00:00.000Z",
      proposedEndTime: "2026-07-13T15:00:00.000Z", // 6h * $30 = $180
    }, { auth: { uid: "c1" } });

    expect(result).toEqual({ success: true });
    const doc = hoisted.docs.get("shiftHours/appt1")!;
    expect(doc.status).toBe("correction_proposed");
    expect(doc.proposedGrossPay).toBe(180);
    expect(doc.correctionRespondByAt).toEqual(expect.any(String));
  });
});

describe("B1 — autoAcceptCorrection never finalizes an over-cap correction", () => {
  const pendingCorrection = {
    clientId: "c1",
    caregiverId: "cg1",
    status: "correction_proposed",
    correctionRespondByAt: "2020-01-01T00:00:00.000Z", // window elapsed
    proposedStartTime: "2026-07-13T00:00:00.000Z",
  };

  it("routes an over-cap correction to disputed_admin_review and notifies admins", async () => {
    hoisted.docs.set("users/admin1", { userType: "admin" });
    hoisted.docs.set("shiftHours/appt2", {
      ...pendingCorrection,
      proposedEndTime: "2026-07-13T20:00:00.000Z", // 20h * $150 = $3,000 (> $2,500 cap)
      payRate: 150,
    });

    await (autoAcceptCorrection as any)();

    const doc = hoisted.docs.get("shiftHours/appt2")!;
    expect(doc.status).toBe("disputed_admin_review");
    expect(doc.billingReviewReason).toEqual(expect.any(String));
    expect(doc.grossPay).toBeUndefined();
    // notifyAdmins delivered a notification to the admin
    expect(hoisted.batchSets.some((s) => s.path.startsWith("users/admin1/notifications/"))).toBe(true);
  });

  it("routes a large-but-legal correction (explicit-approval threshold) to admin review, not a charge", async () => {
    hoisted.docs.set("users/admin1", { userType: "admin" });
    hoisted.docs.set("shiftHours/appt3", {
      ...pendingCorrection,
      proposedEndTime: "2026-07-13T10:00:00.000Z", // 10h * $60 = $600 (> $500 threshold)
      payRate: 60,
    });

    await (autoAcceptCorrection as any)();

    expect(hoisted.docs.get("shiftHours/appt3")!.status).toBe("disputed_admin_review");
  });

  it("still finalizes a legal correction at the capped computation (no regression)", async () => {
    hoisted.docs.set("shiftHours/appt4", {
      ...pendingCorrection,
      proposedEndTime: "2026-07-13T06:00:00.000Z", // 6h * $30 = $180
      payRate: 30,
    });

    await (autoAcceptCorrection as any)();

    const doc = hoisted.docs.get("shiftHours/appt4")!;
    expect(doc.status).toBe("approved");
    expect(doc.grossPay).toBe(180);
    expect(doc.amountCents).toBe(18000);
    expect(doc.resolvedBy).toBe("system_auto_accept");
  });
});
