import { describe, it, expect, vi, beforeEach } from "vitest";

// The caregiver Payments page's Membership tab, texted (caregiverMembership.ts):
// the page's reads (membershipStatus off the merged profile, the subscription
// record, the driver fields), its cards word for word, and the keywords.

const hoisted = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  subs: [] as any[],
  sent: [] as string[],
  badgeLive: false,
  linkResult: { success: true, linkType: "caregiver_membership", sent: true } as any,
  portalCreate: vi.fn(async (p: any) => ({ url: `https://billing.stripe.com/p/session/${p.customer}` })),
}));
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: vi.fn(async () => ({ exists: hoisted.docs.has(`${name}/${id}`), id, data: () => hoisted.docs.get(`${name}/${id}`) })),
        collection: (sub: string) => {
          const q = (live: boolean): any => ({
            where: () => q(true),
            limit: () => q(live),
            get: vi.fn(async () => {
              const rows = live ? hoisted.subs.filter((s) => s.status === "active" || s.status === "trialing") : hoisted.subs;
              expect(sub).toBe("subscriptions");
              return { empty: rows.length === 0, docs: rows.map((d) => ({ data: () => d })) };
            }),
          });
          return q(false);
        },
      }),
    }),
  }), { FieldValue: { serverTimestamp: () => "__ts__" } });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("../../linq/client", () => ({ sendMessage: vi.fn(async (_c: string, m: string) => { hoisted.sent.push(m); return { message_id: "m" }; }) }));
vi.mock("../caregiverMatchScoring", () => ({ hasValidTransportDocs: () => hoisted.badgeLive }));
vi.mock("../../stripe", () => ({ getStripeClient: () => ({ billingPortal: { sessions: { create: (...a: any[]) => (hoisted.portalCreate as any)(...a) } } }) }));
vi.mock("../../config/appUrl", () => ({ appLink: (p: string) => `https://eviacares.com${p}` }));
vi.mock("../actions/sendOnboardingLinkAction", () => ({ runSendOnboardingLinkAction: vi.fn(async () => hoisted.linkResult) }));

import { loadMembershipTab, membershipTabText, handleMembershipKeyword, driverCardFor, DRIVER_CARD_TEXT, WHATS_INCLUDED } from "../caregiverMembership";

const END = new Date("2027-03-03T08:00:00.000Z"); // March 3, 2027 Pacific

beforeEach(() => {
  hoisted.docs.clear(); hoisted.subs.length = 0; hoisted.sent.length = 0; hoisted.badgeLive = false;
  hoisted.linkResult = { success: true, linkType: "caregiver_membership", sent: true }; hoisted.portalCreate.mockClear();
  hoisted.docs.set("caregivers/cg1", { name: "Mahad", membershipStatus: "active", services: ["Companionship"] });
  hoisted.docs.set("users/cg1", { membershipStatus: "canceled" }); // the caregiver doc wins, like dbService.getUser
  hoisted.subs.push({ status: "active", current_period_end: END, cancel_at_period_end: false });
});

describe("loadMembershipTab — the page's reads", () => {
  it("status from the caregiver doc first (users doc fallback), the LIVE subscription record first", async () => {
    hoisted.subs.unshift({ status: "canceled", current_period_end: new Date("2026-01-01T08:00:00Z"), cancel_at_period_end: false });
    const tab = await loadMembershipTab("cg1");
    expect(tab.status).toBe("active");
    expect(tab.isActive).toBe(true);
    expect(tab.periodEnd?.toISOString()).toBe(END.toISOString());
    hoisted.docs.set("caregivers/cg1", { name: "Mahad" });
    expect((await loadMembershipTab("cg1")).status).toBe("canceled");
  });
});

