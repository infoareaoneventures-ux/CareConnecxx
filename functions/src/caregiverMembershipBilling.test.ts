// caregiverMembershipBilling.ts — the ONE path the site's callables and Evia's
// texts share for the caregiver membership: checkout, the paid-record writes,
// the Billing Portal, and the subscription record the tab reads.
import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const docs = new Map<string, Record<string, unknown>>();
  const subs: Record<string, unknown>[] = [];
  const consent = vi.fn(async () => true);
  const makeDoc = (path: string): any => ({
    get: vi.fn(async () => ({ exists: docs.has(path), data: () => docs.get(path) })),
    set: vi.fn(async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      docs.set(path, { ...(opts?.merge ? docs.get(path) ?? {} : {}), ...data });
    }),
    collection: (sub: string) => {
      const q = (live: boolean): any => ({
        where: () => q(true), limit: () => q(live),
        get: vi.fn(async () => {
          const rows = live ? subs.filter((s) => s.status === "active" || s.status === "trialing") : subs;
          return { empty: rows.length === 0, docs: rows.map((d) => ({ data: () => d })) };
        }),
      });
      if (sub !== "subscriptions") throw new Error("unexpected subcollection " + sub);
      return q(false);
    },
  });
  const firestore = Object.assign(() => ({ collection: (name: string) => ({ doc: (id: string) => makeDoc(`${name}/${id}`) }) }), {
    FieldValue: { serverTimestamp: () => "<ts>" },
  });
  const auth = () => ({ getUser: vi.fn(async (uid: string) => ({ uid, email: docs.get(`auth/${uid}`)?.email })) });
  return { docs, subs, consent, firestore, auth };
});

vi.mock("firebase-admin", () => ({
  __esModule: true, apps: [{}], initializeApp: vi.fn(),
  firestore: hoisted.firestore, auth: hoisted.auth,
  default: { apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestore, auth: hoisted.auth },
}));
vi.mock("./bgcheckConsentRequest", () => ({ requestBackgroundCheckConsent: (...a: unknown[]) => (hoisted.consent as any)(...a) }));

import {
  createCaregiverMembershipCheckout, markCaregiverMembershipPaid, createCaregiverBillingPortalUrl,
  readCaregiverSubscriptionRecord, resolveCaregiverAnnualPriceId, NoBillingAccountError,
} from "./caregiverMembershipBilling";

const stripe = () => ({
  customers: { create: vi.fn(async () => ({ id: "cus_new" })) },
  checkout: { sessions: { create: vi.fn(async () => ({ id: "cs_1", url: "https://checkout.stripe/cs_1" })) } },
  billingPortal: { sessions: { create: vi.fn(async (p: any) => ({ url: `https://billing.stripe/${p.customer}` })) } },
});

beforeEach(() => { hoisted.docs.clear(); hoisted.subs.length = 0; hoisted.consent.mockClear(); delete process.env.STRIPE_CAREGIVER_ANNUAL; delete process.env.STRIPE_CAREGIVER_ANNUAL_PRICE_ID; });

describe("createCaregiverMembershipCheckout — the Activate Membership checkout from either origin", () => {
  it("site origin (uid): reuses customers/{uid}.stripeCustomerId, the server-picked annual price, firebaseUID metadata", async () => {
    process.env.STRIPE_CAREGIVER_ANNUAL = "price_annual";
    hoisted.docs.set("customers/cg1", { stripeCustomerId: "cus_site" });
    const s = stripe();
    const r = await createCaregiverMembershipCheckout(s, { uid: "cg1", successUrl: "https://x/ok", cancelUrl: "https://x/no" });
    expect(r.url).toBe("https://checkout.stripe/cs_1");
    expect(s.customers.create).not.toHaveBeenCalled();
    expect(s.checkout.sessions.create).toHaveBeenCalledWith({
      mode: "subscription",
      line_items: [{ price: "price_annual", quantity: 1 }],
      success_url: "https://x/ok", cancel_url: "https://x/no",
      customer: "cus_site",
      metadata: { firebaseUID: "cg1", task: "caregiver_membership", includeMVR: "false" },
      subscription_data: { metadata: { firebaseUID: "cg1", kind: "caregiver_membership" } },
    });
  });

  it("Evia origin (phone + uid): creates the customer ONCE onto customers/{uid}, carries phone AND firebaseUID so the webhook advances the text conversation and finds the record", async () => {
    hoisted.docs.set("auth/cg2", { email: "jane@x.com" });
    const s = stripe();
    await createCaregiverMembershipCheckout(s, { uid: "cg2", phone: "+1555", successUrl: "https://x/done", cancelUrl: "https://x/start", includeMVR: true });
    expect(s.customers.create).toHaveBeenCalledWith({ email: "jane@x.com", phone: "+1555", metadata: { firebaseUID: "cg2" } });
    expect(hoisted.docs.get("customers/cg2")).toMatchObject({ stripeCustomerId: "cus_new", email: "jane@x.com" });
    const params = (s.checkout.sessions.create as any).mock.calls[0][0];
    expect(params.customer).toBe("cus_new");
    expect(params.metadata).toEqual({ firebaseUID: "cg2", phone: "+1555", task: "caregiver_membership", includeMVR: "true" });
    expect(params.subscription_data.metadata).toEqual({ firebaseUID: "cg2", phone: "+1555", kind: "caregiver_membership" });
    expect(params.line_items[0].price).toBe(resolveCaregiverAnnualPriceId());
  });

  it("Evia origin before the record exists (phone only): no customer, phone metadata only — the webhook's session path", async () => {
    const s = stripe();
    await createCaregiverMembershipCheckout(s, { phone: "+1555", successUrl: "https://x/done", cancelUrl: "https://x/start" });
    expect(s.customers.create).not.toHaveBeenCalled();
    const params = (s.checkout.sessions.create as any).mock.calls[0][0];
    expect(params).not.toHaveProperty("customer");
    expect(params.metadata).toEqual({ phone: "+1555", task: "caregiver_membership", includeMVR: "false" });
  });

  it("price env: STRIPE_CAREGIVER_ANNUAL first, then STRIPE_CAREGIVER_ANNUAL_PRICE_ID, then the committed fallback — never an empty price", () => {
    expect(resolveCaregiverAnnualPriceId()).toMatch(/^price_/);
    process.env.STRIPE_CAREGIVER_ANNUAL_PRICE_ID = "price_b";
    expect(resolveCaregiverAnnualPriceId()).toBe("price_b");
    process.env.STRIPE_CAREGIVER_ANNUAL = "price_a";
    expect(resolveCaregiverAnnualPriceId()).toBe("price_a");
  });
});

