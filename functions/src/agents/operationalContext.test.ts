import { describe, expect, it, vi } from "vitest";

vi.mock("firebase-admin", () => ({
  firestore: () => ({ collection: () => ({}) }),
}));

import { formatCaraOperationalContext } from "./operationalContext";

describe("formatCaraOperationalContext", () => {
  it("returns an empty string when there is no operational state", () => {
    expect(formatCaraOperationalContext({
      pendingActions: [],
      openAlerts: [],
      failedActions: [],
    })).toBe("");
  });

  it("summarizes pending confirmations, open alerts, and failed actions for Cara", () => {
    const formatted = formatCaraOperationalContext({
      pendingActions: [{
        id: "pa1",
        preview: "Book appointment with Dr. Jones on Friday",
        toolName: "perform_web_action",
        expiresAt: "2026-06-18T17:00:00.000Z",
      }],
      openAlerts: [{
        id: "al1",
        type: "cara_pending_action_failed",
        severity: "high",
        message: "Cara could not complete an approved action",
      }],
      failedActions: [{
        id: "led1",
        actionType: "pending_action",
        toolName: "perform_web_action",
        errorReason: "portal timeout",
      }],
    });

    expect(formatted).toContain("CARA OPERATIONS CONTEXT");
    expect(formatted).toContain("Awaiting confirmation: Book appointment with Dr. Jones on Friday");
    expect(formatted).toContain("Open admin alert: [high] cara_pending_action_failed");
    expect(formatted).toContain("Recent failed action: pending_action via perform_web_action");
    expect(formatted).toContain("Never claim a pending, failed, or admin-flagged action succeeded");
  });

  it("summarizes caregiver and client product state for state-aware replies", () => {
    const formatted = formatCaraOperationalContext({
      pendingActions: [],
      openAlerts: [],
      failedActions: [],
      caregiverState: {
        onboardingStatus: "profile_complete",
        verificationStatus: "approved",
        backgroundCheckStatus: "clear",
        accountStatus: "active",
        nextAppointment: "appt-1 approved 2026-06-20 09:00",
        pendingShiftHours: "appt-1: pending_client_review $120",
        lastPayoutStatus: "paid $96",
      },
      clientState: {
        nextAppointment: "appt-2 confirmed 2026-06-21 10:00",
        latestCareUpdate: "Mom ate lunch and took a short walk.",
        familyGroupStatus: "family group active with 3 phone(s)",
        pendingInvoiceOrPayment: "inv-1 sent",
      },
    });

    expect(formatted).toContain("Caregiver state: onboarding=profile_complete, verification=approved, checkr=clear, status=active");
    expect(formatted).toContain("Caregiver shift payment context: appt-1: pending_client_review $120");
    expect(formatted).toContain("Client next visit: appt-2 confirmed");
    expect(formatted).toContain("Latest care update: Mom ate lunch");
    expect(formatted).toContain("Family group: family group active");
    expect(formatted).toContain("Pending invoice/payment: inv-1 sent");
  });
});
