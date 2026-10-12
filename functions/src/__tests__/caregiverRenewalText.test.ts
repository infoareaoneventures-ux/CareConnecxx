// Caregiver sweep B8 (2026-10-11): every caregiver membership renewal tells the
// caregiver what was charged. Caregiver membership is YEARLY ONLY (founder,
// 2026-09-25; the monthly caregiver plan was removed from the code 2026-10-11 —
// no caregiver ever billed on it). Before: the renewal text was keyed to the
// annual background-check refresh, so a renewal where the refresh was not due
// was silent about the charge. Now: keyed on the subscription being a caregiver
// membership, the amount from the invoice, one bell + one text through
// notifications/caregiverAccountEvents.ts. A family's renewal is untouched.

import { describe, it, expect, beforeEach, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  process.env.STRIPE_CAREGIVER_ANNUAL = "price_cg_annual";

  const docs = new Map<string, any>();
  const adds: Array<{ path: string; data: any }> = [];
  const texts: Array<{ phone: string; content: string; fixedString?: boolean }> = [];

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(), path,
    create: vi.fn(async (data: any) => {
      if (docs.has(path)) { const e: any = new Error("ALREADY_EXISTS"); e.code = 6; throw e; }
      docs.set(path, data);
    }),
    get: vi.fn(async () => ({ exists: docs.has(path), data: () => docs.get(path) })),
    set: vi.fn(async (data: any, opts?: any) => {
      const prev = docs.get(path) ?? {};
      docs.set(path, opts?.merge ? { ...prev, ...data } : data);
    }),
    update: vi.fn(async (data: any) => { docs.set(path, { ...(docs.get(path) ?? {}), ...data }); }),
    collection: (sub: string) => makeCollRef(`${path}/${sub}`),
  });
  const makeCollRef = (path: string): any => ({
    doc: (id: string) => makeDocRef(`${path}/${id}`),
    where() { return this; },
    limit() { return this; },
    get: vi.fn(async () => ({ empty: true, docs: [] })),
    add: vi.fn(async (data: any) => { adds.push({ path, data }); return { id: "auto" }; }),
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
  const sub = { uid: "cg1", interval: "year", priceId: "price_cg_annual", metadata: {} as Record<string, string> };
  const StripeClass: any = function () {
    return {
      webhooks: { constructEvent: (raw: Buffer) => JSON.parse(raw.toString()) },
      subscriptions: { retrieve: async (id: string) => ({ id, metadata: { firebaseUID: sub.uid, ...sub.metadata }, items: { data: [{ price: { id: sub.priceId, recurring: { interval: sub.interval } } }] } }) },
    };
  };
  return {
    docs, adds, texts, firestoreFn, StripeClass, sub,
    reset: () => { docs.clear(); adds.length = 0; texts.length = 0; sub.uid = "cg1"; sub.interval = "year"; sub.priceId = "price_cg_annual"; sub.metadata = {}; },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestoreFn, auth: () => ({ getUser: async () => ({ email: "cg@x.com" }) }) },
  apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestoreFn, auth: () => ({ getUser: async () => ({ email: "cg@x.com" }) }),
}));
vi.mock("stripe", () => ({ __esModule: true, default: hoisted.StripeClass }));
vi.mock("../agents/caraAgent", () => ({ sendViaInteractionAgent: async (phone: string, msg: any) => { hoisted.texts.push({ phone, content: msg.content, fixedString: msg.fixedString }); return true; } }));
vi.mock("../linq/client", () => ({ sendToPhone: async (phone: string, content: string) => { hoisted.texts.push({ phone, content }); return "sent"; } }));
vi.mock("../config/appUrl", () => ({ appLink: (p: string) => `https://eviacares.com${p}` }));

import { stripeWebhook, isCaregiverMembershipSubscription } from "../stripe";

const PHONE = "+15550001111";
const req = (event: any) => ({ method: "POST", headers: { "stripe-signature": "sig" }, rawBody: Buffer.from(JSON.stringify(event)) } as any);
const makeRes = () => { const res: any = { statusCode: 200 }; res.status = vi.fn(() => res); res.json = vi.fn(() => res); res.send = vi.fn(() => res); return res; };
const renewalInvoice = (id: string, amountPaid: number) => ({
  id: `evt_${id}`, type: "invoice.payment_succeeded",
  data: { object: { id, subscription: "sub_1", billing_reason: "subscription_cycle", amount_paid: amountPaid, currency: "usd", period_start: 1792000000, period_end: 1794700800 } },
});
const lifecycleBells = (uid: string) => [...hoisted.docs.entries()].filter(([p]) => p.startsWith(`users/${uid}/notifications/`)).map(([, d]) => d);
// The family's own renewal sentence (stripe.ts textMember) with membershipDay's "Saturday, November 14, 2026".
const CHARGE_LINE = /^Your Evia membership renewed — \$24\.95 was charged to your card on file\. Next billing date: [A-Z][a-z]+, [A-Z][a-z]+ \d{1,2}, \d{4}\.$/;

