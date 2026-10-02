import { describe, expect, it, vi } from "vitest";

vi.mock("firebase-admin", () => {
  const stubFs = () => ({ collection: () => ({}) });
  return { __esModule: true, default: { firestore: stubFs }, firestore: stubFs };
});

import { renderCaregiverAccountStatus, describeCaregiverAccountStatus } from "./caregiverBriefing";

const imran = {
  name: "Imran",
  membershipPaid: true,
  backgroundCheckStatus: "clear",
  stripeAccountId: "acct_123",
  payoutsEnabled: true,
  chargesEnabled: true,
  verified: true,
  hourlyRate: 24,
  city: "Santa Clara",
};

describe("caregiverBriefing (2026-07-22 smoke-test incident)", () => {
  it("renders the exact live facts Evia denied: name, paid, CLEARED check, payouts ready", () => {
    const s = renderCaregiverAccountStatus(imran);
    expect(s).toContain("Their name: Imran");
    expect(s).toContain("Caregiver membership: PAID and active");
    expect(s).toContain("Background check: CLEARED");
    expect(s).toContain("never say it is pending or processing");
    expect(s).toContain("Payout account: connected and ready");
    expect(s).toContain("approved and visible to families");
  });

  it("declares the caregiver role and forbids the family-member framing", () => {
    const s = renderCaregiverAccountStatus(imran);
    expect(s).toContain("professional CAREGIVER");
    expect(s).toContain('never describe them as caring for "their loved one"');
  });

  it("declares live facts as the source of truth OVER memory", () => {
    expect(renderCaregiverAccountStatus(imran)).toMatch(/OVERRIDE anything older memory/);
  });

  it("renders honest negatives for an unstarted caregiver", () => {
    const s = renderCaregiverAccountStatus({});
    expect(s).toContain("not paid yet");
    expect(s).toContain("Background check: not started");
    expect(s).toContain("not set up yet");
    expect(s).not.toContain("Their name:");
  });

  it("passes a non-clear status through verbatim, never upgrading it", () => {
    expect(renderCaregiverAccountStatus({ backgroundCheckStatus: "pending" }))
      .toContain("Background check: pending");
  });

  it("fail-soft: no caregiverId → empty string", async () => {
    expect(await describeCaregiverAccountStatus(undefined)).toBe("");
    expect(await describeCaregiverAccountStatus("")).toBe("");
  });

  it("fail-soft: missing doc and thrown reads → empty string", async () => {
    const missing = { collection: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }) } as never;
    expect(await describeCaregiverAccountStatus("cg-1", { db: missing })).toBe("");
    const broken = { collection: () => { throw new Error("down"); } } as never;
    expect(await describeCaregiverAccountStatus("cg-1", { db: broken })).toBe("");
  });

  it("live read renders from the fresh doc", async () => {
    const db = { collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => imran }) }) }) } as never;
    const s = await describeCaregiverAccountStatus("cg-1", { db });
    expect(s).toContain("Background check: CLEARED");
  });
});
