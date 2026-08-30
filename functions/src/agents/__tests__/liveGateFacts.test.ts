import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentSession } from "../../linq/client";

/**
 * Direct unit coverage for the live-fact builders (spec 2026-07-09-002). Each
 * builder is read-only, Firestore-only, and fail-soft: a thrown read → "". These
 * exercise every state branch plus the fresh-read race (the in-hand session is
 * stale, the fresh agent_sessions doc shows the truth — the case the fix targets).
 */

// ── In-memory Firestore: agent_sessions + caregivers + users ───────────────────
const store = {
  sessions:   new Map<string, any>(),
  caregivers: new Map<string, any>(),
  users:      new Map<string, any>(),
  throwOn:    new Set<string>(),   // collection names whose .get() should throw
};

vi.mock("firebase-admin", () => {
  const mapFor = (name: string) =>
    name === "caregivers" ? store.caregivers : name === "users" ? store.users : store.sessions;
  const collection = (name: string) => ({
    doc: (id: string) => ({
      get: async () => {
        if (store.throwOn.has(name)) throw new Error(`boom:${name}`);
        const m = mapFor(name);
        return { exists: m.has(id), data: () => m.get(id) };
      },
    }),
  });
  const firestore = Object.assign(() => ({ collection }), {
    FieldValue: { increment: (n: number) => ({ __inc: n }), serverTimestamp: () => ({}), delete: () => ({}) },
  });
  const stub = { apps: [], initializeApp: () => ({}), firestore, storage: () => ({}), auth: () => ({}) };
  return { __esModule: true, default: stub, ...stub };
});

import {
  buildLiveBgcheckFact,
  buildLiveMembershipFact,
  buildLivePhotoFact,
  buildLiveDocumentsFact,
  buildLiveBgcheckConsentFact,
  buildLivePayoutSetupFact,
  buildLiveMvrFact,
  buildLiveClientPaymentFact,
  buildLiveClientIdentityFact,
  LIVE_GATE_FACT_BUILDERS,
} from "../liveGateFacts";

const PHONE = "+15551230000";
const sess = (data: Record<string, unknown> = {}): AgentSession =>
  ({ chatId: "c", service: "SMS", optedOut: false, createdAt: "now", ...data } as any);

// Write the fresh agent_sessions doc the builders re-read.
const fresh = (data: Record<string, unknown>) => store.sessions.set(PHONE, sess(data));

beforeEach(() => {
  store.sessions.clear();
  store.caregivers.clear();
  store.users.clear();
  store.throwOn.clear();
});

describe("buildLiveBgcheckFact (moved verbatim)", () => {
  it("reports CLEARED", async () => {
    store.caregivers.set("cg", { backgroundCheckData: { status: "clear" } });
    expect(await buildLiveBgcheckFact(sess({ caregiverId: "cg" }))).toContain("CLEARED");
  });
  it("reports manual review for consider", async () => {
    store.caregivers.set("cg", { backgroundCheckData: { status: "consider" } });
    expect(await buildLiveBgcheckFact(sess({ caregiverId: "cg" }))).toContain("manual review");
  });
  it("reports finished-form when the invitation completed", async () => {
    store.caregivers.set("cg", { backgroundCheckData: { checkrCandidateId: "x", submittedAt: "2026-07-08T00:00:00Z", invitationStatus: "completed" } });
    const f = await buildLiveBgcheckFact(sess({ caregiverId: "cg" }));
    expect(f).toContain("Checkr HAS their finished form");
    expect(f).toContain("submitted 2026-07-08");
  });
  it("reports NOT-received when nothing submitted", async () => {
    store.caregivers.set("cg", { backgroundCheckData: {} });
    expect(await buildLiveBgcheckFact(sess({ caregiverId: "cg" }))).toContain("has NOT received");
  });
  it("returns '' with no caregiverId or no doc", async () => {
    expect(await buildLiveBgcheckFact(sess({}))).toBe("");
    expect(await buildLiveBgcheckFact(sess({ caregiverId: "missing" }))).toBe("");
  });
});

