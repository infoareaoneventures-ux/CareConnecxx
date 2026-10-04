import { describe, it, expect, vi, beforeEach } from "vitest";

// Account Settings › Membership & verification, texted (caregiverMembership.ts):
// the section's reads (membershipStatus off the merged profile, the subscription
// record, the background-check and driver fields), its three cards word for
// word with their dates, and the keywords = its buttons.

const hoisted = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  subs: [] as any[],
  sent: [] as string[],
  badgeLive: false,
  linkResult: { success: true, linkType: "caregiver_membership", sent: true } as any,
  portalCreate: vi.fn(async (p: any) => ({ url: `https://billing.stripe.com/p/session/${p.customer}` })),
  linkAction: vi.fn(),
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
vi.mock("../actions/sendOnboardingLinkAction", () => ({ runSendOnboardingLinkAction: (...a: any[]) => { hoisted.linkAction(...a); return Promise.resolve(hoisted.linkResult); } }));

import { loadMembershipTab, membershipTabText, handleMembershipKeyword, driverCardFor, bgCardFor, bgCardText, DRIVER_CARD_TEXT, WHATS_INCLUDED } from "../caregiverMembership";

const END = new Date("2027-03-03T08:00:00.000Z"); // March 3, 2027 Pacific

beforeEach(() => {
  hoisted.docs.clear(); hoisted.subs.length = 0; hoisted.sent.length = 0; hoisted.badgeLive = false;
  hoisted.linkResult = { success: true, linkType: "caregiver_membership", sent: true }; hoisted.portalCreate.mockClear(); hoisted.linkAction.mockClear();
  hoisted.docs.set("caregivers/cg1", { name: "Mahad", membershipStatus: "active", services: ["Companionship"], backgroundCheckStatus: "clear", verified: true, backgroundCheckData: { checkrCandidateId: "c1", checkrClearedAt: "2026-09-26T18:00:00.000Z" } });
  hoisted.docs.set("users/cg1", { membershipStatus: "canceled" }); // the caregiver doc wins, like dbService.getUser
  hoisted.subs.push({ status: "active", current_period_end: END, cancel_at_period_end: false });
});

describe("loadMembershipTab — the section's reads", () => {
  it("status from the caregiver doc first (users doc fallback), the LIVE subscription record first, the background + driver states", async () => {
    hoisted.subs.unshift({ status: "canceled", current_period_end: new Date("2026-01-01T08:00:00Z"), cancel_at_period_end: false });
    const tab = await loadMembershipTab("cg1");
    expect(tab.status).toBe("active");
    expect(tab.isActive).toBe(true);
    expect(tab.periodEnd?.toISOString()).toBe(END.toISOString());
    expect(tab.bg).toEqual({ kind: "cleared", clearedOn: "9/26/2026" });
    expect(tab.driver).toBe("offer");
    hoisted.docs.set("caregivers/cg1", { name: "Mahad" });
    expect((await loadMembershipTab("cg1")).status).toBe("canceled");
  });
});

describe("membershipTabText — the three cards word for word", () => {
  it("active: badge · Evia Membership — Annual plan, Renews <long date>, What's included, Manage via Stripe, background cleared + next check, driver card", async () => {
    const t = membershipTabText(await loadMembershipTab("cg1"));
    expect(t).toBe([
      "Settings · Membership & verification", "",
      "Active · Evia Membership — Annual plan",
      "Renews March 3, 2027",
      "What's included:", ...WHATS_INCLUDED.map((l) => `✓ ${l}`),
      "Manage membership — update payment method, cancel, or view invoices via Stripe: reply MANAGE MEMBERSHIP for your link.", "",
      "Background check: Cleared 9/26/2026 · Next check with your renewal on March 3, 2027", "",
      DRIVER_CARD_TEXT.offer,
    ].join("\n"));
  });
  it("cancel scheduled → ⚠ Cancels on <date>; trialing → Trial; the driver card carries the cleared date", async () => {
    hoisted.subs[0].cancel_at_period_end = true;
    expect(membershipTabText(await loadMembershipTab("cg1"))).toContain("⚠ Cancels on March 3, 2027");
    hoisted.docs.set("caregivers/cg1", { membershipStatus: "trialing", isApprovedDriver: true, mvrClearedAt: "2026-09-28T18:00:00.000Z" });
    hoisted.badgeLive = true;
    const t = membershipTabText(await loadMembershipTab("cg1"));
    expect(t).toContain("Trial · Evia Membership — Annual plan");
    expect(t).toContain("Approved Driver ✓ — Cleared 9/28/2026 · Families who need a driver can see your verified-driver badge.");
  });
  it("not active: No active membership + the page's sentence (canceled vs activate) + ACTIVATE; background not started", async () => {
    hoisted.docs.set("caregivers/cg1", { membershipStatus: "canceled" });
    let t = membershipTabText(await loadMembershipTab("cg1"));
    expect(t).toContain("No active membership\nYour membership was canceled. Renew to access jobs and platform features.\nReply ACTIVATE for your membership link ($69.99/year).");
    expect(t).not.toContain("What's included");
    expect(t).toContain("Background check: Starts right after your membership is active — it's included in the annual fee.");
    hoisted.docs.set("caregivers/cg1", {}); hoisted.docs.set("users/cg1", {});
    t = membershipTabText(await loadMembershipTab("cg1"));
    expect(t).toContain("No active membership\nActivate your membership to start accepting bookings and applying for jobs.");
  });
});

