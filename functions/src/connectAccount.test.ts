// connectAccount.ts — the ONE find-or-create path for a caregiver's Stripe
// Connect account, shared by the site's Setup Payouts button and every link Evia
// texts. The record is the only source of the account id (2026-10-03: Evia used
// to look in the SMS draft only, and could mint a second account over a bank the
// caregiver had connected on the site).
import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const docs = new Map<string, Record<string, unknown>>();
  const makeDoc = (path: string): any => ({
    get: vi.fn(async () => ({ exists: docs.has(path), data: () => docs.get(path) })),
    set: vi.fn(async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      docs.set(path, { ...(opts?.merge ? docs.get(path) ?? {} : {}), ...data });
    }),
    collection: (sub: string) => makeColl(`${path}/${sub}`),
  });
  const makeColl = (path: string): any => ({ doc: (id: string) => makeDoc(`${path}/${id}`) });
  const firestore = Object.assign(() => ({ collection: (name: string) => makeColl(name) }), {
    FieldValue: { serverTimestamp: () => "<ts>" },
  });
  return { docs, firestore };
});

vi.mock("firebase-admin", () => ({
  __esModule: true,
  apps: [{}], initializeApp: vi.fn(),
  firestore: hoisted.firestore,
  default: { apps: [{}], initializeApp: vi.fn(), firestore: hoisted.firestore },
}));

import { ensureConnectAccount, persistNewConnectAccount, newConnectAccountFields, syncConnectAccountStatus, isConnectOnboardingIncompleteError, createConnectOnboardingLink } from "./connectAccount";

const stripe = () => ({ accounts: { create: vi.fn(async () => ({ id: "acct_new" })) } });

beforeEach(() => { hoisted.docs.clear(); });

describe("ensureConnectAccount — the record is the only source of the account id", () => {
  it("reuses the account on caregivers/{id}/private/payout (a bank connected on the site) and creates nothing", async () => {
    hoisted.docs.set("caregivers/cg1/private/payout", { stripeAccountId: "acct_site", payoutsEnabled: true, chargesEnabled: true });
    const s = stripe();
    const r = await ensureConnectAccount(s, "cg1", { knownAccountId: "acct_draft_stale" });
    expect(r).toEqual({ accountId: "acct_site", created: false });
    expect(s.accounts.create).not.toHaveBeenCalled();
    // Nothing written: the record already had it, and the stale draft id never wins over the record.
    expect(hoisted.docs.get("caregivers/cg1")).toBeUndefined();
    expect(hoisted.docs.get("caregivers/cg1/private/payout")?.stripeAccountId).toBe("acct_site");
  });

  it("falls back to the parent doc's legacy field, then to the caller's known id (mirrored onto the record WITHOUT resetting flags)", async () => {
    hoisted.docs.set("caregivers/cg2", { stripeAccountId: "acct_parent" });
    const s = stripe();
    expect(await ensureConnectAccount(s, "cg2")).toEqual({ accountId: "acct_parent", created: false });
    expect(s.accounts.create).not.toHaveBeenCalled();

    const r = await ensureConnectAccount(s, "cg3", { knownAccountId: "acct_draft" });
    expect(r).toEqual({ accountId: "acct_draft", created: false });
    expect(s.accounts.create).not.toHaveBeenCalled();
    expect(hoisted.docs.get("caregivers/cg3")).toEqual({ stripeAccountId: "acct_draft" });
    expect(hoisted.docs.get("caregivers/cg3/private/payout")).toEqual({ stripeAccountId: "acct_draft" });
    expect(hoisted.docs.get("stripe_accounts/acct_draft")?.caregiverId).toBe("cg3");
  });

  it("creates a new Express account with the site's parameters and dual-writes the not-yet-onboarded flags + reverse map", async () => {
    const s = stripe();
    const r = await ensureConnectAccount(s, "cg4", { email: "jane@x.com" });
    expect(r).toEqual({ accountId: "acct_new", created: true });
    expect(s.accounts.create).toHaveBeenCalledWith({
      type: "express",
      country: "US",
      email: "jane@x.com",
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      business_type: "individual",
      metadata: { caregiverId: "cg4", platform: "evia" },
    });
    const expected = { ...newConnectAccountFields("acct_new"), stripeAccountCreatedAt: "<ts>" };
    expect(hoisted.docs.get("caregivers/cg4")).toEqual(expected);
    expect(hoisted.docs.get("caregivers/cg4/private/payout")).toEqual(expected);
    expect(hoisted.docs.get("stripe_accounts/acct_new")?.caregiverId).toBe("cg4");
  });

  it("omits email when none is known, and lets the caller wrap the write (Evia's dry-run guard)", async () => {
    const s = stripe();
    const persist = vi.fn(async () => {});
    const r = await ensureConnectAccount(s, "cg5", { persist });
    expect(r.created).toBe(true);
    expect((s.accounts.create as any).mock.calls[0][0]).not.toHaveProperty("email");
    expect(persist).toHaveBeenCalledWith("acct_new", true);
    expect(hoisted.docs.get("caregivers/cg5")).toBeUndefined();
  });

  it("persistNewConnectAccount carries extra parent fields (Evia's phone for webhook matching) onto the parent only", async () => {
    await persistNewConnectAccount("cg6", "acct_x", true, { phone: "+15550001111" });
    expect(hoisted.docs.get("caregivers/cg6")?.phone).toBe("+15550001111");
    expect(hoisted.docs.get("caregivers/cg6/private/payout")).not.toHaveProperty("phone");
  });
});

