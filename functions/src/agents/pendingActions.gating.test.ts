import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin", () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: vi.fn() }) },
  firestore: Object.assign(() => ({ collection: vi.fn() }), { FieldValue: { delete: () => ({}) } }),
}));

import { isHighRisk, buildActionPreview } from "./pendingActions";

describe("U9 financial-flow gating", () => {
  it("gates review_shift_hours on approve/accept_counter (both release payment); propose_correction/escalate are reversible", () => {
    expect(isHighRisk("review_shift_hours", { action: "approve", hours: 6 })).toBe(true);
    expect(isHighRisk("review_shift_hours", { action: "accept_counter" })).toBe(true);
    expect(isHighRisk("review_shift_hours", { action: "propose_correction" })).toBe(false);
    expect(isHighRisk("review_shift_hours", { action: "escalate" })).toBe(false);
  });

  it("builds an approval-quality timesheet preview (decision + hours + caregiver)", async () => {
    const p = await buildActionPreview("review_shift_hours", { action: "approve", hours: 6, amount: 132, caregiverName: "Jane" });
    expect(p).toContain("approve");
    expect(p).toContain("6h");
    expect(p).toContain("Jane");
    expect(p).not.toContain("irreversible");
  });
});
