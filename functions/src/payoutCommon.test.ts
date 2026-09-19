import { describe, it, expect, vi, beforeEach } from "vitest";

// ── mocks ─────────────────────────────────────────────────────────────────────

const hoisted = vi.hoisted(() => {
  // caregivers/{id} doc + caregivers/{id}/payouts subcollection
  const caregiverGet = vi.fn();
  const payoutSet    = vi.fn().mockResolvedValue(undefined);
  const payoutUpdate = vi.fn().mockResolvedValue(undefined);
  const recentGet    = vi.fn().mockResolvedValue({ empty: true, docs: [] });
  const notifAdd     = vi.fn().mockResolvedValue({ id: "n1" });

  const payoutDocRef = { id: "payout-doc-1", set: payoutSet, update: payoutUpdate };
  const payoutsCol = {
    doc: vi.fn(() => payoutDocRef),
    orderBy: vi.fn(() => ({ limit: vi.fn(() => ({ get: recentGet })) })),
  };
  // Shared per-caregiver replay-guard lock doc (payoutLocks/instant) — read +
  // bumped inside the transaction so concurrent requests serialize.
  const lockGet = vi.fn().mockResolvedValue({ exists: false, data: () => null });
  const lockSet = vi.fn();
  const lockRef = { get: lockGet, set: lockSet };
  const payoutLocksCol = { doc: vi.fn(() => lockRef) };
  // Minimal transaction: txn.get delegates to the target's own .get() (both
  // the lock doc ref and the recent-payout query mock expose one); txn.set
  // delegates to the ref's .set() so existing payoutSet assertions still see
  // the written doc. Single-caller tests need no conflict/retry semantics.
  const runTransaction = vi.fn(async (fn: (txn: unknown) => Promise<unknown>) =>
    fn({
      get: (target: { get: () => unknown }) => target.get(),
      set: (ref: { set: (data: unknown, opts?: unknown) => unknown }, data: unknown, opts?: unknown) =>
        opts === undefined ? ref.set(data) : ref.set(data, opts),
    }),
  );
  const caregiverRef = {
    get: caregiverGet,
    collection: vi.fn((name: string) => {
      if (name === "payouts") return payoutsCol;
      if (name === "payoutLocks") return payoutLocksCol;
      throw new Error(`unexpected subcollection ${name}`);
    }),
    firestore: { runTransaction },
  };
  const usersNotifCol = { add: notifAdd };
  const usersRef = { collection: vi.fn(() => usersNotifCol) };

  const collection = vi.fn((name: string) => {
    if (name === "caregivers") return { doc: vi.fn(() => caregiverRef) };
    if (name === "users")      return { doc: vi.fn(() => usersRef) };
    throw new Error(`unexpected collection ${name}`);
  });

  // Stripe
  const accountsRetrieve = vi.fn();
  const balanceRetrieve  = vi.fn();
  const payoutsCreate    = vi.fn();
  const transfersCreate  = vi.fn(async () => ({ id: "tr_fee_1" }));

  return {
    caregiverGet, payoutSet, payoutUpdate, recentGet, notifAdd, collection,
    accountsRetrieve, balanceRetrieve, payoutsCreate, transfersCreate,
    lockGet, lockSet, runTransaction,
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: hoisted.collection }) },
  firestore: Object.assign(() => ({ collection: hoisted.collection }), {
    FieldValue: { serverTimestamp: vi.fn(() => "__TS__") },
  }),
}));

vi.mock("./stripe", () => ({
  getStripeClient: () => ({
    accounts: { retrieve: hoisted.accountsRetrieve },
    balance:  { retrieve: hoisted.balanceRetrieve },
    payouts:  { create:   hoisted.payoutsCreate },
    transfers: { create:  hoisted.transfersCreate },
  }),
}));

import { executeInstantPayout, InstantPayoutError, payoutReadinessProblem } from "./payoutCommon";

const READY_ACCOUNT = {
  charges_enabled: true,
  payouts_enabled: true,
  requirements: { disabled_reason: null, past_due: [], currently_due: [] },
};

