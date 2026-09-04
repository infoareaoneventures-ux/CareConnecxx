// Release criterion #4 — webhook idempotency at the handler level.
//
// Verifies, for the real exported onRequest handlers:
//   - a replayed Stripe/Checkr delivery is acked WITHOUT reprocessing
//   - a delivery whose handler fails releases its claim, so the provider's
//     retry advances state exactly once overall
// (stripeConnectWebhook shares the identical claim/settle wiring and ledger
// collection; the mechanism itself is unit-tested in utils/__tests__/webhookLedger.test.ts.)

import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  // Module-load-time env for stripe.ts / checkr.ts (vi.hoisted runs first).
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect_test";
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  process.env.CHECKR_WEBHOOK_SECRET = "";
  process.env.FUNCTIONS_EMULATOR = "true"; // checkr: skip signature verification

  const docs = new Map<string, any>();
  const collState = new Map<string, any[]>();
  const updates: Array<{ path: string; data: any }> = [];
  const sets: Array<{ path: string; data: any }> = [];
  const adds: Array<{ path: string; data: any }> = [];
  const failCollections = new Set<string>(); // force handler failures mid-flight

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    create: vi.fn(async (data: any) => {
      if (docs.has(path)) {
        const err: any = new Error("ALREADY_EXISTS");
        err.code = 6;
        throw err;
      }
      docs.set(path, data);
    }),
    get: vi.fn(async () => ({ exists: docs.has(path), data: () => docs.get(path) })),
    set: vi.fn(async (data: any, opts?: any) => {
      sets.push({ path, data });
      docs.set(path, opts?.merge ? { ...(docs.get(path) ?? {}), ...data } : data);
    }),
    update: vi.fn(async (data: any) => {
      updates.push({ path, data });
      docs.set(path, { ...(docs.get(path) ?? {}), ...data });
    }),
    delete: vi.fn(async () => { docs.delete(path); }),
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });

  const makeCollRef = (path: string): any => {
    const ref: any = {};
    ref.doc = (id: string) => makeDocRef(`${path}/${id}`);
    ref.where = (..._a: any[]) => ref;
    ref.limit = (..._a: any[]) => ref;
    ref.get = vi.fn(async () => {
      const items = collState.get(path) ?? [];
      return {
        empty: items.length === 0,
        docs: items.map((d: any, i: number) => ({
          id: d.id ?? `doc-${i}`,
          data: () => d,
          ref: makeDocRef(`${path}/${d.id ?? `doc-${i}`}`),
        })),
      };
    });
    ref.add = vi.fn(async (data: any) => {
      adds.push({ path, data });
      return { id: `auto-${adds.length}` };
    });
    return ref;
  };

  const collection = vi.fn((name: string) => {
    if (failCollections.has(name)) throw new Error(`forced ${name} outage`);
    return makeCollRef(name);
  });

  const runTransaction = vi.fn(async (fn: any) =>
    fn({
      get: async (ref: any) => ref.get(),
      set: (ref: any, data: any) => { docs.set(ref.path, data); },
      update: (ref: any, data: any) => { docs.set(ref.path, { ...(docs.get(ref.path) ?? {}), ...data }); },
    })
  );

  const firestoreFn: any = Object.assign(() => ({ collection, runTransaction }), {
    FieldValue: {
      serverTimestamp: () => ({ __serverTimestamp: true }),
      arrayUnion: (...v: any[]) => ({ __arrayUnion: v }),
      increment: (n: number) => ({ __increment: n }),
      delete: () => ({ __delete: true }),
    },
  });

  // Constructable stripe stub whose webhook verification just parses the body.
  const StripeClass: any = function () {
    return { webhooks: { constructEvent: (raw: Buffer) => JSON.parse(raw.toString()) } };
  };

  return {
    docs, collState, updates, sets, adds, failCollections, collection, firestoreFn, StripeClass,
    reset: () => {
      docs.clear(); collState.clear(); updates.length = 0; sets.length = 0; adds.length = 0; failCollections.clear();
    },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestoreFn },
  apps: [{}],
  initializeApp: vi.fn(),
  firestore: hoisted.firestoreFn,
}));

vi.mock("stripe", () => ({ __esModule: true, default: hoisted.StripeClass }));

import { stripeWebhook } from "../stripe";
import { stripeConnectWebhook } from "../stripeConnectWebhook";
import { checkrWebhook } from "../checkr";