describe("buildLiveMembershipFact", () => {
  it("says WENT THROUGH when the subscription id is present", async () => {
    fresh({ caregiverSubscriptionId: "sub", onboardingStep: "caregiver_awaiting_membership" });
    expect(await buildLiveMembershipFact(PHONE, sess())).toContain("WENT THROUGH");
  });
  it("notes the MVR add-on and next-step advance", async () => {
    fresh({ caregiverSubscriptionId: "sub", mvrPaid: true, onboardingStep: "caregiver_awaiting_bgcheck_consent" });
    const f = await buildLiveMembershipFact(PHONE, sess());
    expect(f).toContain("Approved Driver add-on was paid too");
    expect(f).toContain("next step is already under way");
  });
  it("says link sent-not-paid when only a checkout url exists", async () => {
    fresh({ membershipCheckoutUrl: "https://pay" });
    expect(await buildLiveMembershipFact(PHONE, sess())).toContain("hasn't come through yet");
  });
  it("says link not-sent-yet when neither exists", async () => {
    fresh({});
    expect(await buildLiveMembershipFact(PHONE, sess())).toContain("hasn't been sent yet");
  });
  it("fresh-read race: stale in-hand session, fresh doc shows paid", async () => {
    fresh({ caregiverSubscriptionId: "sub", onboardingStep: "caregiver_awaiting_membership" });
    // in-hand session has NO subscription id — the fresh read must win.
    expect(await buildLiveMembershipFact(PHONE, sess({}))).toContain("WENT THROUGH");
  });
  it("fail-soft to '' when the session read throws", async () => {
    store.throwOn.add("agent_sessions");
    // Fresh read fails soft to the in-hand session, which has the paid flag, so it
    // still resolves — no throw escapes.
    expect(await buildLiveMembershipFact(PHONE, sess({ caregiverSubscriptionId: "sub", onboardingStep: "caregiver_awaiting_membership" }))).toContain("WENT THROUGH");
  });
});

describe("buildLivePhotoFact", () => {
  it("says photo is IN when profilePhoto present", async () => {
    fresh({ onboardingData: { profilePhoto: "https://p" } });
    expect(await buildLivePhotoFact(PHONE, sess())).toContain("photo is IN");
  });
  it("says none received when absent", async () => {
    fresh({ onboardingData: {} });
    expect(await buildLivePhotoFact(PHONE, sess())).toContain("no profile photo received");
  });
});

describe("buildLiveDocumentsFact", () => {
  it("counts one certification", async () => {
    fresh({ onboardingData: { documents: ["a"] } });
    expect(await buildLiveDocumentsFact(PHONE, sess())).toContain("1 certification ");
  });
  it("counts multiple certifications", async () => {
    fresh({ onboardingData: { documents: ["a", "b"] } });
    expect(await buildLiveDocumentsFact(PHONE, sess())).toContain("2 certifications");
  });
  it("says none received when empty", async () => {
    fresh({ onboardingData: { documents: [] } });
    expect(await buildLiveDocumentsFact(PHONE, sess())).toContain("no certifications received");
  });
});

describe("buildLiveBgcheckConsentFact", () => {
  it("says ALREADY authorized when the caregiver doc shows consent", async () => {
    fresh({ caregiverId: "cg" });
    store.caregivers.set("cg", { backgroundCheckData: { consentGiven: true } });
    expect(await buildLiveBgcheckConsentFact(PHONE, sess({}))).toContain("ALREADY reviewed");
  });
  it("says ALREADY authorized when a checkr candidate exists", async () => {
    fresh({ caregiverId: "cg" });
    store.caregivers.set("cg", { backgroundCheckData: { checkrCandidateId: "cand" } });
    expect(await buildLiveBgcheckConsentFact(PHONE, sess({}))).toContain("ALREADY reviewed");
  });
  it("says not-yet-authorized without a caregiver doc", async () => {
    fresh({});
    expect(await buildLiveBgcheckConsentFact(PHONE, sess({}))).toContain("haven't authorized");
  });
});

describe("buildLivePayoutSetupFact", () => {
  it("says payouts are LIVE when onboarding complete", async () => {
    store.caregivers.set("cg", { stripeAccountId: "acct", stripeOnboardingComplete: true });
    expect(await buildLivePayoutSetupFact(PHONE, sess({ caregiverId: "cg" }))).toContain("payouts are LIVE");
  });
  it("says not-started when no stripe account", async () => {
    store.caregivers.set("cg", {});
    expect(await buildLivePayoutSetupFact(PHONE, sess({ caregiverId: "cg" }))).toContain("hasn't been started");
  });
  it("says reviewing when details submitted but not enabled", async () => {
    store.caregivers.set("cg", { stripeAccountId: "acct", detailsSubmitted: true });
    expect(await buildLivePayoutSetupFact(PHONE, sess({ caregiverId: "cg" }))).toContain("finishing its review");
  });
  it("says started-not-finished when account exists but form incomplete", async () => {
    store.caregivers.set("cg", { stripeAccountId: "acct" });
    expect(await buildLivePayoutSetupFact(PHONE, sess({ caregiverId: "cg" }))).toContain("resumes right where they left off");
  });
  it("returns '' with no caregiverId or doc", async () => {
    expect(await buildLivePayoutSetupFact(PHONE, sess({}))).toBe("");
    expect(await buildLivePayoutSetupFact(PHONE, sess({ caregiverId: "missing" }))).toBe("");
  });
});

describe("buildLiveMvrFact", () => {
  it("says under way when mvrPaid", async () => {
    fresh({ mvrPaid: true });
    expect(await buildLiveMvrFact(PHONE, sess())).toContain("under way");
  });
  it("says link-out-not-paid when only a checkout url", async () => {
    fresh({ mvrCheckoutUrl: "https://pay" });
    expect(await buildLiveMvrFact(PHONE, sess())).toContain("hasn't come through yet");
  });
  it("says not-started otherwise", async () => {
    fresh({});
    expect(await buildLiveMvrFact(PHONE, sess())).toContain("hasn't been started");
  });
});