describe("bgCardFor / bgCardText — the dashboard card's rules", () => {
  it("consent (first / renewal) → AUTHORIZE; cleared with date; in-progress variants; not approved; not started", () => {
    expect(bgCardFor({ backgroundCheckData: { consentRequired: true, consentReason: "renewal" } })).toEqual({ kind: "consent", renewal: true });
    expect(bgCardFor({ backgroundCheckData: { invitationStatus: "awaiting_consent" } })).toEqual({ kind: "consent", renewal: false });
    expect(bgCardFor({ verificationStatus: "rejected" })).toEqual({ kind: "not_approved" });
    expect(bgCardFor({ backgroundCheckStatus: "clear", backgroundCheckData: { checkrClearedAt: "2026-09-26T18:00:00Z" } })).toEqual({ kind: "cleared", clearedOn: "9/26/2026" });
    expect(bgCardFor({ backgroundCheckData: { checkrCandidateId: "c", status: "consider" } })).toEqual({ kind: "in_progress", detail: "under_review" });
    expect(bgCardFor({ backgroundCheckData: { checkrCandidateId: "c", status: "suspended" } })).toEqual({ kind: "in_progress", detail: "on_hold" });
    expect(bgCardFor({ backgroundCheckData: { checkrCandidateId: "c", status: "pending" } })).toEqual({ kind: "in_progress", detail: "running" });
    expect(bgCardFor({})).toEqual({ kind: "not_started" });
    const base = { status: "active", isActive: true, periodEnd: END, cancelAtPeriodEnd: false, driver: "offer" as const, mvrClearedOn: null };
    expect(bgCardText({ ...base, bg: { kind: "consent", renewal: true } })).toBe("Background check: Renew your background check — Your annual membership renewed. Authorize this year's background check refresh to stay bookable. Reply AUTHORIZE for the link.");
    expect(bgCardText({ ...base, bg: { kind: "in_progress", detail: "running" } })).toBe("Background check: In progress — Checkr emailed you a secure link, it usually takes about 5 minutes.");
    expect(bgCardText({ ...base, isActive: false, periodEnd: null, bg: { kind: "cleared", clearedOn: "9/26/2026" } })).toBe("Background check: Cleared 9/26/2026");
  });
});

describe("driverCardFor — the driver card's branches", () => {
  it("approved only when the badge is live; cleared-but-docs-pending; pending; included; offer", () => {
    expect(driverCardFor({ isApprovedDriver: true }, true)).toBe("approved");
    expect(driverCardFor({ isApprovedDriver: true }, false)).toBe("cleared_docs_pending");
    expect(driverCardFor({ mvrStatus: "pending" }, false)).toBe("pending");
    expect(driverCardFor({ mvrPaid: true }, false)).toBe("pending");
    expect(driverCardFor({ services: ["Transportation"] }, false)).toBe("included");
    expect(driverCardFor({ services: ["Companionship"] }, false)).toBe("offer");
  });
});

describe("keywords — the section's buttons", () => {
  it("MEMBERSHIP texts the section; MANAGE MEMBERSHIP = the Billing Portal back to Settings; no customer → the page's toast + ACTIVATE", async () => {
    expect(await handleMembershipKeyword("+1555", "chat", "cg1", "membership")).toBe("handled");
    expect(hoisted.sent[0]).toContain("Settings · Membership & verification");
    hoisted.docs.set("customers/cg1", { stripeCustomerId: "cus_1" });
    expect(await handleMembershipKeyword("+1555", "chat", "cg1", "MANAGE MEMBERSHIP")).toBe("handled");
    expect(hoisted.portalCreate).toHaveBeenCalledWith({ customer: "cus_1", return_url: "https://eviacares.com/caregiver/settings" });
    hoisted.docs.delete("customers/cg1");
    await handleMembershipKeyword("+1555", "chat", "cg1", "billing");
    expect(hoisted.sent.at(-1)).toBe("No billing account found. Please purchase a membership first — reply ACTIVATE for your membership link.");
  });
  it("ACTIVATE sends the checkout link only when not active; AUTHORIZE sends the consent page only when a consent is waiting", async () => {
    expect(await handleMembershipKeyword("+1555", "chat", "cg1", "ACTIVATE")).toBe("handled");
    expect(hoisted.sent.at(-1)).toContain("already active");
    expect(await handleMembershipKeyword("+1555", "chat", "cg1", "authorize")).toBe("handled");
    expect(hoisted.sent.at(-1)).toBe("Nothing to authorize right now — your background check is: Cleared 9/26/2026 · Next check with your renewal on March 3, 2027");
    hoisted.docs.set("caregivers/cg1", { membershipStatus: "active", backgroundCheckData: { consentRequired: true, consentReason: "renewal" } });
    expect(await handleMembershipKeyword("+1555", "chat", "cg1", "AUTHORIZE")).toBe("handled");
    expect(hoisted.linkAction).toHaveBeenLastCalledWith({ phone: "+1555", linkType: "caregiver_background_check" }, { caller: "sms_agent", role: "caregiver", phone: "+1555" });
    hoisted.docs.set("caregivers/cg1", { membershipStatus: "canceled" });
    await handleMembershipKeyword("+1555", "chat", "cg1", "activate membership");
    expect(hoisted.linkAction).toHaveBeenLastCalledWith({ phone: "+1555", linkType: "caregiver_membership" }, { caller: "sms_agent", role: "caregiver", phone: "+1555" });
    expect(await handleMembershipKeyword("+1555", "chat", "cg1", "how do I get paid")).toBe("passthrough");
  });
});