function makeRes() {
  const res: any = { statusCode: 200 };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn(() => res);
  res.send = vi.fn(() => res);
  return res;
}

function stripeReq(event: any) {
  return {
    method: "POST",
    headers: { "stripe-signature": "sig_test" },
    rawBody: Buffer.from(JSON.stringify(event)),
  } as any;
}

function checkrReq(event: any) {
  return { method: "POST", headers: {}, body: event, rawBody: Buffer.from("") } as any;
}

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
});

describe("stripeWebhook — exactly-once", () => {
  const subscriptionEvent = (id: string) => ({
    id,
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_1",
        status: "active",
        metadata: { firebaseUID: "user1" },
        current_period_start: 1750000000,
        current_period_end: 1752000000,
        cancel_at_period_end: false,
        canceled_at: null,
      },
    },
  });

  it("acks a replayed delivery without reprocessing", async () => {
    // update() + set() both count — the subscription handlers write with
    // set/merge so a missing SMS-path doc can't 500 the webhook.
    const writes = () => hoisted.updates.length + hoisted.sets.length;
    const res1 = makeRes();
    await (stripeWebhook as any)(stripeReq(subscriptionEvent("evt_a")), res1);
    expect(res1.json).toHaveBeenCalledWith({ received: true });
    const writesAfterFirst = writes();
    expect(writesAfterFirst).toBeGreaterThan(0); // subscription + user doc advanced
    expect(hoisted.docs.get("processed_stripe_events/evt_a")).toMatchObject({ status: "processed" });

    const res2 = makeRes();
    await (stripeWebhook as any)(stripeReq(subscriptionEvent("evt_a")), res2);
    expect(res2.json).toHaveBeenCalledWith({ received: true, status: "already_processed" });
    expect(writes()).toBe(writesAfterFirst); // state advanced exactly once
  });

  it("resolves an SMS-created subscription (phone metadata, no firebaseUID) and mirrors onto the caregiver doc", async () => {
    hoisted.docs.set("agent_sessions/+15550001111", { userId: "cg9" });
    hoisted.docs.set("caregivers/cg9", { uid: "cg9", membershipPaid: true });
    const event = {
      id: "evt_sms_upd",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_sms", status: "active",
          metadata: { phone: "+15550001111", kind: "caregiver_membership" },
          current_period_start: 1750000000, current_period_end: 1752000000,
          cancel_at_period_end: false, canceled_at: null,
        },
      },
    };
    const res = makeRes();
    await (stripeWebhook as any)(stripeReq(event), res);
    expect(res.json).toHaveBeenCalledWith({ received: true });
    expect(hoisted.docs.get("users/cg9")).toMatchObject({ membershipStatus: "active", subscriptionActive: true });
    expect(hoisted.docs.get("caregivers/cg9")).toMatchObject({ membershipStatus: "active", membershipPaid: true });
  });

  it("cancellation of an SMS-created subscription flips the caregiver doc to canceled", async () => {
    hoisted.docs.set("agent_sessions/+15550001111", { userId: "cg9" });
    hoisted.docs.set("caregivers/cg9", { uid: "cg9", membershipPaid: true });
    const event = {
      id: "evt_sms_del",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_sms", status: "canceled",
          metadata: { phone: "+15550001111", kind: "caregiver_membership" },
          canceled_at: 1752000000,
        },
      },
    };
    const res = makeRes();
    await (stripeWebhook as any)(stripeReq(event), res);
    expect(res.json).toHaveBeenCalledWith({ received: true });
    expect(hoisted.docs.get("users/cg9")).toMatchObject({ membershipStatus: "canceled", subscriptionActive: false });
    expect(hoisted.docs.get("caregivers/cg9")).toMatchObject({ membershipStatus: "canceled" });
  });

  it("releases the claim on failure so Stripe's retry advances state exactly once", async () => {
    hoisted.failCollections.add("customers");
    const res1 = makeRes();
    await (stripeWebhook as any)(stripeReq(subscriptionEvent("evt_b")), res1);
    expect(res1.status).toHaveBeenCalledWith(500); // Stripe will retry
    expect(hoisted.docs.has("processed_stripe_events/evt_b")).toBe(false); // claim released

    hoisted.failCollections.clear();
    const res2 = makeRes();
    await (stripeWebhook as any)(stripeReq(subscriptionEvent("evt_b")), res2);
    expect(res2.json).toHaveBeenCalledWith({ received: true }); // retry NOT eaten as duplicate
    expect(hoisted.docs.get("users/user1")).toMatchObject({ membershipStatus: "active" });
    expect(hoisted.docs.get("processed_stripe_events/evt_b")).toMatchObject({ status: "processed" });
  });
});

