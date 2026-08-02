import { describe, it, expect, vi, beforeEach } from "vitest";

// Fix 1 (caregiver-signup-fixes-2026-07-07): the Connect webhook now MATCHES a
// caregiver whose Express account id was mirrored onto the caregivers doc during
// onboarding, so account.updated (charges+payouts enabled) can finalize signup
// server-side. This test drives the webhook handler and asserts that a matched,
// complete account advances Evia onboarding with the caregiver's phone, and that
// the ledger's exactly-once guard drops a duplicate redelivery.

const hoisted = vi.hoisted(() => {
  const advanceOnboardingStep = vi.fn(async (..._a: unknown[]) => {});
  const docUpdate = vi.fn(async () => {});
  const privateSet = vi.fn(async () => {});
  const caregiverDoc = {
    ref:  { update: docUpdate },
    id:   "cg-1",
    data: () => ({ phone: "+15551112222" }),
  };
  // The handler resolves the caregiver via resolveCaregiverByStripeAccount
  // (stripe_accounts map first — empty here — then the parent-field query
  // fallback), then updates caregivers/{id} by doc ref and dual-writes
  // private/payout. Model that whole surface.
  const caregiverDocRef = {
    update: docUpdate,
    get: async () => ({ exists: true, data: () => ({ phone: "+15551112222" }) }),
    collection: () => ({ doc: () => ({ set: privateSet }) }),
  };
  // caregivers query → one matching doc; all other collections → empty/no-op.
  // where() args are captured so the test binds the webhook's match query to the
  // exact field Fix 1 mirrors onto the caregiver doc (stripeAccountId).
  const caregiverWhereArgs: unknown[][] = [];
  const collectionMock = vi.fn((name: string) => {
    if (name === "caregivers") {
      return {
        where: (...args: unknown[]) => {
          caregiverWhereArgs.push(args);
          return { limit: () => ({ get: async () => ({ empty: false, docs: [caregiverDoc] }) }) };
        },
        doc: () => caregiverDocRef,
      };
    }
    return {
      where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }),
      doc: () => ({ get: async () => ({ exists: false, data: () => null }), set: vi.fn(async () => {}) }),
    };
  });

  const constructEvent = vi.fn();
  const claimWebhookEvent = vi.fn(async (..._a: unknown[]) => "claimed");
  const settleWebhookEvent = vi.fn(async (..._a: unknown[]) => {});

  // ── Childcare U8: a fuller in-memory store for the payout.paid path ────────
  // (resolve caregiver → payouts ledger add/update → shiftHours sweep → batch
  // stamping → notifications). Installed per-test via collectionMock.
  const store = new Map<string, any>();
  const makeStoreDocRef = (path: string): any => ({
    id: path.split("/").pop(),
    path,
    get: async () => ({ exists: store.has(path), id: path.split("/").pop(), data: () => store.get(path) }),
    set: async (data: any, opts?: any) => {
      store.set(path, opts?.merge ? { ...(store.get(path) ?? {}), ...data } : { ...data });
    },
    update: async (data: any) => {
      store.set(path, { ...(store.get(path) ?? {}), ...data });
    },
    collection: (sub: string) => makeStoreCollRef(`${path}/${sub}`),
  });
  const makeStoreQuery = (collPath: string, filters: Array<[string, any]> = [], lim?: number): any => ({
    where: (field: string, _op: string, value: any) => makeStoreQuery(collPath, [...filters, [field, value]], lim),
    limit: (n: number) => makeStoreQuery(collPath, filters, n),
    get: async () => {
      let rows = [...store.entries()]
        .filter(([p]) => p.startsWith(`${collPath}/`) && p.split("/").length === collPath.split("/").length + 1)
        .map(([p, d]) => ({ id: p.split("/").pop()!, data: () => d, ref: makeStoreDocRef(p), _raw: d }))
        .filter((r) => filters.every(([f, v]) => r._raw[f] === v));
      if (lim !== undefined) rows = rows.slice(0, lim);
      return {
        empty: rows.length === 0,
        size: rows.length,
        docs: rows,
        forEach: (fn: (row: any) => void) => rows.forEach(fn),
      };
    },
  });
  const makeStoreCollRef = (path: string): any => ({
    doc: (id?: string) => makeStoreDocRef(`${path}/${id ?? `auto-${store.size}`}`),
    add: async (data: any) => {
      const ref = makeStoreDocRef(`${path}/auto-${store.size}`);
      await ref.set(data);
      return ref;
    },
    where: makeStoreQuery(path).where,
    limit: makeStoreQuery(path).limit,
    get: makeStoreQuery(path).get,
  });
  const makeBatch = () => {
    const ops: Array<() => Promise<void>> = [];
    return {
      update: (ref: any, data: any) => ops.push(() => ref.update(data)),
      set: (ref: any, data: any, opts?: any) => ops.push(() => ref.set(data, opts)),
      delete: () => {},
      commit: async () => { for (const op of ops) await op(); },
    };
  };

  return { advanceOnboardingStep, docUpdate, collectionMock, caregiverWhereArgs, constructEvent, claimWebhookEvent, settleWebhookEvent, store, makeStoreCollRef, makeBatch };
});