describe("buildLiveClientPaymentFact", () => {
  it("says WENT THROUGH from the session subscription id", async () => {
    fresh({ stripeSubscriptionId: "sub" });
    expect(await buildLiveClientPaymentFact(PHONE, sess())).toContain("WENT THROUGH");
  });
  it("corroborates via users/{uid}.membershipStatus when the session lacks it", async () => {
    fresh({ userId: "u1" });
    store.users.set("u1", { membershipStatus: "active" });
    expect(await buildLiveClientPaymentFact(PHONE, sess())).toContain("WENT THROUGH");
  });
  it("says not-paid when neither shows payment", async () => {
    fresh({ userId: "u1" });
    store.users.set("u1", { membershipStatus: "incomplete" });
    expect(await buildLiveClientPaymentFact(PHONE, sess())).toContain("hasn't come through yet");
  });
  // 2026-08-24 fix: matches the website's own gate exactly (hooks/useAccessGates.tsx) —
  // active OR trialing OR subscriptionActive, not just membershipStatus==="active".
  it("says WENT THROUGH for a trialing subscription (matches the website's own gate)", async () => {
    fresh({ userId: "u1" });
    store.users.set("u1", { membershipStatus: "trialing" });
    expect(await buildLiveClientPaymentFact(PHONE, sess())).toContain("WENT THROUGH");
  });
  it("says WENT THROUGH when subscriptionActive is true even if membershipStatus lags", async () => {
    fresh({ userId: "u1" });
    store.users.set("u1", { subscriptionActive: true, membershipStatus: "incomplete" });
    expect(await buildLiveClientPaymentFact(PHONE, sess())).toContain("WENT THROUGH");
  });
});

describe("buildLiveClientIdentityFact", () => {
  it("says VERIFIED when the flag cleared", async () => {
    fresh({ onboardingData: { needsIdentityVerification: false } });
    expect(await buildLiveClientIdentityFact(PHONE, sess())).toContain("VERIFIED");
  });
  it("says VERIFIED when identityVerifiedAt is present", async () => {
    fresh({ onboardingData: { identityVerifiedAt: "2026-07-09T00:00:00Z" } });
    expect(await buildLiveClientIdentityFact(PHONE, sess())).toContain("VERIFIED");
  });
  it("corroborates via users/{uid}.identityCheckStatus", async () => {
    fresh({ userId: "u1", onboardingData: {} });
    store.users.set("u1", { identityCheckStatus: "verified" });
    expect(await buildLiveClientIdentityFact(PHONE, sess())).toContain("VERIFIED");
  });
  it("says not-yet-cleared otherwise", async () => {
    fresh({ onboardingData: {} });
    expect(await buildLiveClientIdentityFact(PHONE, sess())).toContain("hasn't cleared yet");
  });
});

describe("LIVE_GATE_FACT_BUILDERS map", () => {
  it("registers every gate/awaiting step in the spec", () => {
    const expected = [
      "caregiver_send_membership", "caregiver_awaiting_membership", "caregiver_ask_mvr",
      "caregiver_send_photo", "caregiver_awaiting_photo",
      "caregiver_send_documents", "caregiver_awaiting_documents",
      "caregiver_send_bgcheck", "caregiver_awaiting_bgcheck_consent", "caregiver_awaiting_bgcheck",
      "caregiver_send_stripe_connect", "caregiver_awaiting_stripe",
      "caregiver_send_mvr", "caregiver_awaiting_mvr",
      "client_send_payment", "client_awaiting_payment", "client_awaiting_identity",
    ];
    for (const step of expected) expect(LIVE_GATE_FACT_BUILDERS[step], step).toBeTypeOf("function");
  });

  it("composite at awaiting_bgcheck_consent runs bg-check first, falls back to consent", async () => {
    // bg-check fact wins when a candidate exists (in-hand session has caregiverId).
    store.caregivers.set("cg", { backgroundCheckData: { status: "clear" } });
    fresh({ caregiverId: "cg" });
    expect(await LIVE_GATE_FACT_BUILDERS.caregiver_awaiting_bgcheck_consent(PHONE, sess({ caregiverId: "cg" })))
      .toContain("CLEARED");
    // With no in-hand caregiverId, bg-check returns "" → consent builder (fresh
    // read) reports the authorization.
    store.caregivers.set("cg2", { backgroundCheckData: { consentGiven: true } });
    fresh({ caregiverId: "cg2" });
    expect(await LIVE_GATE_FACT_BUILDERS.caregiver_awaiting_bgcheck_consent(PHONE, sess({})))
      .toContain("ALREADY reviewed");
  });
});