describe("stripeWebhook — onboardingStep resync (2026-09-03)", () => {
  // A client who finishes membership through the WEBSITE's own checkout
  // (not Evia's texted link) never gets advanceOnboardingStep('payment', ...)
  // called — that only fires from checkout.session.completed when
  // session.metadata.task === 'client_payment_setup', set only by Evia's own
  // checkout creation. Left unrepaired, agent_sessions.onboardingStep stays
  // parked on an early client_* step forever even though the account is
  // fully active. handleSubscriptionUpdated (customer.subscription.updated —
  // fires regardless of which channel completed checkout) is the one place
  // both channels are guaranteed to meet, so it resyncs the flag once
  // identity is ALSO genuinely verified.
  const activeSubscriptionEvent = (id: string) => ({
    id,
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_resync",
        status: "active",
        metadata: { firebaseUID: "client1" },
        current_period_start: 1750000000,
        current_period_end: 1752000000,
        cancel_at_period_end: false,
        canceled_at: null,
      },
    },
  });

  it("flips a stuck pre-payment client step to complete once identity is also verified", async () => {
    hoisted.docs.set("users/client1", { identityCheckStatus: "verified" });
    hoisted.collState.set("agent_sessions", [
      { id: "+15551234567", userId: "client1", onboardingStep: "client_ask_plan" },
    ]);
    const res = makeRes();
    await (stripeWebhook as any)(stripeReq(activeSubscriptionEvent("evt_resync_a")), res);
    expect(res.json).toHaveBeenCalledWith({ received: true });
    expect(hoisted.docs.get("agent_sessions/+15551234567")).toMatchObject({ onboardingStep: "complete" });
  });

  it("leaves the step alone when identity has not been verified yet", async () => {
    hoisted.docs.set("users/client1", { identityCheckStatus: "processing" });
    hoisted.collState.set("agent_sessions", [
      { id: "+15551234567", userId: "client1", onboardingStep: "client_ask_plan" },
    ]);
    const res = makeRes();
    await (stripeWebhook as any)(stripeReq(activeSubscriptionEvent("evt_resync_b")), res);
    expect(res.json).toHaveBeenCalledWith({ received: true });
    expect(hoisted.docs.get("agent_sessions/+15551234567")).toBeUndefined();
  });

  it("never touches a session that isn't sitting on a pre-payment client step", async () => {
    hoisted.docs.set("users/client1", { identityCheckStatus: "verified" });
    // Already complete — a normal, fully-active client sending an ordinary
    // message; the resync must be a no-op, never a redundant write.
    hoisted.collState.set("agent_sessions", [
      { id: "+15551234567", userId: "client1", onboardingStep: "complete" },
    ]);
    const res = makeRes();
    await (stripeWebhook as any)(stripeReq(activeSubscriptionEvent("evt_resync_c")), res);
    expect(res.json).toHaveBeenCalledWith({ received: true });
    expect(hoisted.docs.get("agent_sessions/+15551234567")).toBeUndefined();
  });

  it("does nothing when no agent_sessions doc references this user", async () => {
    hoisted.docs.set("users/client1", { identityCheckStatus: "verified" });
    hoisted.collState.set("agent_sessions", []);
    const res = makeRes();
    await (stripeWebhook as any)(stripeReq(activeSubscriptionEvent("evt_resync_d")), res);
    expect(res.json).toHaveBeenCalledWith({ received: true }); // no crash
  });
});