describe("live status sync + onboarding link — shared by the site callables, the Manage fallback and Evia", () => {
  it("syncConnectAccountStatus writes Stripe's own flags onto the record (parent + private) — an admin-approved 'connected' record becomes honest", async () => {
    hoisted.docs.set("caregivers/cg7", { payoutsEnabled: true, chargesEnabled: true, stripeOnboardingComplete: true });
    const s = { accounts: { retrieve: vi.fn(async () => ({ charges_enabled: false, payouts_enabled: false, details_submitted: false })) } };
    const r = await syncConnectAccountStatus(s, "acct_7", "cg7");
    expect(r).toEqual({ chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false, stripeOnboardingComplete: false });
    expect(hoisted.docs.get("caregivers/cg7")).toMatchObject({ payoutsEnabled: false, chargesEnabled: false, stripeOnboardingComplete: false, detailsSubmitted: false });
    expect(hoisted.docs.get("caregivers/cg7/private/payout")).toMatchObject({ payoutsEnabled: false, chargesEnabled: false });
    const done = { accounts: { retrieve: vi.fn(async () => ({ charges_enabled: true, payouts_enabled: true, details_submitted: true })) } };
    expect((await syncConnectAccountStatus(done, "acct_7", "cg7")).stripeOnboardingComplete).toBe(true);
    expect(hoisted.docs.get("caregivers/cg7")).toHaveProperty("stripeOnboardingCompletedAt");
  });
  it("isConnectOnboardingIncompleteError matches Stripe's refusal only", () => {
    expect(isConnectOnboardingIncompleteError(Object.assign(new Error("Cannot create a login link for an account that has not completed onboarding."), { type: "StripeInvalidRequestError" }))).toBe(true);
    expect(isConnectOnboardingIncompleteError(Object.assign(new Error("Cannot create a login link for an account that has not completed onboarding."), { rawType: "invalid_request_error" }))).toBe(true);
    expect(isConnectOnboardingIncompleteError(Object.assign(new Error("No such account"), { type: "StripeInvalidRequestError" }))).toBe(false);
    expect(isConnectOnboardingIncompleteError(new Error("network"))).toBe(false);
    expect(isConnectOnboardingIncompleteError(null)).toBe(false);
  });
  it("createConnectOnboardingLink mints an account_onboarding link with the given return/refresh URLs", async () => {
    const s = { accountLinks: { create: vi.fn(async () => ({ url: "https://connect.stripe/onb" })) } };
    expect(await createConnectOnboardingLink(s, "acct_1", { returnUrl: "https://x/ok", refreshUrl: "https://x/again" })).toBe("https://connect.stripe/onb");
    expect(s.accountLinks.create).toHaveBeenCalledWith({ account: "acct_1", type: "account_onboarding", return_url: "https://x/ok", refresh_url: "https://x/again" });
  });
});
