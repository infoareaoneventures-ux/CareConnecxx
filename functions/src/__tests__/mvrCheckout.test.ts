// U4 — one-time MVR add-on checkout → payment webhook branch.
//
// Verifies the `mvr_addon` checkout.session.completed branch routes to
// initiateMvrOnlyCheck exactly once, dedupes on redelivery via the webhook
// ledger, and ignores a session with no caregiver.

import { describe, it, expect, beforeEach, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  process.env.STRIPE_SECRET_KEY = "sk_test_x";

  const docs = new Map<string, any>();
  const initiateSpy = vi.fn(async () => {});

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    create: vi.fn(async (data: any) => {
      if (docs.has(path)) { const e: any = new Error("ALREADY_EXISTS"); e.code = 6; throw e; }
      docs.set(path, data);
    }),
    get: vi.fn(async () => ({ exists: docs.has(path), data: () => docs.get(path) })),
    set: vi.fn(async (data: any, opts?: any) => {
      docs.set(path, opts?.merge ? { ...(docs.get(path) ?? {}), ...data } : data);
    }),
    update: vi.fn(async (data: any) => { docs.set(path, { ...(docs.get(path) ?? {}), ...data }); }),
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });
  const makeCollRef = (path: string): any => ({
    doc: (id: string) => makeDocRef(`${path}/${id}`),
    where() { return this; },
    limit() { return this; },
    get: vi.fn(async () => ({ empty: true, docs: [] })),
    add: vi.fn(async () => ({ id: "auto" })),
  });
  const collection = vi.fn((name: string) => makeCollRef(name));
  const runTransaction = vi.fn(async (fn: any) => fn({
    get: async (ref: any) => ref.get(),
    set: (ref: any, data: any) => { docs.set(ref.path, data); },
    update: (ref: any, data: any) => { docs.set(ref.path, { ...(docs.get(ref.path) ?? {}), ...data }); },
  }));
  const firestoreFn: any = Object.assign(() => ({ collection, runTransaction }), {
    FieldValue: { serverTimestamp: () => ({ __ts: true }), arrayUnion: (...v: any[]) => ({ __u: v }), delete: () => ({ __d: true }) },
  });
  const StripeClass: any = function () {
    return { webhooks: { constructEvent: (raw: Buffer) => JSON.parse(raw.toString()) } };
  };
  return {
    docs, initiateSpy, collection, firestoreFn, StripeClass,
    reset: () => { docs.clear(); initiateSpy.mockClear(); },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestoreFn },
  apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestoreFn,
}));
vi.mock("stripe", () => ({ __esModule: true, default: hoisted.StripeClass }));
// Spy the MVR initiation that stripe.ts dynamically imports.
vi.mock("../checkr", () => ({ __esModule: true, initiateMvrOnlyCheck: hoisted.initiateSpy }));

import { stripeWebhook } from "../stripe";

function req(event: any) {
  return { method: "POST", headers: { "stripe-signature": "sig" }, rawBody: Buffer.from(JSON.stringify(event)) } as any;
}
function makeRes() {
  const res: any = { statusCode: 200 };
  res.status = vi.fn((c: number) => { res.statusCode = c; return res; });
  res.json = vi.fn(() => res);
  res.send = vi.fn(() => res);
  return res;
}
const mvrAddonEvent = (id: string, meta: Record<string, string>) => ({
  id, type: "checkout.session.completed",
  data: { object: { id: "cs_1", metadata: meta } },
});

beforeEach(() => { hoisted.reset(); vi.clearAllMocks(); });

describe("mvr_addon checkout webhook", () => {
  it("initiates an MVR-only check once for the caregiver", async () => {
    const res = makeRes();
    await (stripeWebhook as any)(req(mvrAddonEvent("evt_1", { firebaseUID: "cg1", task: "mvr_addon" })), res);
    expect(hoisted.initiateSpy).toHaveBeenCalledTimes(1);
    expect(hoisted.initiateSpy).toHaveBeenCalledWith("cg1");
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  it("dedupes a redelivered event — exactly one initiation overall", async () => {
    await (stripeWebhook as any)(req(mvrAddonEvent("evt_dup", { firebaseUID: "cg1", task: "mvr_addon" })), makeRes());
    await (stripeWebhook as any)(req(mvrAddonEvent("evt_dup", { firebaseUID: "cg1", task: "mvr_addon" })), makeRes());
    expect(hoisted.initiateSpy).toHaveBeenCalledTimes(1);
  });

  it("ignores an mvr_addon session with no caregiver", async () => {
    await (stripeWebhook as any)(req(mvrAddonEvent("evt_2", { task: "mvr_addon" })), makeRes());
    expect(hoisted.initiateSpy).not.toHaveBeenCalled();
  });
});
