// The caregiver lifecycle notices — bell vs text (2026-10-03): the bell lives on the
// site and links to the Membership tab; the text is Evia's channel and finishes by
// text: the consent page link itself (paid / renewed), or the keyword that does the
// page's button (MANAGE MEMBERSHIP = Stripe portal, ACTIVATE = the checkout).
import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin", () => {
  const firestore = Object.assign(() => ({ collection: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }) }), { FieldValue: {} });
  return { __esModule: true, default: { firestore }, firestore };
});
vi.mock("../userNotification", () => ({ writeUserNotification: vi.fn(async () => true) }));
vi.mock("../../config/appUrl", () => ({ appLink: (p: string) => `https://eviacares.com${p}` }));
vi.mock("../../utils/caregiverPhone", () => ({ resolveCaregiverPhone: vi.fn(async () => undefined) }));

import { caregiverAccountEventCopy , lifecycleTextOwnedByGate } from "../caregiverAccountEvents";

const TAB = "https://eviacares.com/caregiver/settings";

describe("caregiverAccountEventCopy — membership notices", () => {
  it("paid / renewed: the bell links to the dashboard, the text carries the consent page itself", () => {
    const paid = caregiverAccountEventCopy("membership_paid", { consentUrl: "https://eviacares.com/bgcheck?t=tok" });
    expect(paid.body).toContain("https://eviacares.com/caregiver/dashboard");
    expect(paid.text).toBe("Your membership is active. Next: authorize your background check — it takes about 2 minutes: https://eviacares.com/bgcheck?t=tok");
    const renewed = caregiverAccountEventCopy("membership_renewed", { amount: "69.99", consentUrl: "https://eviacares.com/bgcheck?t=tok" });
    expect(renewed.text).toBe("Your annual membership renewed — $69.99 was charged. Authorize this year's background check refresh to stay bookable — it takes about 2 minutes: https://eviacares.com/bgcheck?t=tok");
    // No link available → the text falls back to the dashboard rather than nothing.
    expect(caregiverAccountEventCopy("membership_paid").text).toContain("/caregiver/dashboard");
  });

  it("payment failed (3 attempts): the bell links to the Membership tab, the text says MANAGE MEMBERSHIP", () => {
    const first = caregiverAccountEventCopy("membership_payment_failed", { attempt: 1, nextRetry: "Oct 5" });
    expect(first.body).toContain(TAB);
    expect(first.text).toBe("Heads up — we couldn't process your Evia membership payment. No action needed if your card just needs a moment; to update your card, reply MANAGE MEMBERSHIP for your Stripe billing link. We'll retry on Oct 5.");
    const again = caregiverAccountEventCopy("membership_payment_failed", { attempt: 2, nextRetry: "Oct 9" });
    expect(again.text).toContain("reply MANAGE MEMBERSHIP for your Stripe billing link. Next retry: Oct 9.");
    const final = caregiverAccountEventCopy("membership_payment_failed", { attempt: 4, finalAttempt: true });
    expect(final.text).toContain("at risk of being canceled");
    expect(final.text).toContain("reply MANAGE MEMBERSHIP");
    expect(final.text).not.toContain("eviacares.com");
  });

  it("ending / cancelled / revoked: the text offers the keyword, never the redirecting Membership URL", () => {
    expect(caregiverAccountEventCopy("membership_cancel_scheduled", { date: "Monday, March 3" }).text)
      .toBe("Your Evia membership is set to end on Monday, March 3. You keep everything until then, and you can reactivate anytime — reply MANAGE MEMBERSHIP for your Stripe billing link.");
    expect(caregiverAccountEventCopy("membership_cancelled").text).toBe("Your Evia membership has been cancelled. You can reactivate anytime — reply ACTIVATE for your membership link.");
    expect(caregiverAccountEventCopy("membership_revoked").text).toBe("Your membership is no longer active. Activate your membership to apply to jobs and get booked — reply ACTIVATE for your membership link.");
    for (const k of ["membership_cancel_scheduled", "membership_cancelled", "membership_revoked"] as const) {
      expect(caregiverAccountEventCopy(k).body).toContain(TAB);
      expect(caregiverAccountEventCopy(k).body).not.toContain("/caregiver/membership");
    }
  });

  it("reactivated has one wording for bell and text", () => {
    const r = caregiverAccountEventCopy("membership_reactivated", { date: "Monday, March 3" });
    expect(r.body).toBe("Your Evia membership is active again. Next billing date: Monday, March 3.");
    expect(r.text).toBeUndefined();
  });

  it("background / documents / payouts notices: the bell links to the page, the text finishes by text", () => {
    const url = "https://eviacares.com/bgcheck?t=tok";
    expect(caregiverAccountEventCopy("bgcheck_link_expired", { consentUrl: url }).text).toBe(`Your background check link expired. Authorize again and a fresh one comes right back — it takes about 2 minutes: ${url}`);
    expect(caregiverAccountEventCopy("bgcheck_revoked", { consentUrl: url }).text).toBe(`Your background check approval was removed. Authorize a new check to get booked again — it takes about 2 minutes: ${url}`);
    expect(caregiverAccountEventCopy("transport_doc_rejected", { docLabel: "Vehicle Insurance", docNotes: "blurry" }).text).toBe("Your Vehicle Insurance was rejected: blurry. Please re-upload to continue — reply DOCUMENTS for your upload link.");
    expect(caregiverAccountEventCopy("transport_doc_expiring", { docs: ["Driver's License"] }).text).toBe("Driver's License will expire within 30 days. Upload a renewal to keep your transportation badge active — reply DOCUMENTS for your upload link.");
    expect(caregiverAccountEventCopy("transport_badge_lost", { reason: "expired" }).text).toContain("reply DOCUMENTS");
    expect(caregiverAccountEventCopy("transport_badge_lost", { reason: "mvr" }).text).toBe("Your transportation badge was removed. Reply SETTINGS to see your transport documents and driving record, or DOCUMENTS for the upload link.");
    expect(caregiverAccountEventCopy("payouts_enabled").text).toBe("Your payout account is set up — earnings land in your bank automatically after each paid visit. Reply PAYOUTS anytime to see your balance.");
    expect(caregiverAccountEventCopy("payouts_disabled").text).toBe("Your payout account needs attention — reply SETUP for your Stripe link to finish.");
    for (const k of ["bgcheck_link_expired", "bgcheck_revoked", "transport_doc_rejected", "transport_doc_expiring", "payouts_enabled", "payouts_disabled"] as const) {
      expect(caregiverAccountEventCopy(k, { consentUrl: url }).body).toContain("eviacares.com");
      expect(caregiverAccountEventCopy(k, { consentUrl: url }).text).not.toContain("dashboard");
    }
  });
});