vi.mock("firebase-functions/v1", () => {
  const https = { onRequest: (handler: unknown) => handler };
  const fn = { https, config: () => ({}) };
  return { __esModule: true, ...fn, default: fn, https, config: () => ({}) };
});

vi.mock("firebase-admin", () => {
  const FieldValue = { serverTimestamp: () => "ts" };
  const firestore: any = () => ({ collection: hoisted.collectionMock, batch: hoisted.makeBatch });
  firestore.FieldValue = FieldValue;
  return {
    __esModule: true,
    apps: [{}],
    initializeApp: vi.fn(),
    firestore,
    default: { apps: [{}], initializeApp: vi.fn(), firestore },
  };
});

vi.mock("stripe", () => ({
  __esModule: true,
  default: vi.fn(function () {
    return { webhooks: { constructEvent: (...a: unknown[]) => hoisted.constructEvent(...a) } };
  }),
}));

vi.mock("./utils/webhookLedger", () => ({
  STRIPE_EVENTS_COLLECTION: "processed_stripe_events",
  claimWebhookEvent: (...a: unknown[]) => hoisted.claimWebhookEvent(...a),
  settleWebhookEvent: (...a: unknown[]) => hoisted.settleWebhookEvent(...a),
}));

vi.mock("./billing/paymentMethods", () => ({ isOfflinePaymentMethod: () => false }));

// The handler dynamically imports this at finalization time.
vi.mock("./agents/onboardingConversation", () => ({
  advanceOnboardingStep: (...a: unknown[]) => hoisted.advanceOnboardingStep(...a),
}));

function makeRes() {
  return {
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this; },
    send: vi.fn(),
    json: vi.fn(),
  };
}

const OLD_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.caregiverWhereArgs.length = 0;
  process.env = { ...OLD_ENV, STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_test", STRIPE_SECRET_KEY: "sk_test" };
  hoisted.claimWebhookEvent.mockResolvedValue("claimed");
  hoisted.constructEvent.mockReturnValue({
    id:   "evt_1",
    type: "account.updated",
    data: { object: { id: "acct_1", charges_enabled: true, payouts_enabled: true, details_submitted: true } },
  });
});

describe("stripeConnectWebhook — account.updated matching (Fix 1)", () => {
  it("advances onboarding with the caregiver's phone when a matched account is complete", async () => {
    const { stripeConnectWebhook } = await import("./stripeConnectWebhook");
    const req: any = { headers: { "stripe-signature": "sig" }, rawBody: Buffer.from("{}") };
    const res = makeRes();

    await (stripeConnectWebhook as any)(req, res);

    // The match query MUST be on the exact field Fix 1 mirrors onto the doc —
    // if either side drifts, matching silently dies and this catches it.
    expect(hoisted.caregiverWhereArgs[0]).toEqual(["stripeAccountId", "==", "acct_1"]);
    expect(hoisted.docUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ stripeOnboardingComplete: true })
    );
    expect(hoisted.advanceOnboardingStep).toHaveBeenCalledWith("+15551112222", "stripe_connect", "");
    expect(res.json).toHaveBeenCalledWith({ received: true });
  }, 20_000);

  it("drops a duplicate redelivery via the exactly-once ledger (no double advance)", async () => {
    hoisted.claimWebhookEvent.mockResolvedValueOnce("duplicate");
    const { stripeConnectWebhook } = await import("./stripeConnectWebhook");
    const req: any = { headers: { "stripe-signature": "sig" }, rawBody: Buffer.from("{}") };
    const res = makeRes();

    await (stripeConnectWebhook as any)(req, res);

    expect(hoisted.advanceOnboardingStep).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ received: true, status: "already_processed" });
  }, 20_000);
});