describe("markCaregiverMembershipPaid — the same record from both origins", () => {
  it("caregiver doc: paid + verification submitted + mvrPaid when Transportation + subscription id (+ phone); users doc: active + verification; customers mirror; then parks on consent", async () => {
    hoisted.docs.set("caregivers/cg1", { services: ["Transportation"] });
    await markCaregiverMembershipPaid("cg1", { subscriptionId: "sub_1", customerId: "cus_1", phone: "+1555" });
    expect(hoisted.docs.get("caregivers/cg1")).toEqual({
      services: ["Transportation"], uid: "cg1", phone: "+1555", membershipPaid: true, mvrPaid: true,
      verificationStatus: "submitted", membershipSubscriptionId: "sub_1",
    });
    expect(hoisted.docs.get("users/cg1")).toEqual({
      membershipStatus: "active", subscriptionActive: true, verificationStatus: "submitted",
      subscriptionId: "sub_1", stripeCustomerId: "cus_1", updatedAt: "<ts>",
    });
    expect(hoisted.docs.get("customers/cg1")).toEqual({ stripeCustomerId: "cus_1" });
    expect(hoisted.consent).toHaveBeenCalledWith("cg1", "initial");
  });
  it("founder rule: paying the membership is the rerun of the background check — a prior check makes the ask a 'renewal' (renewal AND rejoin after a lapse)", async () => {
    hoisted.docs.set("caregivers/cg4", { backgroundCheckData: { checkrCandidateId: "cand_old", status: "clear" }, backgroundCheckStatus: "clear", verified: true });
    await markCaregiverMembershipPaid("cg4", { subscriptionId: "sub_2" });
    expect(hoisted.consent).toHaveBeenCalledWith("cg4", "renewal");
    hoisted.docs.set("caregivers/cg5", { verified: true }); // legacy record: cleared, no candidate id kept
    await markCaregiverMembershipPaid("cg5");
    expect(hoisted.consent).toHaveBeenLastCalledWith("cg5", "renewal");
  });
  it("no Transportation → no mvrPaid; no ids → nothing invented", async () => {
    hoisted.docs.set("caregivers/cg3", { skills: ["Companionship"] });
    await markCaregiverMembershipPaid("cg3");
    expect(hoisted.docs.get("caregivers/cg3")).toEqual({ skills: ["Companionship"], uid: "cg3", membershipPaid: true, verificationStatus: "submitted" });
    expect(hoisted.docs.get("users/cg3")).not.toHaveProperty("subscriptionId");
    expect(hoisted.docs.get("customers/cg3")).toBeUndefined();
  });
});

describe("createCaregiverBillingPortalUrl — the Manage button", () => {
  it("customers/{uid}.stripeCustomerId → portal session back to the given page; none → NoBillingAccountError with the page's toast text", async () => {
    hoisted.docs.set("customers/cg1", { stripeCustomerId: "cus_1" });
    const s = stripe();
    expect(await createCaregiverBillingPortalUrl(s, "cg1", "https://x/caregiver/payments")).toBe("https://billing.stripe/cus_1");
    expect(s.billingPortal.sessions.create).toHaveBeenCalledWith({ customer: "cus_1", return_url: "https://x/caregiver/payments" });
    await expect(createCaregiverBillingPortalUrl(s, "cg9", "https://x")).rejects.toBeInstanceOf(NoBillingAccountError);
    await expect(createCaregiverBillingPortalUrl(s, "cg9", "https://x")).rejects.toThrow("No billing account found. Please purchase a membership first.");
  });
});

describe("readCaregiverSubscriptionRecord — the tab's record", () => {
  it("live (active/trialing) first, else whatever exists, else null", async () => {
    expect(await readCaregiverSubscriptionRecord("cg1")).toBeNull();
    hoisted.subs.push({ status: "canceled", id: "old" });
    expect((await readCaregiverSubscriptionRecord("cg1"))?.id).toBe("old");
    hoisted.subs.push({ status: "active", id: "new" });
    expect((await readCaregiverSubscriptionRecord("cg1"))?.id).toBe("new");
  });
});
