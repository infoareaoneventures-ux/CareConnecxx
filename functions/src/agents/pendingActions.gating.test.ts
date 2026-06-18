import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: vi.fn() }) },
  firestore: Object.assign(() => ({ collection: vi.fn() }), { FieldValue: { delete: () => ({}) } }),
}));

import { isHighRisk, buildActionPreview } from "./pendingActions";

describe("U9 financial-flow gating", () => {
  it("always gates create_refund_request (money movement)", () => {
    expect(isHighRisk("create_refund_request", { amount: 240, invoiceId: "inv1" })).toBe(true);
  });

  it("gates review_shift_hours only on approve (dispute is reversible)", () => {
    expect(isHighRisk("review_shift_hours", { action: "approve", hours: 6 })).toBe(true);
    expect(isHighRisk("review_shift_hours", { decision: "approve" })).toBe(true);
    expect(isHighRisk("review_shift_hours", { action: "dispute" })).toBe(false);
  });

  it("builds an approval-quality refund preview (amount + target, not generic)", () => {
    const p = buildActionPreview("create_refund_request", { amount: 240, invoiceId: "inv1" });
    expect(p).toContain("$240");
    expect(p).toContain("inv1");
    expect(p).not.toContain("irreversible");
  });

  it("builds an approval-quality timesheet preview (decision + hours + caregiver)", () => {
    const p = buildActionPreview("review_shift_hours", { action: "approve", hours: 6, amount: 132, caregiverName: "Jane" });
    expect(p).toContain("approve");
    expect(p).toContain("6h");
    expect(p).toContain("Jane");
    expect(p).not.toContain("irreversible");
  });
});
