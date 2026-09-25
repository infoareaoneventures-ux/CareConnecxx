// Consent-first background checks (2026-09-25): the payment webhook never talks
// to Checkr any more — first payment and every annual renewal park the account
// on "authorize your background check"; only the consent form mints the
// invitation. Locks in requestBackgroundCheckConsent and both webhook branches.

import { describe, it, expect, beforeEach, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  process.env.CHECKR_KEY = "test_key";

  const docs = new Map<string, any>();
  const adds: Array<{ path: string; data: any }> = [];
  const texts: Array<{ phone: string; content: string }> = [];

  const makeDocRef = (path: string): any => ({
    id: path.split("/").pop(), path,
    create: vi.fn(async (data: any) => {
      if (docs.has(path)) { const e: any = new Error("ALREADY_EXISTS"); e.code = 6; throw e; }
      docs.set(path, data);
    }),
    get: vi.fn(async () => ({ exists: docs.has(path), data: () => docs.get(path) })),
    set: vi.fn(async (data: any, opts?: any) => {
      const prev = docs.get(path) ?? {};
      const merged = opts?.merge
        ? { ...prev, ...data, ...(data.backgroundCheckData ? { backgroundCheckData: { ...(prev.backgroundCheckData ?? {}), ...data.backgroundCheckData } } : {}) }
        : data;
      docs.set(path, merged);
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
  let subscriptionInterval = "year";
  const StripeClass: any = function () {
    return {
      webhooks: { constructEvent: (raw: Buffer) => JSON.parse(raw.toString()) },
      subscriptions: { retrieve: async (id: string) => ({ id, metadata: { firebaseUID: "cg1" }, items: { data: [{ price: { recurring: { interval: subscriptionInterval } } }] } }) },
    };
  };
  return {
    docs, adds, texts, firestoreFn, StripeClass,
    setInterval: (i: string) => { subscriptionInterval = i; },
    reset: () => { docs.clear(); adds.length = 0; texts.length = 0; subscriptionInterval = "year"; },
  };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestoreFn, auth: () => ({ getUser: async () => ({ email: "cg@x.com" }) }) },
  apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestoreFn, auth: () => ({ getUser: async () => ({ email: "cg@x.com" }) }),
}));
vi.mock("stripe", () => ({ __esModule: true, default: hoisted.StripeClass }));
vi.mock("../agents/caraAgent", () => ({ sendViaInteractionAgent: async (phone: string, msg: any) => { hoisted.texts.push({ phone, content: msg.content }); return true; } }));
vi.mock("../linq/client", () => ({ sendToPhone: async (phone: string, content: string) => { hoisted.texts.push({ phone, content }); return "sent"; } }));

import { requestBackgroundCheckConsent } from "../bgcheckConsentRequest";
import { stripeWebhook } from "../stripe";

beforeEach(() => { hoisted.reset(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("requestBackgroundCheckConsent", () => {
  it("initial: parks the account on awaiting_consent, bells and texts the caregiver, never touches Checkr", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    hoisted.docs.set("caregivers/cg1", { phone: "+15550001111", services: ["Transportation"] });
    hoisted.docs.set("agent_sessions/+15550001111", { userId: "cg1" });

    expect(await requestBackgroundCheckConsent("cg1", "initial")).toBe(true);

    const cg = hoisted.docs.get("caregivers/cg1");
    expect(cg.verificationStatus).toBe("submitted");
    expect(cg.backgroundCheckData).toMatchObject({ consentRequired: true, consentReason: "initial", invitationStatus: "awaiting_consent", status: "pending" });
    expect(cg.verified).toBeUndefined();
    expect(hoisted.adds.find((a) => a.path === "users/cg1/notifications")?.data).toMatchObject({ type: "background_check_consent" });
    expect(hoisted.texts[0].content).toMatch(/authorize your background check/i);
    expect(hoisted.texts[0].content).toMatch(/\/caregiver\/dashboard/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("initial: no-op when a live invitation already exists", async () => {
    hoisted.docs.set("caregivers/cg1", { backgroundCheckData: { checkrCandidateId: "cand", invitationStatus: "sent" } });
    expect(await requestBackgroundCheckConsent("cg1", "initial")).toBe(false);
    expect(hoisted.adds).toHaveLength(0);
  });

  it("renewal: resets the verified state, keeps the candidate, and asks again even after a clear check", async () => {
    hoisted.docs.set("caregivers/cg1", {
      phone: "+15550001111", verified: true, backgroundCheckStatus: "clear", backgroundCheckComplete: true,
      backgroundCheckData: { checkrCandidateId: "cand", invitationStatus: "completed", status: "clear", checkrClearedAt: "2025-09-01" },
    });
    expect(await requestBackgroundCheckConsent("cg1", "renewal")).toBe(true);
    const cg = hoisted.docs.get("caregivers/cg1");
    expect(cg).toMatchObject({ verified: false, backgroundCheckStatus: "pending", backgroundCheckComplete: false, verificationStatus: "submitted" });
    expect(cg.backgroundCheckData).toMatchObject({ checkrCandidateId: "cand", consentRequired: true, consentReason: "renewal", invitationStatus: "awaiting_consent", checkrClearedAt: null });
    expect(hoisted.texts[0].content).toMatch(/renewed/i);
  });

  it("texts a caregiver with no Evia session through a fresh chat", async () => {
    hoisted.docs.set("caregivers/cg1", { phone: "+15550002222" });
    await requestBackgroundCheckConsent("cg1", "initial");
    expect(hoisted.texts).toHaveLength(1);
  });
});

describe("stripe webhook → consent, never a direct Checkr call", () => {
  const req = (event: any) => ({ method: "POST", headers: { "stripe-signature": "sig" }, rawBody: Buffer.from(JSON.stringify(event)) } as any);
  const makeRes = () => { const res: any = { statusCode: 200 }; res.status = vi.fn(() => res); res.json = vi.fn(() => res); res.send = vi.fn(() => res); return res; };

  it("membership checkout for a caregiver marks paid (+ MVR covered when Transportation) and requests initial consent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    hoisted.docs.set("caregivers/cg1", { name: "Basra Yousuf", zipCode: "95134", state: "CA", services: ["Transportation"], phone: "+15550001111" });
    await (stripeWebhook as any)(req({
      id: "evt_m1", type: "checkout.session.completed",
      data: { object: { id: "cs_1", subscription: "sub_1", customer: "cus_1", metadata: { firebaseUID: "cg1" } } },
    }), makeRes());
    const cg = hoisted.docs.get("caregivers/cg1");
    expect(cg).toMatchObject({ membershipPaid: true, mvrPaid: true, verificationStatus: "submitted" });
    expect(cg.backgroundCheckData).toMatchObject({ consentRequired: true, consentReason: "initial", invitationStatus: "awaiting_consent" });
    expect(cg.backgroundCheckData.checkrCandidateId).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hoisted.texts.some((t) => /authorize your background check/i.test(t.content))).toBe(true);
  });

  it("annual renewal invoice requests renewal consent instead of re-inviting on Checkr", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    hoisted.docs.set("caregivers/cg1", { phone: "+15550001111", verified: true, backgroundCheckData: { checkrCandidateId: "cand", status: "clear" } });
    await (stripeWebhook as any)(req({
      id: "evt_r1", type: "invoice.payment_succeeded",
      data: { object: { id: "in_1", subscription: "sub_1", billing_reason: "subscription_cycle", amount_paid: 6999, currency: "usd", period_start: 1, period_end: 2 } },
    }), makeRes());
    const cg = hoisted.docs.get("caregivers/cg1");
    expect(cg.verified).toBe(false);
    expect(cg.backgroundCheckData).toMatchObject({ checkrCandidateId: "cand", consentRequired: true, consentReason: "renewal" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a monthly renewal never triggers the yearly refresh", async () => {
    hoisted.setInterval("month");
    hoisted.docs.set("caregivers/cg1", { phone: "+15550001111", verified: true });
    await (stripeWebhook as any)(req({
      id: "evt_r2", type: "invoice.payment_succeeded",
      data: { object: { id: "in_2", subscription: "sub_1", billing_reason: "subscription_cycle", amount_paid: 2495, currency: "usd", period_start: 1, period_end: 2 } },
    }), makeRes());
    const cg = hoisted.docs.get("caregivers/cg1");
    expect(cg.verified).toBe(true);
    expect(cg.backgroundCheckData?.consentRequired).toBeUndefined();
  });
});
