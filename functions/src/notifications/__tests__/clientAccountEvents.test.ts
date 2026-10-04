import { describe, it, expect } from "vitest";
import { clientAccountTransitions, clientAccountEventCopy, clientLifecycleTextOwnedByGate, clientMembershipActive } from "../clientAccountEvents";

// users/{uid} record change → the account events a FAMILY hears about (dashboard
// tracker terms), each once, with the way to finish by text.

describe("clientAccountTransitions", () => {
  it("identity verified / reset — the admin's Approved and Revoked both tell the family", () => {
    expect(clientAccountTransitions({ identityCheckStatus: "not_started" }, { identityCheckStatus: "verified" })).toEqual(["identity_verified"]);
    expect(clientAccountTransitions({ identityCheckStatus: "verified" }, { identityCheckStatus: "not_started" })).toEqual(["identity_revoked"]);
    expect(clientAccountTransitions({ identityCheckStatus: "verified" }, { identityCheckStatus: "verified" })).toEqual([]);
  });
  it("membership revoked by the admin tells the family; a Stripe lapse is the Stripe handler's to announce", () => {
    expect(clientAccountTransitions({ membershipStatus: "active" }, { membershipStatus: "inactive", subscriptionActive: false })).toEqual(["membership_revoked"]);
    expect(clientAccountTransitions({ membershipStatus: "active" }, { membershipStatus: "canceled", subscriptionActive: false })).toEqual([]);
    expect(clientAccountTransitions({ membershipStatus: "active" }, { membershipStatus: "payment_failed", subscriptionActive: false })).toEqual([]);
  });
  it("the FIRST activation belongs to membershipNotify (marker); a later re-activation is announced here", () => {
    expect(clientAccountTransitions({ membershipStatus: "inactive" }, { membershipStatus: "active" })).toEqual([]);
    expect(clientAccountTransitions(
      { membershipStatus: "inactive", membershipActivatedNotifiedAt: "2026-10-01T00:00:00Z" },
      { membershipStatus: "active", membershipActivatedNotifiedAt: "2026-10-01T00:00:00Z" },
    )).toEqual(["membership_reactivated"]);
  });
  it("never fires for caregivers (their record has its own trigger)", () => {
    expect(clientAccountTransitions({ identityCheckStatus: "not_started" }, { userType: "caregiver", identityCheckStatus: "verified" })).toEqual([]);
  });
  it("membership active = the site's gate rule", () => {
    expect(clientMembershipActive({ subscriptionActive: true })).toBe(true);
    expect(clientMembershipActive({ membershipStatus: "trialing" })).toBe(true);
    expect(clientMembershipActive({ membershipStatus: "inactive" })).toBe(false);
  });
});

describe("copy — bell links to the page, text finishes by text", () => {
  it("identity verified with membership still owed points at the checkout; with membership active it just confirms", () => {
    const owed = clientAccountEventCopy("identity_verified", { needsMembership: true });
    expect(owed.text).toContain("verified");
    expect(owed.text).toContain("the link is right below");
    expect(owed.linkType).toBe("client_payment");
    expect(owed.body).toContain("/client/membership");
    const done = clientAccountEventCopy("identity_verified", { needsMembership: false });
    expect(done.linkType).toBeUndefined();
    expect(done.text).toContain("all set");
  });
  it("identity reset sends the ID check link; membership revoked sends the checkout link", () => {
    expect(clientAccountEventCopy("identity_revoked").linkType).toBe("client_identity");
    expect(clientAccountEventCopy("membership_revoked").linkType).toBe("client_payment");
    expect(clientAccountEventCopy("membership_reactivated").linkType).toBeUndefined();
  });
  it("no text ever says 'open the app' or 'dashboard'", () => {
    for (const k of ["identity_verified", "identity_revoked", "membership_revoked", "membership_reactivated"] as const) {
      expect(clientAccountEventCopy(k, { needsMembership: true }).text).not.toMatch(/open the app|dashboard/i);
    }
  });
});

describe("clientLifecycleTextOwnedByGate — one message per event", () => {
  it("identity verified stands down while Evia's own step says it (verified ✅ + the price)", () => {
    expect(clientLifecycleTextOwnedByGate("identity_verified", "client_awaiting_identity")).toBe(true);
    expect(clientLifecycleTextOwnedByGate("identity_verified", "client_ask_plan")).toBe(true);
    expect(clientLifecycleTextOwnedByGate("identity_verified", "complete")).toBe(false);
    expect(clientLifecycleTextOwnedByGate("identity_revoked", "client_awaiting_identity")).toBe(false);
  });
});
