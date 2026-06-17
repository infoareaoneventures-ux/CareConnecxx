import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin", () => ({ __esModule: true, default: { firestore: () => ({ collection: () => ({}) }) }, firestore: () => ({ collection: () => ({}) }) }));

import { isHighRisk, buildActionPreview } from "./pendingActions";

describe("healthcare action gating (H-U1)", () => {
  it("gates the appointment COMMIT (with chosenSlot) but not read-only discovery", () => {
    // Two-pass (H-U3): discovery is read-only/ungated; only the commit carrying
    // the approved slot is gated.
    expect(isHighRisk("perform_web_action", { loginAction: "schedule_appointment" })).toBe(false);
    expect(isHighRisk("perform_web_action", {
      loginAction: "schedule_appointment",
      chosenSlot: { provider: "Dr. Lee", datetime: "2026-06-23T14:30" },
    })).toBe(true);
  });
  it("gates pharmacy refill", () => {
    expect(isHighRisk("perform_web_action", { loginAction: "pharmacy_refill" })).toBe(true);
  });
  it("does NOT gate the read-only insurance check", () => {
    expect(isHighRisk("perform_web_action", { loginAction: "insurance_check" })).toBe(false);
  });
  it("does NOT gate a public web action (no loginAction)", () => {
    expect(isHighRisk("perform_web_action", { actionType: "search" })).toBe(false);
  });
});

describe("healthcare action previews (H-U2)", () => {
  it("renders a specific appointment slot, not the generic fallback", () => {
    const preview = buildActionPreview("perform_web_action", {
      loginAction: "schedule_appointment",
      chosenSlot: { provider: "Dr. Lee", datetime: "2026-06-23T14:30", location: "Northside" },
    });
    expect(preview).toContain("Dr. Lee");
    expect(preview).toContain("Northside");
    expect(preview).not.toContain("(irreversible)");
  });
  it("renders medication + pharmacy for a refill", () => {
    const preview = buildActionPreview("perform_web_action", {
      loginAction: "pharmacy_refill", medicationName: "Lisinopril", pharmacyService: "cvs",
    });
    expect(preview.toLowerCase()).toContain("lisinopril");
    expect(preview.toLowerCase()).toContain("cvs");
  });
  it("degrades gracefully with missing fields (no 'undefined')", () => {
    const preview = buildActionPreview("perform_web_action", { loginAction: "pharmacy_refill" });
    expect(preview).not.toContain("undefined");
  });
});