// ── Childcare U8 (R39): payout.paid ledger correlation ───────────────────────
//
// The sweep itself is deliberately vertical-agnostic (a caregiver-level payout
// covers childcare shifts too — that IS the correct senior-parity behavior).
// The ADDITIVE piece under test: when the sweep covers childcare rows, the
// payouts ledger doc records their shiftHours + booking IDs (opaque IDs only);
// a senior-only payout writes NO correlation fields (byte-identical).

describe("stripeConnectWebhook — payout.paid childcare ledger correlation (U8)", () => {
  function installStore() {
    hoisted.store.clear();
    hoisted.collectionMock.mockImplementation((name: string) => hoisted.makeStoreCollRef(name));
  }

  function seedPayoutEnv(withChildcare: boolean) {
    installStore();
    // resolveCaregiverByStripeAccount: stripe_accounts reverse map hit.
    hoisted.store.set("stripe_accounts/acct_1", { caregiverId: "cg-1" });
    hoisted.store.set("caregivers/cg-1", { name: "Pat", phone: "+15551112222" });
    // One senior paid shift, settled BEFORE the payout was cut.
    hoisted.store.set("shiftHours/sa1", {
      caregiverId: "cg-1", status: "paid", paymentMethod: "credit",
      lastPaymentAttemptAt: "2026-07-20T00:00:00.000Z", appointmentId: "sa1",
    });
    if (withChildcare) {
      hoisted.store.set("shiftHours/cappt_1", {
        caregiverId: "cg-1", status: "paid", paymentMethod: "credit",
        careVertical: "child", childcareBookingId: "cbook_1",
        lastPaymentAttemptAt: "2026-07-20T00:00:00.000Z", appointmentId: "cappt_1",
      });
    }
    hoisted.constructEvent.mockReturnValue({
      id: "evt_po_1",
      type: "payout.paid",
      account: "acct_1",
      data: {
        object: {
          id: "po_1", amount: 15000, method: "standard",
          created: Math.floor(Date.parse("2026-07-21T00:00:00.000Z") / 1000),
          arrival_date: Math.floor(Date.parse("2026-07-22T00:00:00.000Z") / 1000),
        },
      },
    });
  }

  async function fire() {
    const { stripeConnectWebhook } = await import("./stripeConnectWebhook");
    const req: any = { headers: { "stripe-signature": "sig" }, rawBody: Buffer.from("{}") };
    const res = makeRes();
    await (stripeConnectWebhook as any)(req, res);
    return res;
  }

  it("stamps covered childcare rows AND records the booking/shift correlation on the payout ledger", async () => {
    seedPayoutEnv(true);
    const res = await fire();
    expect(res.json).toHaveBeenCalledWith({ received: true });

    // Both verticals' shifts are stamped by the same sweep (senior parity).
    expect(hoisted.store.get("shiftHours/sa1")?.payoutStatus).toBe("completed");
    expect(hoisted.store.get("shiftHours/cappt_1")?.payoutStatus).toBe("completed");
    expect(hoisted.store.get("shiftHours/cappt_1")?.stripePayoutId).toBe("po_1");

    // The additive R39 correlation: opaque IDs only, on the payouts ledger row.
    const ledger = [...hoisted.store.entries()].find(([p]) =>
      p.startsWith("caregivers/cg-1/payouts/"),
    )?.[1];
    expect(ledger).toBeTruthy();
    expect(ledger.stripePayoutId).toBe("po_1");
    expect(ledger.childcareShiftHoursIds).toEqual(["cappt_1"]);
    expect(ledger.childcareBookingIds).toEqual(["cbook_1"]);
    expect(JSON.stringify(ledger)).not.toMatch(/childName|recipientLabel|allergy/);
  });

  it("a senior-only payout ledger row is byte-identical (no correlation fields)", async () => {
    seedPayoutEnv(false);
    await fire();
    expect(hoisted.store.get("shiftHours/sa1")?.payoutStatus).toBe("completed");
    const ledger = [...hoisted.store.entries()].find(([p]) =>
      p.startsWith("caregivers/cg-1/payouts/"),
    )?.[1];
    expect(ledger).toBeTruthy();
    expect(ledger.childcareShiftHoursIds).toBeUndefined();
    expect(ledger.childcareBookingIds).toBeUndefined();
  });
});