describe("checkrWebhook — exactly-once", () => {
  const clearReportEvent = (id?: string) => ({
    ...(id ? { id } : {}),
    type: "report.completed",
    data: { object: { id: "rep_1", candidate_id: "cand_1", result: "clear", status: "complete" } },
  });

  beforeEach(() => {
    // Caregiver matched by checkrCandidateId; no phone → no Evia-advance path.
    hoisted.collState.set("caregivers", [
      { id: "cg1", name: "Test CG", backgroundCheckData: { checkrCandidateId: "cand_1" } },
    ]);
  });

  it("approves the caregiver once; a replayed report.completed is skipped", async () => {
    const res1 = makeRes();
    await (checkrWebhook as any)(checkrReq(clearReportEvent("evt_chk_1")), res1);
    expect(res1.json).toHaveBeenCalledWith({ received: true });
    expect(hoisted.docs.get("caregivers/cg1")).toMatchObject({
      verified: true,
      verificationStatus: "approved",
    });
    const cgUpdates = () => hoisted.updates.filter((u) => u.path === "caregivers/cg1").length;
    const approvalNotifications = () =>
      hoisted.adds.filter((a) => a.path === "users/cg1/notifications").length;
    expect(cgUpdates()).toBe(1);
    expect(approvalNotifications()).toBe(1);

    const res2 = makeRes();
    await (checkrWebhook as any)(checkrReq(clearReportEvent("evt_chk_1")), res2);
    expect(res2.json).toHaveBeenCalledWith({ received: true, status: "already_processed" });
    expect(cgUpdates()).toBe(1);              // not re-approved
    expect(approvalNotifications()).toBe(1);  // "you're approved!" not re-sent
  });

  it("still processes events that arrive without an id (no dedupe possible)", async () => {
    const event = { type: "invitation.created", data: { object: { candidate_id: "cand_1" } } };
    const res1 = makeRes();
    const res2 = makeRes();
    await (checkrWebhook as any)(checkrReq(event), res1);
    await (checkrWebhook as any)(checkrReq(event), res2);
    expect(res1.json).toHaveBeenCalledWith({ received: true });
    expect(res2.json).toHaveBeenCalledWith({ received: true });
    expect(hoisted.updates.filter((u) => u.path === "caregivers/cg1").length).toBe(2);
  });

  it("does NOT auto-approve on a 'consider' result, and dedupes the replay", async () => {
    const considerEvent = (id: string) => ({
      id,
      type: "report.completed",
      data: { object: { id: "rep_2", candidate_id: "cand_1", result: "consider", status: "complete" } },
    });
    const res1 = makeRes();
    await (checkrWebhook as any)(checkrReq(considerEvent("evt_chk_consider")), res1);
    expect(res1.json).toHaveBeenCalledWith({ received: true });
    // A 'consider' result must NOT clear the caregiver for booking.
    expect(hoisted.docs.get("caregivers/cg1")?.verificationStatus).not.toBe("approved");
    expect(hoisted.docs.get("caregivers/cg1")?.verified).not.toBe(true);
    const cgUpdatesAfterFirst = hoisted.updates.filter((u) => u.path === "caregivers/cg1").length;

    const res2 = makeRes();
    await (checkrWebhook as any)(checkrReq(considerEvent("evt_chk_consider")), res2);
    expect(res2.json).toHaveBeenCalledWith({ received: true, status: "already_processed" });
    expect(hoisted.updates.filter((u) => u.path === "caregivers/cg1").length).toBe(cgUpdatesAfterFirst);
  });
});

describe("stripeConnectWebhook — exactly-once", () => {
  const accountUpdatedEvent = (id: string) => ({
    id,
    type: "account.updated",
    data: { object: { id: "acct_1", charges_enabled: true, payouts_enabled: true, details_submitted: true } },
  });

  beforeEach(() => {
    // Caregiver matched by stripeAccountId; no phone → skip the Evia-advance path.
    hoisted.collState.set("caregivers", [
      { id: "cg1", stripeAccountId: "acct_1" },
    ]);
  });

  it("marks Connect onboarding complete once; a replayed account.updated is skipped", async () => {
    const res1 = makeRes();
    await (stripeConnectWebhook as any)(stripeReq(accountUpdatedEvent("evt_conn_1")), res1);
    expect(res1.json).toHaveBeenCalledWith({ received: true });
    expect(hoisted.docs.get("caregivers/cg1")).toMatchObject({ stripeOnboardingComplete: true });
    expect(hoisted.docs.get("processed_stripe_events/evt_conn_1")).toMatchObject({ status: "processed" });
    const updatesAfterFirst = hoisted.updates.filter((u) => u.path === "caregivers/cg1").length;

    const res2 = makeRes();
    await (stripeConnectWebhook as any)(stripeReq(accountUpdatedEvent("evt_conn_1")), res2);
    expect(res2.json).toHaveBeenCalledWith({ received: true, status: "already_processed" });
    expect(hoisted.updates.filter((u) => u.path === "caregivers/cg1").length).toBe(updatesAfterFirst);
  });
});
