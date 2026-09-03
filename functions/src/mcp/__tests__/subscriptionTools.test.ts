import { describe, it, expect, vi, beforeEach } from "vitest";

// 2026-08-31 (Membership page audit): cancel_subscription/reactivate_subscription
// used to reimplement the Stripe lookup+update inline AND write to
// users/{uid}.subscriptionStatus — a field the real subscription lifecycle
// (customer.subscription.updated webhook) never touches, only membershipStatus
// does. Now they call the SAME shared functions the website's own
// v1-cancelSubscription/v1-reactivateSubscription callables call
// (cancelSubscriptionForUser/reactivateSubscriptionForUser in stripe.ts), and
// write nothing to Firestore directly — matching the site exactly.

const hoisted = vi.hoisted(() => {
  const docState = new Map<string, any>();
  const collState = new Map<string, any[]>();
  const sets: Array<{ path: string; data: any }> = [];

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    get: vi.fn(async () => ({ exists: docState.has(path), data: () => docState.get(path) })),
    set: vi.fn(async (data: any, opts?: any) => {
      sets.push({ path, data });
      docState.set(path, opts?.merge ? { ...(docState.get(path) ?? {}), ...data } : data);
    }),
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });
  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id: string) => makeDocRef(`${path}/${id}`);
    ref.where = (..._a: any[]) => ref;
    ref.limit = (..._a: any[]) => ref;
    ref.get = vi.fn(async () => {
      const items = collState.get(path) ?? [];
      return { empty: items.length === 0, docs: items.map((d: any) => ({ id: d.id, data: () => d })) };
    });
    return ref;
  };

  const subscriptionsUpdate = vi.fn(async (..._a: any[]) => ({}));

  return {
    docState, collState, sets, subscriptionsUpdate,
    collectionMock: vi.fn((p: string) => makeCollRef(p)),
    reset: () => { docState.clear(); collState.clear(); sets.length = 0; subscriptionsUpdate.mockClear(); },
  };
});

vi.mock("firebase-admin", () => {
  const firestoreFn = Object.assign(() => ({ collection: hoisted.collectionMock }), {
    Timestamp: { fromMillis: (ms: number) => ({ __timestampMillis: ms }) },
  });
  const stub = { apps: [{}], initializeApp: () => ({}), firestore: firestoreFn };
  return { __esModule: true, default: stub, ...stub };
});

vi.mock("../../observability/auditLog", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../memory/memoryFiles", () => ({ readMemoryFile: vi.fn().mockResolvedValue(""), writeMemoryFile: vi.fn().mockResolvedValue(undefined), MemoryFile: {} }));
vi.mock("../../memory/preferences", () => ({ getPreferences: vi.fn().mockResolvedValue(null) }));
vi.mock("../../agents/pendingActions", async (importActual) => ({
  ...(await importActual<typeof import("../../agents/pendingActions")>()),
  isHighRisk: () => false,
}));

// Real stripe.ts is imported for real (dynamic `await import("../stripe")` in
// server.ts) — only the Stripe SDK itself is mocked, so cancelSubscriptionForUser/
// reactivateSubscriptionForUser's own Firestore-read logic runs for real
// against the hoisted mock above.
vi.mock("stripe", () => ({
  __esModule: true,
  default: vi.fn(function () {
    return { subscriptions: { update: (...a: unknown[]) => hoisted.subscriptionsUpdate(...(a as [any])) } };
  }),
}));

import { handleToolCall } from "../server";

const CLIENT = "client_1";
const periodEndTs = { toDate: () => new Date("2026-09-30T00:00:00.000Z") };

beforeEach(() => hoisted.reset());

// cancel_subscription + reactivate_subscription merged into
// set_subscription_status(action) on 2026-09-02, to free a tool slot for
// delete_account under OpenAI's 128-tool cap.
describe("set_subscription_status — action: cancel", () => {
  it("cancels the active subscription and writes NOTHING to users/{uid} directly", async () => {
    hoisted.collState.set(`customers/${CLIENT}/subscriptions`, [
      { id: "sub_1", status: "active", cancel_at_period_end: false, current_period_end: periodEndTs },
    ]);
    const r = await handleToolCall("set_subscription_status", { clientId: CLIENT, action: "cancel" }) as any;
    expect(r.success).toBe(true);
    expect(r.cancelled).toBe(true);
    expect(hoisted.subscriptionsUpdate).toHaveBeenCalledWith("sub_1", { cancel_at_period_end: true });
    // The bug: this used to write users/{uid}.subscriptionStatus="canceling" —
    // a field nothing in the real lifecycle reads/writes. Confirm it's gone.
    const userWrite = hoisted.sets.find((s) => s.path === `users/${CLIENT}`);
    expect(userWrite).toBeUndefined();
  });

  it("returns alreadyCancelling without calling Stripe again when already set to cancel", async () => {
    hoisted.collState.set(`customers/${CLIENT}/subscriptions`, [
      { id: "sub_1", status: "active", cancel_at_period_end: true, current_period_end: periodEndTs },
    ]);
    const r = await handleToolCall("set_subscription_status", { clientId: CLIENT, action: "cancel" }) as any;
    expect(r.success).toBe(true);
    expect(r.alreadyCancelling).toBe(true);
    expect(hoisted.subscriptionsUpdate).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND when there's no active/trialing subscription", async () => {
    hoisted.collState.set(`customers/${CLIENT}/subscriptions`, []);
    const r = await handleToolCall("set_subscription_status", { clientId: CLIENT, action: "cancel" }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("NOT_FOUND");
  });
});

describe("set_subscription_status — action: reactivate", () => {
  it("reactivates a subscription set to cancel and writes nothing to users/{uid} directly", async () => {
    hoisted.collState.set(`customers/${CLIENT}/subscriptions`, [
      { id: "sub_1", cancel_at_period_end: true, current_period_end: periodEndTs },
    ]);
    const r = await handleToolCall("set_subscription_status", { clientId: CLIENT, action: "reactivate" }) as any;
    expect(r.success).toBe(true);
    expect(r.reactivated).toBe(true);
    expect(hoisted.subscriptionsUpdate).toHaveBeenCalledWith("sub_1", { cancel_at_period_end: false });
    const userWrite = hoisted.sets.find((s) => s.path === `users/${CLIENT}`);
    expect(userWrite).toBeUndefined();
  });

  it("returns NOT_FOUND when nothing is set to cancel", async () => {
    hoisted.collState.set(`customers/${CLIENT}/subscriptions`, []);
    const r = await handleToolCall("set_subscription_status", { clientId: CLIENT, action: "reactivate" }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("NOT_FOUND");
  });
});

describe("set_subscription_status — validation", () => {
  it("rejects an invalid action", async () => {
    const r = await handleToolCall("set_subscription_status", { clientId: CLIENT, action: "pause" }) as any;
    expect(r._toolError).toBe(true);
    expect(r.code).toBe("INVALID_INPUT");
  });
});