describe("membershipTabText — the cards word for word", () => {
  it("active: badge · Evia Membership — Annual plan, Renews <long date>, What's included, Manage via Stripe, driver card", async () => {
    const t = membershipTabText(await loadMembershipTab("cg1"));
    expect(t).toBe([
      "Payments · Membership", "",
      "Active · Evia Membership — Annual plan",
      "Renews March 3, 2027", "",
      "What's included:", ...WHATS_INCLUDED.map((l) => `✓ ${l}`), "",
      "Manage membership — update payment method, cancel, or view invoices via Stripe: reply MANAGE MEMBERSHIP for your link.", "",
      DRIVER_CARD_TEXT.offer,
    ].join("\n"));
  });
  it("cancel scheduled → ⚠ Cancels on <date>; trialing → Trial", async () => {
    hoisted.subs[0].cancel_at_period_end = true;
    expect(membershipTabText(await loadMembershipTab("cg1"))).toContain("⚠ Cancels on March 3, 2027");
    hoisted.docs.set("caregivers/cg1", { membershipStatus: "trialing" });
    expect(membershipTabText(await loadMembershipTab("cg1"))).toContain("Trial · Evia Membership — Annual plan");
  });
  it("not active: No active membership + the page's sentence (canceled vs activate) + ACTIVATE", async () => {
    hoisted.docs.set("caregivers/cg1", { membershipStatus: "canceled" });
    let t = membershipTabText(await loadMembershipTab("cg1"));
    expect(t).toContain("No active membership\nYour membership was canceled. Renew to access jobs and platform features.\nReply ACTIVATE for your membership link ($69.99/year).");
    expect(t).not.toContain("What's included");
    hoisted.docs.set("caregivers/cg1", {}); hoisted.docs.set("users/cg1", {});
    t = membershipTabText(await loadMembershipTab("cg1"));
    expect(t).toContain("No active membership\nActivate your membership to start accepting bookings and applying for jobs.");
  });
});

describe("driverCardFor — the ApprovedDriverCard's branches", () => {
  it("approved only when the badge is live; cleared-but-docs-pending; pending; included; offer", () => {
    expect(driverCardFor({ isApprovedDriver: true }, true)).toBe("approved");
    expect(driverCardFor({ isApprovedDriver: true }, false)).toBe("cleared_docs_pending");
    expect(driverCardFor({ mvrStatus: "pending" }, false)).toBe("pending");
    expect(driverCardFor({ mvrPaid: true }, false)).toBe("pending");
    expect(driverCardFor({ services: ["Transportation"] }, false)).toBe("included");
    expect(driverCardFor({ skills: ["Transportation"] }, false)).toBe("included");
    expect(driverCardFor({ services: ["Companionship"] }, false)).toBe("offer");
  });
});

describe("keywords — the page's buttons", () => {
  it("MEMBERSHIP texts the tab; MANAGE MEMBERSHIP = the Billing Portal (customers/{uid}) back to the Payments page; no customer → the page's toast + ACTIVATE", async () => {
    expect(await handleMembershipKeyword("+1555", "chat", "cg1", "membership")).toBe("handled");
    expect(hoisted.sent[0]).toContain("Active · Evia Membership — Annual plan");
    hoisted.docs.set("customers/cg1", { stripeCustomerId: "cus_1" });
    expect(await handleMembershipKeyword("+1555", "chat", "cg1", "MANAGE MEMBERSHIP")).toBe("handled");
    expect(hoisted.portalCreate).toHaveBeenCalledWith({ customer: "cus_1", return_url: "https://eviacares.com/caregiver/payments" });
    expect(hoisted.sent[1]).toContain("https://billing.stripe.com/p/session/cus_1");
    hoisted.docs.delete("customers/cg1");
    await handleMembershipKeyword("+1555", "chat", "cg1", "billing");
    expect(hoisted.sent[2]).toBe("No billing account found. Please purchase a membership first — reply ACTIVATE for your membership link.");
  });
  it("ACTIVATE sends the checkout link only when not active; active → points to MANAGE MEMBERSHIP; unknown words pass through", async () => {
    expect(await handleMembershipKeyword("+1555", "chat", "cg1", "ACTIVATE")).toBe("handled");
    expect(hoisted.sent[0]).toContain("already active");
    hoisted.docs.set("caregivers/cg1", { membershipStatus: "canceled" });
    const { runSendOnboardingLinkAction } = await import("../actions/sendOnboardingLinkAction");
    expect(await handleMembershipKeyword("+1555", "chat", "cg1", "activate membership")).toBe("handled");
    expect(runSendOnboardingLinkAction).toHaveBeenCalledWith({ phone: "+1555", linkType: "caregiver_membership" }, { caller: "sms_agent", role: "caregiver", phone: "+1555" });
    expect(await handleMembershipKeyword("+1555", "chat", "cg1", "how do I get paid")).toBe("passthrough");
  });
});