describe("lifecycleTextOwnedByGate — one text per gate (2026-10-04)", () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  it("membership_paid stands down only after an Evia-checkout payment (fresh membershipRecordedAt)", () => {
    expect(lifecycleTextOwnedByGate("membership_paid", { membershipRecordedAt: "2026-10-04T11:58:00Z" }, now)).toBe(true);
    expect(lifecycleTextOwnedByGate("membership_paid", { membershipRecordedAt: "2026-10-04T10:00:00Z" }, now)).toBe(false); // an old stamp = a later site payment
    expect(lifecycleTextOwnedByGate("membership_paid", { onboardingStep: "caregiver_awaiting_membership" }, now)).toBe(false); // paid on the site: the text is the notice
    expect(lifecycleTextOwnedByGate("membership_paid", undefined, now)).toBe(false);
  });
  it("bgcheck_clear stands down while the session waits at a check or payout step", () => {
    for (const step of ["caregiver_awaiting_bgcheck", "caregiver_send_stripe_connect", "caregiver_awaiting_stripe"]) {
      expect(lifecycleTextOwnedByGate("bgcheck_clear", { onboardingStep: step }, now)).toBe(true);
    }
    expect(lifecycleTextOwnedByGate("bgcheck_clear", { onboardingStep: "complete" }, now)).toBe(false);
  });
  it("every other kind still texts", () => {
    expect(lifecycleTextOwnedByGate("membership_renewed", { membershipRecordedAt: "2026-10-04T11:59:00Z", onboardingStep: "caregiver_awaiting_bgcheck" }, now)).toBe(false);
    expect(lifecycleTextOwnedByGate("payouts_ready" as never, { onboardingStep: "caregiver_awaiting_stripe" }, now)).toBe(false);
  });
});