beforeEach(() => { hoisted.reset(); vi.clearAllMocks(); });

describe("invoice.payment_succeeded — an annual care provider renewal always tells the care provider what was charged (B8)", () => {
  it("an annual renewal where this year's refresh is not due (a clear younger than ~10 months): one bell (caregiver_membership_renewed → Settings) + one fixed text with the invoice amount, keyed on the invoice", async () => {
    const recent = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
    hoisted.docs.set("caregivers/cg1", { name: "Basra", verified: true, backgroundCheckData: { checkrCandidateId: "cand", status: "clear", checkrClearedAt: recent } });
    hoisted.docs.set("users/cg1", { phone: PHONE });
    hoisted.docs.set(`agent_sessions/${PHONE}`, { userId: "cg1" });

    await (stripeWebhook as any)(req(renewalInvoice("in_y1", 2495)), makeRes());

    expect(hoisted.docs.get("caregivers/cg1").backgroundCheckData.consentRequired).toBeUndefined(); // refresh not asked
    expect(hoisted.texts.map((t) => t.content)).toHaveLength(1);
    expect(hoisted.texts[0].content).toMatch(CHARGE_LINE);
    expect(lifecycleBells("cg1")[0]).toMatchObject({ type: "caregiver_membership_renewed" });
    expect(hoisted.texts[0]).toMatchObject({ phone: PHONE, fixedString: true });
    // Stripe's retry of the same invoice: nothing more (bell keyed on the invoice id).
    await (stripeWebhook as any)(req(renewalInvoice("in_y1", 2495)), makeRes());
    expect(hoisted.texts).toHaveLength(1);
  });

  it("a non-annual care provider subscription cannot exist (yearly only) — the webhook sends no care provider notice and asks no refresh", async () => {
    hoisted.sub.interval = "month";
    hoisted.docs.set("caregivers/cg1", { name: "Basra", verified: true, backgroundCheckStatus: "clear" });
    hoisted.docs.set("users/cg1", { phone: PHONE });
    hoisted.docs.set(`agent_sessions/${PHONE}`, { userId: "cg1" });

    await (stripeWebhook as any)(req(renewalInvoice("in_m1", 2495)), makeRes());

    expect(lifecycleBells("cg1")).toHaveLength(0);
    expect(hoisted.texts).toHaveLength(0);
    expect(hoisted.docs.get("caregivers/cg1").backgroundCheckData?.consentRequired).toBeUndefined();
  });

  it("a FAMILY monthly renewal is untouched: its own bell + no care provider lifecycle notice", async () => {
    hoisted.sub.uid = "fam1"; hoisted.sub.priceId = "price_family_monthly";
    hoisted.docs.set("users/fam1", { phone: "+15559990000", role: "client" });

    await (stripeWebhook as any)(req(renewalInvoice("in_f1", 2995)), makeRes());

    const familyBell = hoisted.adds.find((a) => a.path === "users/fam1/notifications");
    expect(familyBell?.data).toMatchObject({ type: "membership_payment_succeeded", title: "Membership Renewed" });
    expect(lifecycleBells("fam1")).toHaveLength(0);
    expect(hoisted.texts.filter((t) => /caregiver|Settings/i.test(t.content))).toHaveLength(0);
  });
});

describe("isCaregiverMembershipSubscription — the plan family on the subscription (the belt behind the record)", () => {
  it("metadata kind/task from either checkout origin, the flat annual care provider price id, or care provider price metadata", () => {
    const sub = (metadata: Record<string, string>, price: Record<string, unknown>) => ({ metadata, items: { data: [{ price }] } }) as any;
    expect(isCaregiverMembershipSubscription(sub({ kind: "caregiver_membership" }, { id: "price_x" }))).toBe(true);
    expect(isCaregiverMembershipSubscription(sub({ task: "caregiver_membership" }, { id: "price_x" }))).toBe(true);
    expect(isCaregiverMembershipSubscription(sub({ firebaseUID: "u" }, { id: "price_cg_annual" }))).toBe(true);
    expect(isCaregiverMembershipSubscription(sub({ firebaseUID: "u" }, { id: "price_cg_monthly_legacy" }))).toBe(false); // the monthly caregiver plan no longer exists
    expect(isCaregiverMembershipSubscription(sub({ firebaseUID: "u" }, { id: "price_x", metadata: { role: "caregiver" } }))).toBe(true);
    expect(isCaregiverMembershipSubscription(sub({ firebaseUID: "u" }, { id: "price_family_monthly" }))).toBe(false);
    expect(isCaregiverMembershipSubscription({ metadata: {}, items: { data: [] } } as any)).toBe(false);
  });
});