function expectPayoutError(promise: Promise<unknown>, code: string) {
  return promise.then(
    () => { throw new Error(`expected InstantPayoutError ${code}, got success`); },
    (err) => {
      expect(err).toBeInstanceOf(InstantPayoutError);
      expect((err as InstantPayoutError).code).toBe(code);
    },
  );
}

describe("payoutReadinessProblem", () => {
  it("null for a fully-enabled account", () => {
    expect(payoutReadinessProblem(READY_ACCOUNT)).toBeNull();
  });
  it("flags disabled payouts, disabled_reason, and outstanding requirements", () => {
    expect(payoutReadinessProblem({ ...READY_ACCOUNT, payouts_enabled: false })).toMatch(/not fully onboarded/i);
    expect(payoutReadinessProblem({ ...READY_ACCOUNT, requirements: { disabled_reason: "under_review" } })).toMatch(/under_review/);
    expect(payoutReadinessProblem({ ...READY_ACCOUNT, requirements: { past_due: ["dob"], currently_due: [] } })).toMatch(/additional information/i);
  });
});

describe("executeInstantPayout", () => {
  beforeEach(() => {
    hoisted.caregiverGet.mockReset();
    hoisted.payoutSet.mockClear();
    hoisted.payoutUpdate.mockClear();
    hoisted.notifAdd.mockClear();
    hoisted.lockGet.mockClear();
    hoisted.lockSet.mockClear();
    hoisted.runTransaction.mockClear();
    hoisted.recentGet.mockReset().mockResolvedValue({ empty: true, docs: [] });
    // With an account id → the caregiver's connected account (readiness); with none → the platform account (fee debit destination).
    hoisted.accountsRetrieve.mockReset().mockImplementation(async (id?: string) => (id ? READY_ACCOUNT : { ...READY_ACCOUNT, id: "acct_platform" }));
    hoisted.balanceRetrieve.mockReset().mockResolvedValue({
      instant_available: [{ amount: 5000, currency: "usd" }],
    });
    hoisted.payoutsCreate.mockReset().mockResolvedValue({
      id: "po_1", status: "pending", arrival_date: 1_800_000_000,
    });
    hoisted.caregiverGet.mockResolvedValue({ exists: true, data: () => ({ stripeAccountId: "acct_1" }) });
  });

  it("pays the instant balance minus Stripe's 1% fee (min $0.50), recoups the fee by account debit, doc-keyed idempotency", async () => {
    const r = await executeInstantPayout({ caregiverId: "cg1", source: "app" });
    // $50.00 available → $0.50 fee → $49.50 arrives.
    expect(r).toMatchObject({ amountCents: 4950, grossCents: 5000, feeCents: 50 });
    expect(r.stripePayoutId).toBe("po_1");
    expect(hoisted.payoutsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 4950, currency: "usd", method: "instant" }),
      expect.objectContaining({ stripeAccount: "acct_1", idempotencyKey: "instant-payout-payout-doc-1" }),
    );
    // The fee comes back to the platform from the connected account.
    expect(hoisted.transfersCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 50, currency: "usd", destination: "acct_platform" }),
      expect.objectContaining({ stripeAccount: "acct_1", idempotencyKey: "instant-payout-fee-payout-doc-1" }),
    );
    expect(hoisted.payoutUpdate).toHaveBeenCalledWith(expect.objectContaining({ feeTransferId: "tr_fee_1" }));
    // Unified record: what arrives, what was paid out, and the fee.
    expect(hoisted.payoutSet).toHaveBeenCalledWith(expect.objectContaining({ amount: 49.5, grossAmount: 50, fee: 0.5, type: "instant", status: "pending", source: "app" }));
    expect(hoisted.payoutUpdate).toHaveBeenCalledWith(expect.objectContaining({ stripePayoutId: "po_1" }));
    expect(hoisted.notifAdd).toHaveBeenCalled();
    // Replay guard runs transactionally: the shared lock doc is read (this is
    // what serializes concurrent requests) and bumped alongside the new doc.
    expect(hoisted.runTransaction).toHaveBeenCalledTimes(1);
    expect(hoisted.lockGet).toHaveBeenCalled();
    expect(hoisted.lockSet).toHaveBeenCalledWith({ lastRequestedAt: expect.any(String) }, { merge: true });
  });

  it("replay guard: a moments-ago payout still awaiting its Stripe id throws DUPLICATE", async () => {
    hoisted.recentGet.mockResolvedValueOnce({
      empty: false,
      docs: [{
        id: "prev-doc",
        data: () => ({ createdAt: new Date().toISOString(), status: "pending", stripePayoutId: null }),
      }],
    });
    await expectPayoutError(executeInstantPayout({ caregiverId: "cg1", source: "app" }), "DUPLICATE");
    expect(hoisted.payoutsCreate).not.toHaveBeenCalled();
  });

  it("honors a requested partial amount and rejects overdraw", async () => {
    const r = await executeInstantPayout({ caregiverId: "cg1", requestedCents: 2000, source: "mcp" });
    // $20 requested → $0.50 fee (the minimum) → $19.50 arrives.
    expect(r).toMatchObject({ amountCents: 1950, grossCents: 2000, feeCents: 50 });
    await expectPayoutError(
      executeInstantPayout({ caregiverId: "cg1", requestedCents: 999999, source: "mcp" }),
      "EXCEEDS_BALANCE",
    );
  });

  it("NOT_FOUND / NO_ACCOUNT / NOT_READY / NO_BALANCE preconditions never reach Stripe payouts.create", async () => {
    hoisted.caregiverGet.mockResolvedValueOnce({ exists: false, data: () => null });
    await expectPayoutError(executeInstantPayout({ caregiverId: "nope", source: "app" }), "NOT_FOUND");

    hoisted.caregiverGet.mockResolvedValueOnce({ exists: true, data: () => ({}) });
    await expectPayoutError(executeInstantPayout({ caregiverId: "cg1", source: "app" }), "NO_ACCOUNT");

    hoisted.accountsRetrieve.mockResolvedValueOnce({ ...READY_ACCOUNT, payouts_enabled: false });
    await expectPayoutError(executeInstantPayout({ caregiverId: "cg1", source: "app" }), "NOT_READY");

    hoisted.balanceRetrieve.mockResolvedValueOnce({ instant_available: [{ amount: 0, currency: "usd" }] });
    await expectPayoutError(executeInstantPayout({ caregiverId: "cg1", source: "app" }), "NO_BALANCE");

    expect(hoisted.payoutsCreate).not.toHaveBeenCalled();
  });

  it("replay guard: a payout created seconds ago is returned instead of re-created", async () => {
    hoisted.recentGet.mockResolvedValueOnce({
      empty: false,
      docs: [{
        id: "prev-doc",
        data: () => ({
          createdAt: new Date().toISOString(),
          status: "pending",
          stripePayoutId: "po_prev",
          amount: 50,
          arrivalDate: null,
        }),
      }],
    });
    const r = await executeInstantPayout({ caregiverId: "cg1", source: "cara_sms" });
    expect(r.stripePayoutId).toBe("po_prev");
    expect(hoisted.payoutsCreate).not.toHaveBeenCalled();
  });

  it("replay guard does NOT block after the window, or failed attempts", async () => {
    hoisted.recentGet.mockResolvedValueOnce({
      empty: false,
      docs: [{
        id: "old-doc",
        data: () => ({ createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), status: "paid", stripePayoutId: "po_old" }),
      }],
    });
    const r = await executeInstantPayout({ caregiverId: "cg1", source: "app" });
    expect(r.stripePayoutId).toBe("po_1");
    expect(hoisted.payoutsCreate).toHaveBeenCalledTimes(1);
  });

  it("Stripe rejection marks the record failed and throws STRIPE_ERROR", async () => {
    hoisted.payoutsCreate.mockRejectedValueOnce(new Error("instant payouts not supported on this bank"));
    await expectPayoutError(executeInstantPayout({ caregiverId: "cg1", source: "app" }), "STRIPE_ERROR");
    expect(hoisted.payoutUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });
});
